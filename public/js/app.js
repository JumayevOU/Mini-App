const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
tg.setHeaderColor('#050509');
tg.setBackgroundColor('#050509');

// State
let currentSessionId = null;
let currentUserId = tg.initDataUnsafe?.user?.id || 123456789; // Fallback ID for testing
let isTyping = false;

// DOM Elements
const els = {
    chatContainer: document.getElementById('chat-container'),
    messagesList: document.getElementById('messages-list'),
    welcomeScreen: document.getElementById('welcome-screen'),
    userInput: document.getElementById('user-input'),
    chatForm: document.getElementById('chat-form'),
    submitBtn: document.getElementById('submit-btn'),
    chatHistoryList: document.getElementById('chat-history-list'),
    sidebar: document.getElementById('sidebar'),
    sidebarOverlay: document.getElementById('sidebar-overlay'),
    chatTitle: document.getElementById('chat-title'),
    fileInput: document.getElementById('file-upload')
};

// --- UI FUNCTIONS ---

function toggleWelcome(show) {
    if (show) {
        els.welcomeScreen.classList.remove('hidden');
        els.messagesList.innerHTML = '';
        els.chatTitle.textContent = 'ChatGPT AI';
    } else {
        els.welcomeScreen.classList.add('hidden');
    }
}

function scrollToBottom() {
    els.chatContainer.scrollTo({ top: els.chatContainer.scrollHeight, behavior: 'smooth' });
}

function appendMessage(content, role, type = 'text', animate = true) {
    const isUser = role === 'user';
    const div = document.createElement('div');
    div.className = `flex items-start gap-3 ${isUser ? 'flex-row-reverse' : ''} ${animate ? 'animate-slide-in' : ''}`;
    
    const avatar = isUser 
        ? `<div class="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center shrink-0"><i class="fa-solid fa-user text-xs"></i></div>`
        : `<div class="w-8 h-8 rounded-lg bg-gradient-to-br from-[#ff00ff] to-[#00e1ff] flex items-center justify-center shrink-0"><i class="fa-solid fa-robot text-white text-xs"></i></div>`;

    let innerContent = '';
    if (type === 'text') {
        // Oddiy markdown formatlash (bold)
        content = content.replace(/\*\*(.*?)\*\*/g, '<b>$1</b>');
        innerContent = `<p class="leading-relaxed text-sm md:text-base whitespace-pre-wrap">${content}</p>`;
    } else if (type === 'image') {
        innerContent = `<div class="text-xs italic text-gray-400">📷 Rasm yuborildi</div>`;
    }

    div.innerHTML = `
        ${avatar}
        <div class="${isUser ? 'bg-[#2a2a35]' : 'bg-transparent'} p-3 rounded-2xl ${isUser ? 'rounded-tr-sm' : ''} max-w-[85%] border border-white/5">
            ${innerContent}
        </div>
    `;
    els.messagesList.appendChild(div);
    scrollToBottom();
}

function showTyping() {
    const div = document.createElement('div');
    div.id = 'typing-indicator';
    div.className = 'flex items-start gap-3 animate-pulse pl-11';
    div.innerHTML = `<div class="flex gap-1 bg-white/5 p-3 rounded-2xl w-fit"><div class="w-2 h-2 bg-[#d946ef] rounded-full"></div><div class="w-2 h-2 bg-[#00ffff] rounded-full"></div></div>`;
    els.messagesList.appendChild(div);
    scrollToBottom();
}

function hideTyping() {
    const el = document.getElementById('typing-indicator');
    if (el) el.remove();
}

// --- API INTERACTIONS ---

async function loadSessions() {
    try {
        const res = await fetch(`/api/sessions/${currentUserId}`);
        const sessions = await res.json();
        els.chatHistoryList.innerHTML = '';
        
        // "Bugun", "Kecha" kabi ajratish mumkin, hozircha oddiy ro'yxat
        sessions.forEach(session => {
            const btn = document.createElement('button');
            btn.className = `w-full text-left p-3 rounded-lg hover:bg-white/5 text-sm text-gray-300 truncate transition flex items-center gap-2 ${currentSessionId === session.id ? 'bg-white/10 text-white' : ''}`;
            btn.innerHTML = `<i class="fa-regular fa-message text-xs opacity-70"></i> <span class="truncate">${session.title || 'Suhbat'}</span>`;
            btn.onclick = () => loadChat(session.id, session.title);
            
            // Delete button
            const delBtn = document.createElement('div');
            delBtn.className = 'ml-auto text-gray-500 hover:text-red-400 p-1 cursor-pointer';
            delBtn.innerHTML = '<i class="fa-solid fa-trash text-xs"></i>';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                deleteSession(session.id);
            };
            btn.appendChild(delBtn);
            
            els.chatHistoryList.appendChild(btn);
        });
    } catch (e) { console.error(e); }
}

async function loadChat(sessionId, title) {
    currentSessionId = sessionId;
    els.chatTitle.textContent = title || 'Chat';
    toggleSidebar(false);
    
    // UI Update
    toggleWelcome(false);
    els.messagesList.innerHTML = '<div class="text-center text-gray-500 py-4">Yuklanmoqda...</div>';
    loadSessions(); // Update active state in sidebar

    try {
        const res = await fetch(`/api/messages/${sessionId}`);
        const messages = await res.json();
        els.messagesList.innerHTML = '';
        
        if (messages.length === 0) toggleWelcome(true);
        else messages.forEach(m => appendMessage(m.content, m.role, m.type, false));
        
    } catch (e) {
        els.messagesList.innerHTML = '<div class="text-center text-red-400">Xatolik yuz berdi</div>';
    }
}

async function deleteSession(id) {
    if (!confirm("Suhbatni o'chirasizmi?")) return;
    await fetch(`/api/session/${id}`, { method: 'DELETE' });
    if (currentSessionId === id) startNewChat();
    else loadSessions();
}

async function startNewChat() {
    currentSessionId = null;
    toggleWelcome(true);
    toggleSidebar(false);
    loadSessions();
}

async function sendMessage(text, type = 'text', file = null) {
    if (isTyping) return;
    isTyping = true;

    // Optimistic UI
    appendMessage(text, 'user', type);
    toggleWelcome(false);
    els.userInput.value = '';
    els.userInput.style.height = 'auto';
    updateSubmitBtn();
    showTyping();

    const formData = new FormData();
    formData.append('userId', currentUserId);
    formData.append('message', text);
    formData.append('type', type);
    if (currentSessionId) formData.append('sessionId', currentSessionId);
    if (file) formData.append('file', file);

    try {
        const res = await fetch('/api/chat', { method: 'POST', body: formData });
        const data = await res.json();
        
        hideTyping();
        
        if (data.success) {
            appendMessage(data.response, 'assistant');
            
            // Agar yangi chat bo'lsa yoki title o'zgargan bo'lsa
            if (currentSessionId !== data.sessionId || data.newTitle) {
                currentSessionId = data.sessionId;
                if (data.newTitle) els.chatTitle.textContent = data.newTitle;
                loadSessions(); // Sidebarni yangilash
            }
        } else {
            appendMessage("Xatolik: " + data.response, 'assistant');
        }
    } catch (e) {
        hideTyping();
        appendMessage("Tarmoq xatoligi.", 'assistant');
    }
    isTyping = false;
}

// --- EVENT LISTENERS ---

function toggleSidebar(show) {
    if (show) {
        els.sidebar.classList.remove('-translate-x-full');
        els.sidebarOverlay.classList.remove('hidden');
    } else {
        els.sidebar.classList.add('-translate-x-full');
        els.sidebarOverlay.classList.add('hidden');
    }
}

document.getElementById('toggle-sidebar').onclick = () => toggleSidebar(true);
document.getElementById('close-sidebar').onclick = () => toggleSidebar(false);
els.sidebarOverlay.onclick = () => toggleSidebar(false);
document.getElementById('new-chat-btn').onclick = startNewChat;

els.userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
    updateSubmitBtn();
});

function updateSubmitBtn() {
    if (els.userInput.value.trim().length > 0) {
        els.submitBtn.removeAttribute('disabled');
        els.submitBtn.classList.replace('bg-white/10', 'bg-[#d946ef]');
        els.submitBtn.classList.add('text-white');
    } else {
        els.submitBtn.setAttribute('disabled', 'true');
        els.submitBtn.classList.replace('bg-[#d946ef]', 'bg-white/10');
        els.submitBtn.classList.remove('text-white');
    }
}

els.chatForm.onsubmit = (e) => {
    e.preventDefault();
    const text = els.userInput.value.trim();
    if (text) sendMessage(text);
};

els.fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) sendMessage("Rasm tahlili...", 'image', file);
};
document.getElementById('upload-btn').onclick = () => els.fileInput.click();

document.querySelectorAll('.suggestion-btn').forEach(btn => {
    btn.onclick = () => sendMessage(btn.innerText.replace('💡 ', '').replace('🎨 ', ''));
});

// --- INIT ---
(function init() {
    // User info
    const user = tg.initDataUnsafe?.user;
    if (user) {
        currentUserId = user.id;
        document.getElementById('user-name').textContent = user.first_name;
        if(user.photo_url) document.getElementById('user-avatar').src = user.photo_url;
        else document.getElementById('user-avatar').src = `https://api.dicebear.com/7.x/avataaars/svg?seed=${user.username}`;
    }
    
    loadSessions();
    
    // 3D Background (Simple Starfield)
    // ... (Oldingi Three.js kodi shu yerga qo'shiladi yoki app.js oxiriga)
})();
