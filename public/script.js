// ── DOM elements ────────────────────────────────────────────────────────────
const messagesEl = document.getElementById('messages');
const chatForm = document.getElementById('chat-form');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const newChatBtn = document.getElementById('new-chat-btn');

let sessionId = null;
let chatGeneration = 0;
let currentController = null; // tracks in-flight fetch for abort

// ── Helpers ─────────────────────────────────────────────────────────────────

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(text, sender) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${sender}-message`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.textContent = text;

  wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  scrollToBottom();
}

function showTyping() {
  const wrapper = document.createElement('div');
  wrapper.className = 'message bot-message typing-indicator';
  wrapper.id = 'typing';

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble';
  bubble.innerHTML = '<span class="dot"></span><span class="dot"></span><span class="dot"></span>';

  wrapper.appendChild(bubble);
  messagesEl.appendChild(wrapper);
  scrollToBottom();
}

function removeTyping() {
  const el = document.getElementById('typing');
  if (el) el.remove();
}

function setLoading(loading) {
  sendBtn.disabled = loading;
  userInput.disabled = loading;
  if (loading) {
    showTyping();
  } else {
    removeTyping();
  }
}

// ── Send message ────────────────────────────────────────────────────────────

async function sendMessage(text) {
  addMessage(text, 'user');
  setLoading(true);

  // Abort any previous in-flight request
  if (currentController) currentController.abort();
  const controller = new AbortController();
  currentController = controller;
  const sentForGeneration = chatGeneration;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId }),
      signal: controller.signal,
    });

    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('The server returned an invalid response. Please try again.');
    }

    // Discard if session was reset while waiting
    if (chatGeneration !== sentForGeneration) return;

    if (!res.ok) {
      addMessage(data.error || 'Something went wrong. Please try again.', 'error');
      return;
    }

    if (typeof data.reply !== 'string' || !data.reply.trim() || !data.sessionId) {
      throw new Error('The server response was missing a model reply. Please try again.');
    }

    sessionId = data.sessionId;
    addMessage(data.reply, 'bot');
  } catch (err) {
    if (err.name === 'AbortError') return; // intentionally cancelled
    const message = err instanceof TypeError
      ? 'Network error. Please check your connection and try again.'
      : err.message || 'Something went wrong. Please try again.';
    addMessage(message, 'error');
  } finally {
    // Only clean up if this is still the active request
    if (currentController === controller) {
      currentController = null;
      setLoading(false);
      userInput.focus();
    }
  }
}

// ── New chat ────────────────────────────────────────────────────────────────

async function resetChat() {
  chatGeneration += 1;

  // Abort any in-flight request immediately
  if (currentController) {
    currentController.abort();
    currentController = null;
  }

  const oldSessionId = sessionId;
  sessionId = null;

  // Reset UI immediately — never wait on network
  setLoading(false);
  messagesEl.innerHTML = '';
  addMessage('👋 Hi! I\'m ConnectX Telecom\'s virtual assistant. How can I help you today?', 'bot');
  userInput.focus();

  // Fire-and-forget server cleanup
  if (oldSessionId) {
    fetch(`/api/chat/${oldSessionId}`, { method: 'DELETE' }).catch(() => {});
  }
}

// ── Event listeners ─────────────────────────────────────────────────────────

chatForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const text = userInput.value.trim();
  if (!text) return;
  userInput.value = '';
  sendMessage(text);
});

newChatBtn.addEventListener('click', resetChat);

// Focus input on load
userInput.focus();
