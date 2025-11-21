const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
tg.setHeaderColor('#050509'); 
tg.setBackgroundColor('#050509');

let currentSessionId = null;
let currentUserId = tg.initDataUnsafe?.user?.id || 12345; 
let isTyping = false;

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
    fileInput: document.getElementById('file-upload'),
    userAvatar: document.getElementById('user-avatar'),
    userName: document.getElementById('user-name'),
    userStatus: document.getElementById('user-status')
};

// --- UI UTILS ---
function loadUserProfile() {
    const user = tg.initDataUnsafe?.user;
    if (user) {
        currentUserId = user.id;
        els.userName.textContent = `${user.first_name} ${user.last_name || ''}`.trim();
        els.userStatus.textContent = user.username ? `@${user.username}` : `ID: ${user.id}`;
        if (user.photo_url) els.userAvatar.src = user.photo_url;
    }
}

function toggleWelcome(show) {
    if (show) {
        els.welcomeScreen.classList.remove('hidden');
        els.messagesList.innerHTML = '';
    } else {
        els.welcomeScreen.classList.add('hidden');
    }
}

function scrollToBottom() {
    els.chatContainer.scrollTo({ top: els.chatContainer.scrollHeight, behavior: 'smooth' });
}

function formatMessage(content) {
    // Matnni formatlash (Markdown)
    content = content.replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-bold">$1</strong>');
    content = content.replace(/```([\s\S]*?)```/g, '<pre class="bg-[#0a0a12] p-3 rounded-lg my-2 overflow-x-auto border border-white/10"><code class="text-sm font-mono text-[#00ffff]">$1</code></pre>');
    content = content.replace(/`([^`]+)`/g, '<code class="bg-white/10 px-1.5 py-0.5 rounded text-xs font-mono text-[#d946ef]">$1</code>');
    return content.replace(/\n/g, '<br>');
}

// --- MESSAGE CREATION ---
function createMessageBubble(role, type = 'text') {
    const isUser = role === 'user';
    const div = document.createElement('div');
    div.className = `flex items-end gap-3 ${isUser ? 'flex-row-reverse' : ''} animate-slide-in`;
    
    const avatar = isUser 
        ? `<div class="w-9 h-9 rounded-xl bg-gradient-to-br from-[#7c3aed] to-[#db2777] flex items-center justify-center shrink-0 shadow-lg"><i class="fa-solid fa-user text-xs text-white"></i></div>`
        : `<div class="w-9 h-9 rounded-xl bg-[#0a0a12] border border-white/10 flex items-center justify-center shrink-0 shadow-lg shadow-[#00ffff]/10"><i class="fa-solid fa-robot text-[#00ffff] text-sm"></i></div>`;

    const bubbleClass = isUser 
        ? 'bg-gradient-to-r from-[#7c3aed] to-[#db2777] text-white shadow-[0_4px_15px_rgba(124,58,237,0.3)] border border-white/10 rounded-2xl rounded-tr-none' 
        : 'bg-[#111116] text-gray-200 shadow-md border border-white/5 rounded-2xl rounded-tl-none border-l-[3px] border-l-[#00ffff]';

    div.innerHTML = `
        ${avatar}
        <div class="${bubbleClass} p-4 min-w-[60px] max-w-[85%] relative group transition-all hover:shadow-xl">
            <div class="message-content leading-relaxed text-[15px] font-medium whitespace-pre-wrap tracking-wide"></div>
            <div class="text-[10px] opacity-50 text-right mt-1.5 font-mono flex items-center justify-end gap-1">
                ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
            </div>
        </div>
    `;
    
    els.messagesList.appendChild(div);
    scrollToBottom();
    return div.querySelector('.message-content');
}

// --- REAL-TIME CHAT LOGIC ---
async function sendMessage(text, type = 'text', file = null) {
    if (isTyping) return;
    isTyping = true;
    
    toggleWelcome(false);
    els.userInput.value = '';
    els.userInput.style.height = 'auto';
    
    // 1. User xabari
    const userBubble = createMessageBubble('user', type);
    userBubble.innerHTML = type === 'text' ? formatMessage(text) : `<div class="flex items-center gap-2 text-sm italic"><i class="fa-regular fa-image"></i> Rasm yuklanmoqda...</div>`;

    // 2. AI uchun bo'sh quti (Loading state)
    const aiBubble = createMessageBubble('assistant', 'text');
    aiBubble.innerHTML = '<span class="inline-block w-2 h-4 bg-[#00ffff] animate-pulse"></span>';

    const formData = new FormData();
    formData.append('userId', currentUserId);
    formData.append('message', text);
    formData.append('type', type);
    if (currentSessionId) formData.append('sessionId', currentSessionId);
    if (file) formData.append('file', file);

    try {
        const response = await fetch('/api/chat', { method: 'POST', body: formData });
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let aiTextRaw = "";

        // Streamni o'qish tsikli
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            
            const chunk = decoder.decode(value, { stream: true });
            const lines = chunk.split("\n");

            for (const line of lines) {
                if (line.startsWith("data: ")) {
                    const jsonStr = line.replace("data: ", "").trim();
                    if (!jsonStr) continue;

                    try {
                        const data = JSON.parse(jsonStr);
                        
                        // Token kelsa matnga qo'shamiz va ekranni yangilaymiz
                        if (data.token) {
                            aiTextRaw += data.token;
                            aiBubble.innerHTML = formatMessage(aiTextRaw); // Formatlash bilan yangilash
                            scrollToBottom();
                        }
                        
                        // Yakuniy signal
                        if (data.done) {
                            if (currentSessionId !== data.sessionId || data.newTitle) {
                                currentSessionId = data.sessionId;
                                loadSessions();
                            }
                        }
                        
                        if (data.error) {
                            aiBubble.innerHTML += `<br><span class="text-red-400 text-xs">[Xatolik: ${data.error}]</span>`;
                        }
                    } catch (e) {}
                }
            }
        }
    } catch (e) {
        aiBubble.innerHTML = `<span class="text-red-400">Tarmoq xatoligi.</span>`;
    }
    
    isTyping = false;
}

// --- SESSIONS & OTHER LOGIC ---
async function loadSessions() {
    try {
        const res = await fetch(`/api/sessions/${currentUserId}`);
        const sessions = await res.json();
        els.chatHistoryList.innerHTML = '';
        
        sessions.forEach(session => {
            const btn = document.createElement('button');
            const isActive = currentSessionId === session.id;
            btn.className = `w-full text-left p-3 rounded-xl mb-1.5 transition-all flex items-center gap-3 group border border-transparent active:scale-95 ${
                isActive ? 'bg-white/10 text-white shadow' : 'text-gray-400 hover:bg-white/5'
            }`;
            btn.innerHTML = `
                <i class="fa-regular fa-message text-xs ${isActive ? 'text-[#00ffff]' : 'opacity-50'}"></i> 
                <span class="truncate flex-1 text-sm font-medium">${session.title || 'Suhbat'}</span>
                <div class="delete-btn opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-500/20 hover:text-red-400 rounded-md transition-all"><i class="fa-solid fa-trash text-[10px]"></i></div>
            `;
            btn.onclick = () => loadChat(session.id, session.title);
            btn.querySelector('.delete-btn').onclick = (e) => { e.stopPropagation(); deleteSession(session.id); };
            els.chatHistoryList.appendChild(btn);
        });
    } catch (e) {}
}

async function loadChat(sessionId, title) {
    currentSessionId = sessionId;
    els.chatTitle.textContent = 'ChatGPT AI';
    toggleSidebar(false);
    toggleWelcome(false);
    els.messagesList.innerHTML = '<div class="flex justify-center py-8"><i class="fa-solid fa-circle-notch fa-spin text-[#00ffff] text-2xl"></i></div>';
    loadSessions();

    try {
        const res = await fetch(`/api/messages/${sessionId}`);
        const messages = await res.json();
        els.messagesList.innerHTML = '';
        if (messages.length === 0) toggleWelcome(true);
        else {
            messages.forEach(m => {
                const bubble = createMessageBubble(m.role, m.type);
                if (m.type === 'text') bubble.innerHTML = formatMessage(m.content);
                else bubble.innerHTML = `<div class="flex items-center gap-2 text-sm italic"><i class="fa-regular fa-image text-[#00ffff]"></i> Rasm yuborildi</div>`;
            });
        }
    } catch (e) {
        els.messagesList.innerHTML = '<div class="text-center text-red-400 py-4 text-sm">Xatolik</div>';
    }
}

async function startNewChat() {
    currentSessionId = null;
    toggleWelcome(true);
    toggleSidebar(false);
    loadSessions();
}

async function deleteSession(id) {
    if (!confirm("Suhbatni o'chirasizmi?")) return;
    await fetch(`/api/session/${id}`, { method: 'DELETE' });
    if (currentSessionId === id) startNewChat();
    else loadSessions();
}

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
});

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

(function init() {
    loadUserProfile();
    loadSessions();
    
    // 3D fon
    const container = document.getElementById('canvas-container');
    if (container) {
        const scene = new THREE.Scene();
        const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
        camera.position.z = 50;
        const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setPixelRatio(window.devicePixelRatio);
        container.appendChild(renderer.domElement);
        const geometry = new THREE.BufferGeometry();
        const positions = new Float32Array(600 * 3);
        const colors = new Float32Array(600 * 3);
        const c1 = new THREE.Color(0xff00ff), c2 = new THREE.Color(0x00e1ff);
        for(let i=0;i<600;i++) {
            positions[i*3]=(Math.random()-0.5)*120; positions[i*3+1]=(Math.random()-0.5)*120; positions[i*3+2]=(Math.random()-0.5)*120;
            let c = Math.random()<0.5?c1:c2; colors[i*3]=c.r; colors[i*3+1]=c.g; colors[i*3+2]=c.b;
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(positions,3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors,3));
        const starField = new THREE.Points(geometry, new THREE.PointsMaterial({size:0.5,vertexColors:true,transparent:true,opacity:0.6}));
        scene.add(starField);
        function animate() { requestAnimationFrame(animate); starField.rotation.y+=0.0005; renderer.render(scene,camera); }
        animate();
    }
})();
