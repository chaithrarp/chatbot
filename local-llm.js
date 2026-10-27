// local-llm.js — drop-in replacement for the Groq call, talks to Ollama on your own machine
async function ollamaComplete(request, options) {
  const res = await fetch('http://localhost:11434/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      temperature: request.temperature,
      max_tokens: request.max_completion_tokens,
    }),
    signal: options?.signal,
  });
  if (!res.ok) {
    const err = new Error(await res.text());
    err.status = res.status;
    throw err;
  }
  return res.json();
}

module.exports = { ollamaComplete };