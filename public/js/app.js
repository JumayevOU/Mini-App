// public/js/app.js
(() => {
  // Elements
  const sidebar = document.getElementById('sidebar');
  const toggleSidebarBtn = document.getElementById('toggle-sidebar');
  const closeSidebarBtn = document.getElementById('close-sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  const newChatBtn = document.getElementById('new-chat-btn');
  const chatTitleEl = document.getElementById('chat-title');
  const chatHistoryList = document.getElementById('chat-history-list');

  const chatForm = document.getElementById('chat-form');
  const userInput = document.getElementById('user-input');
  const uploadBtn = document.getElementById('upload-btn');
  const fileUpload = document.getElementById('file-upload');
  const micBtn = document.getElementById('mic-btn');
  const submitBtn = document.getElementById('submit-btn');

  const welcomeScreen = document.getElementById('welcome-screen');
  const messagesList = document.getElementById('messages-list');

  // State
  let currentSessionId = localStorage.getItem('chat_session_id') || null;
  let assistantElem = null; // holds current streaming assistant node
  let isStreaming = false;
  let currentAbort = null;

  // Helpers: DOM appenders
  function scrollToBottom() {
    messagesList.scrollTop = messagesList.scrollHeight;
  }

  function createMessageNode(role, text) {
    const wrapper = document.createElement('div');
    wrapper.className = role === 'user'
      ? 'flex justify-end'
      : 'flex justify-start';
    const bubble = document.createElement('div');
    bubble.className = (role === 'user')
      ? 'bg-[#0b1220] text-white px-4 py-2 rounded-2xl max-w-[80%] whitespace-pre-wrap'
      : 'bg-[#0f1724] text-white px-4 py-2 rounded-2xl max-w-[80%] whitespace-pre-wrap';
    bubble.textContent = text || '';
    wrapper.appendChild(bubble);
    return { wrapper, bubble };
  }

  function appendUserMessage(text) {
    const { wrapper } = createMessageNode('user', text);
    messagesList.appendChild(wrapper);
    scrollToBottom();
  }

  function startAssistantMessage(initial = '') {
    const { wrapper, bubble } = createMessageNode('assistant', initial);
    wrapper.querySelector('div').classList.add('assistant-message');
    messagesList.appendChild(wrapper);
    assistantElem = bubble;
    scrollToBottom();
  }

  function appendAssistantToken(token) {
    if (!assistantElem) startAssistantMessage();
    assistantElem.textContent += token;
    scrollToBottom();
  }

  function finishAssistantMessage() {
    assistantElem = null;
    scrollToBottom();
  }

  function appendSystemNote(text) {
    const el = document.createElement('div');
    el.className = 'text-center text-xs text-gray-400 mt-2';
    el.textContent = text;
    messagesList.appendChild(el);
    scrollToBottom();
  }

  // UI: sidebar toggles
  function openSidebar() {
    sidebar.classList.remove('-translate-x-full');
    sidebarOverlay.classList.remove('hidden');
  }
  function closeSidebar() {
    sidebar.classList.add('-translate-x-full');
    sidebarOverlay.classList.add('hidden');
  }
  toggleSidebarBtn && toggleSidebarBtn.addEventListener('click', openSidebar);
  closeSidebarBtn && closeSidebarBtn.addEventListener('click', closeSidebar);
  sidebarOverlay && sidebarOverlay.addEventListener('click', closeSidebar);

  // New chat
  newChatBtn && newChatBtn.addEventListener('click', () => {
    // clear UI messages and reset session
    messagesList.innerHTML = '';
    currentSessionId = null;
    localStorage.removeItem('chat_session_id');
    chatTitleEl.textContent = 'Yangi Chat';
    welcomeScreen && (welcomeScreen.style.display = 'flex');
  });

  // File upload controls
  uploadBtn && uploadBtn.addEventListener('click', () => fileUpload.click());
  fileUpload && fileUpload.addEventListener('change', () => {
    // enable submit when file chosen
    submitBtn.disabled = !(userInput.value.trim() || (fileUpload.files && fileUpload.files.length));
    // show short system note with filename
    if (fileUpload.files && fileUpload.files[0]) {
      appendSystemNote('Fayl tanlandi: ' + fileUpload.files[0].name);
    }
  });

  // Enable submit based on input
  function updateSubmitState() {
    submitBtn.disabled = !(userInput.value.trim() || (fileUpload.files && fileUpload.files.length));
  }
  userInput && userInput.addEventListener('input', updateSubmitState);

  // Keyboard: Enter sends (Shift+Enter newline)
  userInput && userInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (!submitBtn.disabled) submitBtn.click();
    }
  });

  // Main send logic with streaming read
  chatForm && chatForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (isStreaming) {
      appendSystemNote('Iltimos, hozirgi javob tugashini kuting yoki sahifani yangilang.');
      return;
    }

    const text = userInput.value.trim();
    const file = (fileUpload.files && fileUpload.files[0]) ? fileUpload.files[0] : null;
    if (!text && !file) return;

    // UI
    welcomeScreen && (welcomeScreen.style.display = 'none');
    appendUserMessage(text || '[Rasm]');

    // Prepare formdata
    const form = new FormData();
    form.append('userId', 'web_user'); // agar real ID bo'lsa almashtiring
    form.append('type', file ? 'image' : 'text');
    form.append('message', text);
    if (currentSessionId) form.append('sessionId', currentSessionId);
    if (file) form.append('file', file, file.name);

    // start streaming
    isStreaming = true;
    startAssistantMessage(''); // create assistant node to stream into
    userInput.value = '';
    updateSubmitState();

    // Use AbortController to allow cancellation in future
    const controller = new AbortController();
    currentAbort = controller;

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        body: form,
        signal: controller.signal
      });

      if (!res.ok) {
        const t = await res.text().catch(()=>null);
        appendSystemNote('Server xatolik: ' + (t || res.statusText || res.status));
        isStreaming = false;
        finishAssistantMessage();
        currentAbort = null;
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on SSE delimiter \n\n
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 2);

          // process each line inside raw
          const lines = raw.split(/\r?\n/);
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const dataStr = line.replace(/^data:\s*/, '').trim();
            if (!dataStr) continue;
            if (dataStr === '[DONE]') {
              // ignore sentinel
              continue;
            }

            // Try parse JSON, but tolerate direct token strings too
            let obj = null;
            try {
              obj = JSON.parse(dataStr);
            } catch (err) {
              // not JSON: append as raw text
              appendAssistantToken(dataStr);
              continue;
            }

            // Normalize many possible shapes:
            // 1) { token: "..." }
            // 2) { type: "token", token: "..." }
            // 3) { done: true, sessionId, newTitle }
            // 4) { type: "done", sessionId, newTitle }
            // 5) { error: "..."} or { type: "error", message: "..." }

            if (typeof obj === 'object') {
              if (obj.token && typeof obj.token === 'string') {
                appendAssistantToken(obj.token);
              } else if (obj.type === 'token' && obj.token) {
                appendAssistantToken(obj.token);
              } else if (obj.done || obj.type === 'done') {
                // finalize: session id & title
                if (obj.sessionId) {
                  currentSessionId = obj.sessionId;
                  localStorage.setItem('chat_session_id', currentSessionId);
                }
                if (obj.newTitle) {
                  chatTitleEl.textContent = obj.newTitle;
                  // add to chat history UI
                  const item = document.createElement('div');
                  item.className = 'px-3 py-2 rounded-md bg-white/3 text-sm truncate cursor-pointer';
                  item.textContent = obj.newTitle;
                  item.addEventListener('click', () => {
                    // future: load that session messages
                    appendSystemNote('Sessiyani yuklash hozircha yoqilgan emas.');
                  });
                  chatHistoryList.prepend(item);
                }
                // server may still send tokens after done; we will continue reading
              } else if (obj.error || obj.type === 'error' || obj.message) {
                const msg = obj.error || obj.message || JSON.stringify(obj);
                appendSystemNote('Xato: ' + msg);
              } else {
                // unknown object shape: stringify to UI for debugging
                // appendSystemNote(JSON.stringify(obj));
              }
            }
          }
        }
      }

      // stream finished
      finishAssistantMessage();
      appendSystemNote('Javob yuborildi ✅');
    } catch (err) {
      if (err.name === 'AbortError') {
        appendSystemNote('Soʻrov bekor qilindi.');
      } else {
        appendSystemNote('Tarmoq yoki server xatosi: ' + (err.message || err));
      }
      finishAssistantMessage();
    } finally {
      isStreaming = false;
      currentAbort = null;
      // reset file input
      if (fileUpload) {
        fileUpload.value = '';
      }
      updateSubmitState();
    }
  });

  // Mic button placeholder (you can implement Web Speech API here)
  micBtn && micBtn.addEventListener('click', () => {
    appendSystemNote('Mikrofon funksiyasi hozircha yoqilgan emas.');
  });

  // Export cancel function for debugging (if you want to cancel streaming)
  window.chatCancel = function () {
    if (currentAbort) {
      currentAbort.abort();
    }
  };

  // Init: enable submit if existing cached input or file
  updateSubmitState();
  appendSystemNote('Chat tayyor — yozing va yuboring ✨');

  // If we already had a session title cached, show it
  if (currentSessionId) {
    chatTitleEl.textContent = 'Sessiya: ' + currentSessionId;
  }
})();