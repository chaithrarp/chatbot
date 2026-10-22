# ConnectX Telecom Chatbot

AI-powered customer support chatbot for ConnectX Telecom, built with Node.js, Express, and the Groq API (`openai/gpt-oss-120b`).

## Features

- 💬 Multi-turn conversational support
- 📱 Responsive chat UI (mobile-friendly)
- 🔐 API key stays server-side — never exposed to the browser
- 🧠 Server-side session history (in-memory)
- 🔄 New Chat button to reset the conversation
- 🩺 API and live model health checks

## Prerequisites

- **Node.js** v18 or later
- A **Groq API key** from [Groq Console](https://console.groq.com/keys)

## Setup

1. **Install dependencies**

   ```bash
   npm install
   ```

2. **Configure your `.env` file**

   ```bash
   # macOS/Linux
   test -f .env || cp .env.example .env

   # Windows PowerShell
   if (-not (Test-Path .env)) { Copy-Item .env.example .env }
   ```

   Set `GROQ_API_KEY` to a key from [Groq Console](https://console.groq.com/keys).
   Keep `.env` private; never commit or share API keys. If you already have a
   `.env`, update it without replacing unrelated local secrets.

3. **Start the server**

   ```bash
   npm start
   ```

4. **Open the chatbot**

   Visit [http://localhost:3000](http://localhost:3000) in your browser.

## Environment variables

| Variable | Required | Description |
| --- | --- | --- |
| `GROQ_API_KEY` | Yes, for live chat | API key from Groq Console. The server can start without it for health checks, but chat and the live test endpoint will fail until it is configured. |
| `GROQ_MODEL` | No | Groq model ID; defaults to `openai/gpt-oss-120b`. |
| `PORT` | No | HTTP port; defaults to `3000`. |

The default model is listed in Groq's [model documentation](https://console.groq.com/docs/model/openai/gpt-oss-120b). Groq's [deprecation documentation](https://console.groq.com/docs/deprecations) lists `llama-3.3-70b-versatile` as deprecated for free and developer tiers.

## API diagnostics and tests

- `GET /api/health` checks that the server is running and reports the selected model and whether its API key is configured.
- `GET /api/test-groq` sends a small prompt to Groq and returns success only when the model returns non-empty text. It returns HTTP 503 for provider errors or empty output, including when `GROQ_API_KEY` is missing.
- Run `npm test` to exercise the API, multi-turn history, scope-control instructions, reset behavior, and model-response handling with a mocked model. These tests do not require an API key or call Groq.
- Run `node --check server.js` and `node --check public/script.js` for syntax checks.
- To make a live Groq request, start the server and open `http://localhost:3000/api/test-groq`. This uses your configured Groq API key.

Start the server with `npm start` and open [http://localhost:3000](http://localhost:3000).

## Project Structure

```
├── server.js          # Express server + Groq API integration
├── test/
│   └── server.test.js  # API and model response tests
├── public/
│   ├── index.html     # Chat UI
│   ├── style.css      # Styles
│   └── script.js      # Frontend logic
├── .env.example       # Environment variable template
├── .gitignore
├── package.json
└── README.md
```

## Demo Account

The chatbot is pre-loaded with one demo customer:

| Field          | Value                    |
|----------------|--------------------------|
| Customer       | Priya Sharma             |
| Plan           | ConnectX Pro — 150 Mbps  |
| Monthly charge | ₹999                     |
| Billing cycle  | 1st of every month       |
| Last bill      | ₹999, paid               |
| Status         | Active                   |
| Outages        | None in your area        |
| Contract end   | March 2026               |

## Notes

- Session history is stored in memory and lost on server restart.
- The chatbot will only answer ConnectX account-related questions using the demo data above.
- It will politely decline competitor comparisons and unrelated queries.
