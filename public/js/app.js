const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
// Neon tema ranglari
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

// --- PROFILNI YUKLASH ---
function loadUserProfile() {
    const user = tg.initDataUnsafe?.user;
    if (user) {
        currentUserId = user.id;
        const fullName = `${user.first_name} ${user.last_name || ''}`.trim();
        els.userName.textContent = fullName || user.username || "Foydalanuvchi";
        els.userStatus.textContent = user.username ? `@${user.username}` : `ID: ${user.id}`;

        if (user.photo_url) {
            els.userAvatar.src = user.photo_url;
        } else {
            const seed = user.username || user.first_name || "user";
            els.userAvatar.src = `https://api.dicebear.com/7.x/avataaars/svg?seed=${seed}&backgroundColor=b6e3f4,c0aede,d1d4f9`;
        }
    }
}

// --- UI FUNKSIYALARI ---
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

function formatMessage(content) {
    // Kod bloklarini ajratib ko'rsatish uchun
    content = content.replace(/```([\s\S]*?)```/g, '<pre class="bg-black/30 p-3 rounded-lg my-2 overflow-x-auto border border-white/10"><code class="text-sm font-mono text-blue-300">$1</code></pre>');
    // Qalin matn
    content = content.replace(/\*\*(.*?)\*\*/g, '<strong class="text-white font-bold">$1</strong>');
    // Inline kod
    content = content.replace(/`([^`]+)`/g, '<code class="bg-white/10 px-1.5 py-0.5 rounded text-xs font-mono text-yellow-300">$1</code>');
    return content.replace(/\n/g, '<br>');
}

function appendMessage(content, role, type = 'text', animate = true) {
    const isUser = role === 'user';
    const div = document.createElement('div');
    div.className = `flex items-end gap-3 ${isUser ? 'flex-row-reverse' : ''} ${animate ? 'animate-slide-in' : ''}`;
    
    const avatar = isUser 
        ? `<div class="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center shrink-0 shadow-lg border border-white/10"><i class="fa-solid fa-user text-xs text-white"></i></div>`
        : `<div class="w-8 h-8 rounded-lg bg-gradient-to-br from-[#d946ef] to-[#00e1ff] flex items-center justify-center shrink-0 shadow-lg shadow-purple-500/20"><i class="fa-solid fa-robot text-white text-xs"></i></div>`;

    let innerContent = '';
    if (type === 'text') {
        // Matnni yaqqolroq qilish uchun font-medium va text-[15px] qo'shildi
        innerContent = `<div class="leading-relaxed text-[15px] font-medium whitespace-pre-wrap">${formatMessage(content)}</div>`;
    } else if (type === 'image') {
        innerContent = `<div class="flex items-center gap-2 text-sm font-medium italic text-gray-300"><i class="fa-regular fa-image text-blue-400"></i> Rasm yuborildi</div>`;
    }

    // Bubble dizayni yangilandi: Fon ranglari to'qroq va aniqroq, soyalar qo'shildi
    const bubbleClass = isUser 
        ? 'bg-blue-600 text-white shadow-lg shadow-blue-900/30 border border-blue-500/30 rounded-tr-none' 
        : 'bg-[#1e293b] text-slate-100 shadow-md border border-white/10 rounded-tl-none';

    div.innerHTML = `
        ${avatar}
        <div class="${bubbleClass} p-3.5 rounded-2xl max-w-[85%] min-w-[60px] relative group">
            ${innerContent}
            <div class="text-[10px] opacity-60 text-right mt-1 font-mono">${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</div>
        </div>
    `;
    els.messagesList.appendChild(div);
    scrollToBottom();
}

function showTyping() {
    const div = document.createElement('div');
    div.id = 'typing-indicator';
    div.className = 'flex items-end gap-3 animate-pulse pl-0'; // padding removed for better alignment
    
    // AI Avatar for typing
    const avatar = `<div class="w-8 h-8 rounded-lg bg-gradient-to-br from-[#d946ef] to-[#00e1ff] flex items-center justify-center shrink-0 shadow-lg"><i class="fa-solid fa-robot text-white text-xs"></i></div>`;
    
    div.innerHTML = `
        ${avatar}
        <div class="bg-[#1e293b] border border-white/10 p-3.5 rounded-2xl rounded-tl-none w-fit shadow-md flex gap-1.5 items-center h-[46px]">
             <div class="w-2 h-2 bg-[#d946ef] rounded-full animate-bounce"></div>
             <div class="w-2 h-2 bg-[#00ffff] rounded-full animate-bounce" style="animation-delay: 0.15s"></div>
             <div class="w-2 h-2 bg-white rounded-full animate-bounce" style="animation-delay: 0.3s"></div>
        </div>
    `;
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
        
        sessions.forEach(session => {
            const btn = document.createElement('button');
            const isActive = currentSessionId === session.id;
            // Sidebar item dizayni ham biroz kuchaytirildi
            btn.className = `w-full text-left p-3 rounded-xl mb-1.5 transition-all flex items-center gap-3 group border border-transparent ${
                isActive 
                ? 'bg-white/10 text-white border-white/5 shadow-sm' 
                : 'text-gray-400 hover:bg-white/5 hover:text-gray-200'
            }`;
            
            btn.innerHTML = `
                <i class="fa-regular fa-message text-xs ${isActive ? 'text-[#00ffff]' : 'opacity-50'}"></i> 
                <span class="truncate flex-1 text-sm font-medium">${session.title || 'Suhbat'}</span>
                <div class="delete-btn opacity-0 group-hover:opacity-100 p-1.5 hover:bg-red-500/20 hover:text-red-400 rounded-md transition-all" title="O'chirish">
                    <i class="fa-solid fa-trash text-[10px]"></i>
                </div>
            `;
            
            btn.onclick = () => loadChat(session.id, session.title);
            
            const delBtn = btn.querySelector('.delete-btn');
            delBtn.onclick = (e) => { e.stopPropagation(); deleteSession(session.id); };
            
            els.chatHistoryList.appendChild(btn);
        });
    } catch (e) { console.error(e); }
}

async function loadChat(sessionId, title) {
    currentSessionId = sessionId;
    els.chatTitle.textContent = title || 'Chat';
    toggleSidebar(false);
    toggleWelcome(false);
    els.messagesList.innerHTML = '<div class="flex justify-center py-8"><i class="fa-solid fa-circle-notch fa-spin text-[#00ffff] text-xl"></i></div>';
    loadSessions();

    try {
        const res = await fetch(`/api/messages/${sessionId}`);
        const messages = await res.json();
        els.messagesList.innerHTML = '';
        if (messages.length === 0) toggleWelcome(true);
        else messages.forEach(m => appendMessage(m.content, m.role, m.type, false));
        scrollToBottom();
    } catch (e) {
        els.messagesList.innerHTML = '<div class="text-center text-red-400 py-4 text-sm">Xatolik yuz berdi</div>';
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
            if (currentSessionId !== data.sessionId || data.newTitle) {
                currentSessionId = data.sessionId;
                if (data.newTitle) els.chatTitle.textContent = data.newTitle;
                loadSessions();
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

// --- HANDLERS ---
function toggleSidebar(show) {
    if (show) {
        els.sidebar.classList.remove('-translate-x-full');
        els.sidebarOverlay.classList.remove('hidden');
        // Fade in animation for overlay
        requestAnimationFrame(() => els.sidebarOverlay.classList.remove('opacity-0'));
    } else {
        els.sidebar.classList.add('-translate-x-full');
        els.sidebarOverlay.classList.add('opacity-0');
        setTimeout(() => els.sidebarOverlay.classList.add('hidden'), 300);
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
        els.submitBtn.classList.replace('bg-white/5', 'bg-[#d946ef]');
        els.submitBtn.classList.remove('text-gray-600', 'cursor-not-allowed');
        els.submitBtn.classList.add('text-white', 'shadow-lg', 'shadow-purple-500/30');
    } else {
        els.submitBtn.setAttribute('disabled', 'true');
        els.submitBtn.classList.replace('bg-[#d946ef]', 'bg-white/5');
        els.submitBtn.classList.add('text-gray-600', 'cursor-not-allowed');
        els.submitBtn.classList.remove('text-white', 'shadow-lg', 'shadow-purple-500/30');
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

// --- INIT (3D Background) ---
(function init() {
    loadUserProfile();
    loadSessions();
    
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
        const count = 600;
        const positions = new Float32Array(count * 3);
        const colors = new Float32Array(count * 3);
        const color1 = new THREE.Color(0xff00ff);
        const color2 = new THREE.Color(0x00e1ff);

        for(let i = 0; i < count; i++) {
            positions[i * 3] = (Math.random() - 0.5) * 120;
            positions[i * 3 + 1] = (Math.random() - 0.5) * 120;
            positions[i * 3 + 2] = (Math.random() - 0.5) * 120;
            const rand = Math.random();
            let finalColor = rand < 0.5 ? color1 : color2;
            colors[i * 3] = finalColor.r;
            colors[i * 3 + 1] = finalColor.g;
            colors[i * 3 + 2] = finalColor.b;
        }
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
        const material = new THREE.PointsMaterial({ size: 0.5, vertexColors: true, transparent: true, opacity: 0.6 });
        const starField = new THREE.Points(geometry, material);
        scene.add(starField);

        function animate() {
            requestAnimationFrame(animate);
            starField.rotation.y += 0.0005;
            renderer.render(scene, camera);
        }
        animate();

        window.addEventListener('resize', () => {
            camera.aspect = window.innerWidth / window.innerHeight;
            camera.updateProjectionMatrix();
            renderer.setSize(window.innerWidth, window.innerHeight);
        });
    }
})();
