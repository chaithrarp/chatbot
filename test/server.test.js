const assert = require('node:assert/strict');
const { afterEach, beforeEach, describe, it } = require('node:test');
const { createServer } = require('node:http');
const { createApp } = require('../server');

describe('API and model response checks', () => {
  let server;
  let baseUrl;
  let chatComplete;
  let calls;
  let responseHandler;

  beforeEach(async () => {
    calls = [];
    responseHandler = async () => ({ choices: [{ message: { content: 'Test model response' } }] });
    chatComplete = (request) => {
      calls.push(request);
      return responseHandler(request);
    };
    server = createServer(createApp({ chatComplete, apiTimeoutMs: 25 }));
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;
  });

  afterEach(async () => {
    await new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  it('reports API health and confirms the Groq model returns non-empty text', async () => {
    const apiHealth = await fetch(`${baseUrl}/api/health`);
    const health = await apiHealth.json();
    assert.equal(apiHealth.status, 200);
    assert.equal(health.status, 'ok');
    assert.ok(Array.isArray(health.models) && health.models.length > 0);
    assert.equal(health.providerConfigured, Boolean(process.env.GROQ_API_KEY));

    const modelHealth = await fetch(`${baseUrl}/api/test-groq`);
    const model = await modelHealth.json();
    assert.equal(modelHealth.status, 200);
    assert.equal(model.status, 'ok');
    assert.equal(model.response, 'Test model response');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].max_completion_tokens, 64);
  });

  it('returns a model reply and preserves conversation history', async () => {
    const firstResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    const first = await firstResponse.json();
    assert.equal(firstResponse.status, 200);
    assert.equal(first.reply, 'Test model response');
    assert.ok(first.sessionId);

    const nextResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Another question', sessionId: first.sessionId }),
    });
    assert.equal(nextResponse.status, 200);
    // messages = [system, user:'Hello', assistant:'...', user:'Another question']
    assert.equal(calls[1].messages.length, 4);
    assert.equal(calls[1].messages[0].role, 'system');
    assert.equal(calls[1].messages[1].role, 'user');
    assert.equal(calls[1].messages[2].role, 'assistant');
    assert.equal(calls[1].messages[3].role, 'user');
    assert.match(calls[1].messages[0].content, /Answer ONLY using the account data listed above/);
    assert.match(calls[1].messages[0].content, /NEVER compare ConnectX with any competitor/);
    assert.match(calls[1].messages[0].content, /NEVER answer questions unrelated to ConnectX Telecom services/);
    assert.match(calls[1].messages[0].content, /only in the first assistant response of a conversation/);
  });

  it('rejects missing or empty messages', async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: '   ' }),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Message cannot be empty.' });
    assert.equal(calls.length, 0);
  });

  it('returns a clear error when the model returns no text', async () => {
    responseHandler = async () => ({ choices: [{ message: { content: '' } }] });
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    assert.equal(response.status, 502);
    assert.match((await response.json()).error, /could not respond/i);
  });

  it('does not retain a failed message in the next model request', async () => {
    responseHandler = async () => {
      throw new Error('provider unavailable');
    };
    const firstResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'First message' }),
    });
    assert.equal(firstResponse.status, 502);

    responseHandler = async () => ({ choices: [{ message: { content: 'Recovered response' } }] });
    const secondResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Retry' }),
    });
    assert.equal(secondResponse.status, 200);
    // the failed request tried every model, so check the LAST call
    const lastCall = calls[calls.length - 1];
    assert.equal(lastCall.messages.length, 2); // [system, user:'Retry']
    assert.equal(lastCall.messages[1].content, 'Retry');
  });

  it('reports upstream timeouts and model health failures', async () => {
    responseHandler = () => new Promise(() => {});
    const chatResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Hello' }),
    });
    assert.equal(chatResponse.status, 504);

    const healthResponse = await fetch(`${baseUrl}/api/test-groq`);
    assert.equal(healthResponse.status, 503);
    assert.equal((await healthResponse.json()).status, 'error');
  });

  it('returns JSON errors for malformed request bodies', async () => {
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"message":',
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: 'Invalid JSON request body.' });
  });

  it('clears conversation history when a session is deleted', async () => {
    const firstResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Before reset', sessionId: 'reset-session' }),
    });
    assert.equal(firstResponse.status, 200);

    const deleteResponse = await fetch(`${baseUrl}/api/chat/reset-session`, { method: 'DELETE' });
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(await deleteResponse.json(), { ok: true });

    const nextResponse = await fetch(`${baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'After reset', sessionId: 'reset-session' }),
    });
    assert.equal(nextResponse.status, 200);
    assert.equal(calls[1].messages.length, 2);
    assert.equal(calls[1].messages[1].content, 'After reset');
  });
});