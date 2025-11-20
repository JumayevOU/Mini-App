// public/app.js — Streaming-moslangan frontend
(() => {
  // DOM elementlari (HTML da bo'lishi kerak)
  const chatEl = document.getElementById('chat');            // chat ishlanadigan kontyener (pre / div)
  const inputEl = document.getElementById('input');          // xabar input (textarea yoki input)
  const sendBtn = document.getElementById('send');           // yuborish tugmasi
  const fileInput = document.getElementById('file');         // file input (type="file")
  const cancelBtn = document.getElementById('cancel');       // bekor qilish tugmasi
  const sessionIdEl = document.getElementById('sessionId');  // optional: sessiya id ko'rsatuvchi

  // State
  let currentAbortController = null;
  let currentSessionId = localStorage.getItem('chat_session_id') || null;
  if (sessionIdEl) sessionIdEl.textContent = currentSessionId || '—';

  // DOM helpers
  function appendSystem(text) {
    const el = document.createElement('div');
    el.className = 'sys';
    el.textContent = text;
    chatEl.appendChild(el);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function appendUser(text) {
    const el = document.createElement('div');
    el.className = 'user';
    el.textContent = text;
    chatEl.appendChild(el);
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function appendTokenChunk(token) {
    // Agar oxirgi element assistant bo'lmasa, yangisini ochamiz
    let last = chatEl.lastElementChild;
    if (!last || !last.classList.contains('assistant')) {
      const el = document.createElement('div');
      el.className = 'assistant';
      el.textContent = token;
      chatEl.appendChild(el);
    } else {
      last.textContent += token;
    }
    chatEl.scrollTop = chatEl.scrollHeight;
  }

  function setStatus(msg, isError = false) {
    // Oddiy status ko'rsatish (console + system)
    console[isError ? 'error' : 'log'](msg);
    // small on-screen message
    // Remove previous small sys if exists
    // (keep UI minimal — developer can expand)
  }

  // Main send + stream function
  async function sendAndStream({ userId = 'anonymous', type = 'text' } = {}) {
    if (currentAbortController) {
      setStatus('Oldingi so‘rov hali tugamadi. Avval bekor qiling yoki kuting.', true);
      return;
    }

    const message = (inputEl && inputEl.value) ? inputEl.value.trim() : '';
    const file = fileInput && fileInput.files && fileInput.files[0] ? fileInput.files[0] : null;
    if (!message && !file) {
      setStatus('Iltimos, xabar yoki rasm yuboring.', true);
      return;
    }

    // UI: append user xabari
    if (message) appendUser(message);
    else appendUser('[Rasm yuborildi]');

    // tayyor FormData (server upload.single('file') kutiladi)
    const form = new FormData();
    form.append('userId', userId);
    form.append('type', file ? 'image' : 'text');
    form.append('message', message);
    // Agar oldingi sessiya bor bo'lsa yuboramiz, aks holda server yangi sessiya yaratadi
    if (currentSessionId) form.append('sessionId', currentSessionId);

    if (file) {
      form.append('file', file, file.name);
    }

    // Prepare abort controller
    const controller = new AbortController();
    currentAbortController = controller;
    cancelBtn && (cancelBtn.disabled = false);

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        body: form,
        signal: controller.signal
      });

      if (!res.ok) {
        const txt = await res.text().catch(()=>null);
        appendSystem('Server javobida xatolik: ' + (txt || res.statusText));
        currentAbortController = null;
        cancelBtn && (cancelBtn.disabled = true);
        return;
      }

      // ReadableStream orqali server yuborayotgan SSE-style ma'lumotni o'qish
      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';

      // stream read loop
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // SSE bloklar: separated by \n\n
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const raw = buffer.slice(0, idx).trim();
          buffer = buffer.slice(idx + 2);

          // Each raw block may have multiple lines; process lines starting with "data:"
          const lines = raw.split(/\r?\n/);
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const dataStr = line.replace(/^data:\s*/, '').trim();
            if (!dataStr) continue;

            // sometimes server sends comments or simple text - attempt JSON.parse
            let obj = null;
            try {
              obj = JSON.parse(dataStr);
            } catch (e) {
              // agar JSON bo'lmasa — skip yoki sistemyaberi
              // appendSystem(dataStr);
              continue;
            }

            // Handle known event types
            if (obj.type === 'token' && obj.token) {
              appendTokenChunk(obj.token);
            } else if (obj.type === 'done') {
              // done -> sessionId va newTitle olinadi
              if (obj.sessionId) {
                currentSessionId = obj.sessionId;
                localStorage.setItem('chat_session_id', currentSessionId);
                if (sessionIdEl) sessionIdEl.textContent = currentSessionId;
              }
              if (obj.newTitle) {
                appendSystem('Sessiya sarlavhasi: ' + obj.newTitle);
              }
              // end reading loop; (server may still send but typically ends)
              // we don't break outermost while; just keep going until stream ends
            } else if (obj.type === 'error') {
              appendSystem('AI/Xato: ' + (obj.message || JSON.stringify(obj)), true);
            } else {
              // other objects: show for debugging
              // appendSystem(JSON.stringify(obj));
            }
          }
        }
      }

      // after stream finished
      appendSystem('Javob toʻliq yuborildi ✅');
    } catch (err) {
      if (err.name === 'AbortError') {
        appendSystem('Soʻrov foydalanuvchi tomonidan bekor qilindi.');
      } else {
        appendSystem('Tarmoq yoki server xatosi: ' + String(err), true);
      }
    } finally {
      currentAbortController = null;
      cancelBtn && (cancelBtn.disabled = true);
      // clear file input and text optionally
      // fileInput && (fileInput.value = '');
      inputEl && (inputEl.value = '');
    }
  }

  // Cancel function
  function cancelCurrent() {
    if (currentAbortController) {
      currentAbortController.abort();
      currentAbortController = null;
      cancelBtn && (cancelBtn.disabled = true);
    } else {
      setStatus('Bekor qilish uchun hozir hech qanday so‘rov yo‘q.');
    }
  }

  // Attach events
  sendBtn && sendBtn.addEventListener('click', (e) => {
    e.preventDefault();
    sendAndStream({ userId: 'user_1' }); // agar kerak bo'lsa serverga haqiqiy userId yubor
  });

  cancelBtn && cancelBtn.addEventListener('click', (e) => {
    e.preventDefault();
    cancelCurrent();
  });

  // Optional: enter to send (Shift+Enter for newline)
  if (inputEl) {
    inputEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendBtn && sendBtn.click();
      }
    });
  }

  // Initialize UI state
  if (cancelBtn) cancelBtn.disabled = true;
  appendSystem('Chat tayyor — yozing va yuboring ✨');

  // Expose some helpers globally (debug/console)
  window.chatClient = {
    sendAndStream,
    cancelCurrent,
    getSessionId: () => currentSessionId
  };
})();