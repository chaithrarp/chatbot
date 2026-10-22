const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const express = require('express');
const crypto = require('crypto');
const Groq = require('groq-sdk');

const PORT = process.env.PORT || 3000;
const DEBUG = String(process.env.DEBUG || '').toLowerCase() === 'true';
const API_TIMEOUT_MS = 15000;
const MAX_HISTORY_SENT = 12;
const MAX_MESSAGE_LEN = 500;
const SESSION_TTL_MS = 30 * 60 * 1000;
const MAX_SESSIONS = 1000;

// Clean the key: removes accidental quotes/spaces/newlines from .env
const apiKey = (process.env.GROQ_API_KEY || '').trim().replace(/^["']|["']$/g, '');
const groq = apiKey ? new Groq({ apiKey, maxRetries: 0 }) : null;

// Tries these in order. If one fails, it falls back to the next.
const MODELS = [...new Set([
  (process.env.GROQ_MODEL || '').trim(),
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-20b',
].filter(Boolean))];

const SYSTEM_INSTRUCTION = `You are ConnectX Telecom's friendly virtual assistant. You help customers with billing, plan details, account status, and outage inquiries.

You have access to EXACTLY the following customer account data — nothing more:

---
Customer: Priya Sharma
Plan: ConnectX Pro — 150 Mbps
Monthly charge: ₹999
Billing cycle: 1st of every month
Last bill: ₹999, paid
Status: Active
Known outages: None in your area
Contract end: March 2026 (this date has already passed, so the contract term has ended; for renewal or new-term options, direct her to support)
---

STRICT RULES — follow these without exception:
1. Answer ONLY using the account data listed above. Do NOT invent, guess, or fabricate any information — including plan names, speeds, prices, upgrade options, or promotions — that is not explicitly provided above.
2. If the customer asks about available plans, upgrades, add-ons, pricing for other plans, or ANY information not in the data above, reply that you do not have that information right now and suggest they contact ConnectX support at 1800-XXX-XXXX or visit connectx.com.
3. NEVER compare ConnectX with any competitor. Politely decline such requests.
4. NEVER answer questions unrelated to ConnectX Telecom services (e.g., general knowledge, coding, weather). Politely decline and say you can only help with ConnectX account queries.
5. Be concise (1-3 short sentences when possible), friendly, and professional. Use ₹ for Indian Rupee amounts. Plain text only, no markdown.
6. If asked who you are, say you are ConnectX Telecom's virtual assistant.
7. Greet Priya by name only in the first assistant response of a conversation. Do not repeat her name in later replies unless needed for clarity.`;

function describeError(err) {
  const status = err?.status ? `[${err.status}] ` : '';
  return `${status}${err?.message || String(err)}`;
}

function createApp({
  chatComplete = (request, options) => {
    if (!groq) throw new Error('GROQ_API_KEY is missing or not loaded from .env');
    return groq.chat.completions.create(request, options);
  },
  models = MODELS,
  apiTimeoutMs = API_TIMEOUT_MS,
} = {}) {
  const app = express();
  const sessions = new Map();

  app.use(express.json({ limit: '10kb' }));

  // Static files: works from ./public or the same folder as server.js
  const publicDir = path.join(__dirname, 'public');
  if (fs.existsSync(path.join(publicDir, 'index.html'))) {
    app.use(express.static(publicDir));
  } else {
    const send = (file) => (_req, res) => res.sendFile(path.join(__dirname, file));
    app.get('/', send('index.html'));
    app.get('/index.html', send('index.html'));
    app.get('/script.js', send('script.js'));
    app.get('/style.css', send('style.css'));
  }

  function cleanupSessions() {
    const now = Date.now();
    for (const [sid, s] of sessions) {
      if (now - s.updatedAt > SESSION_TTL_MS) sessions.delete(sid);
    }
    while (sessions.size > MAX_SESSIONS) {
      sessions.delete(sessions.keys().next().value);
    }
  }
  setInterval(cleanupSessions, 5 * 60 * 1000).unref();

  // One attempt on one model, with a real abort timeout
  async function callOne(model, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), apiTimeoutMs);
    try {
      const request = { model, ...body };
      if (/gpt-oss/i.test(model)) request.reasoning_effort = 'low';
      return await chatComplete(request, { signal: controller.signal });
    } catch (err) {
      if (controller.signal.aborted) throw new Error('API_TIMEOUT');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  // Tries each model until one returns text
  async function callModel(body) {
    const errors = [];
    for (const model of models) {
      try {
        const response = await callOne(model, body);
        const text = (response.choices?.[0]?.message?.content || '').trim();
        if (!text) throw new Error('empty response');
        return { text, model };
      } catch (err) {
        const msg = `${model} -> ${describeError(err)}`;
        console.error('Model attempt failed:', msg);
        errors.push(msg);
        // Bad key: no point trying other models
        if (err?.status === 401) break;
      }
    }
    const e = new Error('ALL_MODELS_FAILED');
    e.details = errors;
    throw e;
  }

  app.get('/api/health', (_req, res) => {
    res.json({
      status: 'ok',
      models,
      providerConfigured: Boolean(apiKey),
      keyPreview: apiKey ? `${apiKey.slice(0, 4)}...${apiKey.slice(-4)}` : null,
    });
  });

  app.get('/api/test-groq', async (_req, res) => {
    try {
      const { text, model } = await callModel({
        messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
        max_completion_tokens: 64,
      });
      res.json({ status: 'ok', model, response: text });
    } catch (err) {
      res.status(503).json({ status: 'error', errors: err.details || [describeError(err)] });
    }
  });

  app.post('/api/chat', async (req, res) => {
    try {
      const { message, sessionId } = req.body || {};

      if (typeof message !== 'string' || !message.trim()) {
        return res.status(400).json({ error: 'Message cannot be empty.' });
      }
      const text = message.trim();
      if (text.length > MAX_MESSAGE_LEN) {
        return res.status(400).json({ error: `Message is too long (max ${MAX_MESSAGE_LEN} characters).` });
      }

      const sid = typeof sessionId === 'string' && sessionId ? sessionId : crypto.randomUUID();
      const session = sessions.get(sid) || { history: [], updatedAt: Date.now() };
      const recentHistory = [...session.history, { role: 'user', content: text }]
        .slice(-MAX_HISTORY_SENT);

      const { text: reply, model } = await callModel({
        messages: [{ role: 'system', content: SYSTEM_INSTRUCTION }, ...recentHistory],
        temperature: 0.3,
        max_completion_tokens: 300,
      });

      session.history.push(
        { role: 'user', content: text },
        { role: 'assistant', content: reply },
      );
      session.updatedAt = Date.now();
      sessions.set(sid, session);

      if (DEBUG) console.log(`Reply from ${model}`);
      return res.json({ reply, sessionId: sid });
    } catch (err) {
      const detail = (err.details || [describeError(err)]).join(' | ');
      console.error('Chat failed:', detail);
      const timeout = /API_TIMEOUT/.test(detail);
      let error = timeout
        ? 'The response took too long. Please try again.'
        : 'Sorry, the model could not respond. Please try again in a moment.';
      if (DEBUG) error += `\n\n[debug] ${detail}`;
      return res.status(timeout ? 504 : 502).json({ error });
    }
  });

  app.delete('/api/chat/:sessionId', (req, res) => {
    sessions.delete(req.params.sessionId);
    res.json({ ok: true });
  });

  app.use((err, _req, res, next) => {
    if (res.headersSent) return next(err);
    console.error('Request parsing error:', err.message || err);
    const status = err.status === 413 ? 413 : 400;
    return res.status(status).json({
      error: status === 413 ? 'Request body is too large.' : 'Invalid JSON request body.',
    });
  });

  return app;
}

function startServer() {
  if (!apiKey) {
    console.error('Warning: GROQ_API_KEY is not set. Put it in a .env file next to server.js.');
  }
  const app = createApp();
  return app.listen(PORT, () => {
    console.log(`ConnectX Chatbot running at http://localhost:${PORT}`);
    console.log(`Models (in order): ${MODELS.join(', ')}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { createApp, startServer };