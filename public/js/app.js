const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
tg.setHeaderColor('#050509'); 
tg.setBackgroundColor('#050509');

let currentSessionId = null;
let currentUserId = tg.initDataUnsafe?.user?.id || 12345; 
let isTyping = false;
let abortController = null; // STOP qilish uchun controller
let selectedFile = null;
let selectedAnalysisType = 'ocr'; // 'vision' or 'ocr'

// Marked.js ni sozlash (Kodlarni chiroyli qilish uchun)
marked.setOptions({
    highlight: function(code, lang) { return code; }, // Oddiy qaytaramiz, CSS hal qiladi
    breaks: true
});

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
    modeModal: document.getElementById('mode-modal'),
    imagePreviewArea: document.getElementById('image-preview-area'),
    previewImg: document.getElementById('preview-img'),
    modeBadge: document.getElementById('mode-badge'),
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

// KODNI NUSXALASH
window.copyCode = function(btn) {
    const pre = btn.closest('div').querySelector('pre');
    const code = pre.innerText;
    navigator.clipboard.writeText(code).then(() => {
        const originalHTML = btn.innerHTML;
        btn.innerHTML = '<i class="fa-solid fa-check text-green-400"></i>';
        setTimeout(() => btn.innerHTML = originalHTML, 2000);
    });
};

function formatMessage(content) {
    // Marked orqali HTML ga o'tkazamiz
    let html = marked.parse(content);
    
    // Kod bloklariga "Copy" tugmasini qo'shish
    const tempDiv = document.createElement('div');
    tempDiv.innerHTML = html;
    
    const pres = tempDiv.querySelectorAll('pre');
    pres.forEach(pre => {
        const wrapper = document.createElement('div');
        wrapper.className = 'relative group my-3';
        
        const copyBtn = document.createElement('button');
        copyBtn.className = 'absolute top-2 right-2 p-1.5 bg-white/10 hover:bg-white/20 rounded text-gray-300 transition-all opacity-0 group-hover:opacity-100 text-xs';
        copyBtn.innerHTML = '<i class="fa-regular fa-copy"></i>';
        copyBtn.onclick = function() { window.copyCode(this) };
        
        const codeBlock = pre.cloneNode(true);
        codeBlock.className = 'bg-[#1e1e24] p-3 rounded-lg overflow-x-auto border border-white/10 text-sm font-mono text-[#00ffff]';
        
        wrapper.appendChild(copyBtn);
        wrapper.appendChild(codeBlock);
        pre.parentNode.replaceChild(wrapper, pre);
    });

    return tempDiv.innerHTML;
}

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
        <div class="${bubbleClass} p-4 min-w-[60px] max-w-[90%] relative group transition-all hover:shadow-xl overflow-hidden">
            <div class="message-content leading-relaxed text-[15px] font-medium whitespace-pre-wrap tracking-wide break-words"></div>
            <div class="text-[10px] opacity-50 text-right mt-1.5 font-mono flex items-center justify-end gap-1">
                ${new Date().toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}
            </div>
        </div>
    `;
    
    els.messagesList.appendChild(div);
    scrollToBottom();
    return div.querySelector('.message-content');
}

// --- MODAL & IMAGE LOGIC ---
document.getElementById('upload-btn').onclick = () => els.modeModal.classList.remove('hidden');
window.closeModal = () => els.modeModal.classList.add('hidden');

window.selectMode = (mode) => {
    selectedAnalysisType = mode;
    els.modeModal.classList.add('hidden');
    els.fileInput.click();
};

els.fileInput.onchange = (e) => {
    const file = e.target.files[0];
    if (file) {
        selectedFile = file;
        const reader = new FileReader();
        reader.onload = (ev) => {
            els.previewImg.src = ev.target.result;
            els.modeBadge.textContent = selectedAnalysisType === 'vision' ? 'VISION' : 'OCR';
            els.modeBadge.style.color = selectedAnalysisType === 'vision' ? '#d946ef' : '#00ffff';
            els.imagePreviewArea.classList.remove('hidden');
        };
        reader.readAsDataURL(file);
        updateSubmitBtn(); // Rasm borligini tekshirish
    }
};

window.clearImage = () => {
    selectedFile = null;
    els.fileInput.value = '';
    els.imagePreviewArea.classList.add('hidden');
    updateSubmitBtn();
};

// --- STREAMING CHAT LOGIC ---
async function sendMessage(text, type = 'text') {
    isTyping = true;
    updateSubmitBtn(); // Icon STOP ga o'zgaradi
    
    toggleWelcome(false);
    
    // User Bubble
    const userBubble = createMessageBubble('user', type);
    if (type === 'image') {
        userBubble.innerHTML = `<div class="flex flex-col gap-2">
            <img src="${els.previewImg.src}" class="rounded-lg max-h-40 w-auto border border-white/20">
            <span>${text || (selectedAnalysisType === 'vision' ? 'Rasm tahlili' : 'Matnni o\'qish')}</span>
        </div>`;
    } else {
        userBubble.textContent = text;
    }

    // Tozalash
    els.userInput.value = '';
    els.userInput.style.height = 'auto';
    const fileToSend = selectedFile; // Nusxalab olamiz
    const analysisTypeToSend = selectedAnalysisType;
    clearImage(); // UI dan olib tashlaymiz

    // AI Bubble
    const aiBubble = createMessageBubble('assistant', 'text');
    aiBubble.innerHTML = '<span class="inline-block w-2 h-4 bg-[#00ffff] animate-pulse"></span>';

    // Abort Controller (STOP uchun)
    abortController = new AbortController();

    const formData = new FormData();
    formData.append('userId', currentUserId);
    formData.append('message', text);
    formData.append('type', type);
    if (currentSessionId) formData.append('sessionId', currentSessionId);
    if (fileToSend) {
        formData.append('file', fileToSend);
        formData.append('analysisType', analysisTypeToSend);
    }

    try {
        const response = await fetch('/api/chat', { 
            method: 'POST', 
            body: formData,
            signal: abortController.signal // Signalni ulaymiz
        });
        
        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let aiTextRaw = "";

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
                        if (data.token) {
                            aiTextRaw += data.token;
                            aiBubble.innerHTML = formatMessage(aiTextRaw); 
                            scrollToBottom();
                        }
                        if (data.done) {
                            if (currentSessionId !== data.sessionId || data.newTitle) {
                                currentSessionId = data.sessionId;
                                if(data.newTitle) els.chatTitle.textContent = data.newTitle;
                                loadSessions();
                            }
                        }
                        if (data.error) {
                            aiBubble.innerHTML += `<br><span class="text-red-400 text-xs">[Xato: ${data.error}]</span>`;
                        }
                    } catch (e) {}
                }
            }
        }
    } catch (e) {
        if (e.name === 'AbortError') {
            aiBubble.innerHTML += ` <span class="text-gray-500 text-xs">(To'xtatildi)</span>`;
        } else {
            aiBubble.innerHTML = `<span class="text-red-400">Tarmoq xatoligi.</span>`;
        }
    } finally {
        isTyping = false;
        abortController = null;
        updateSubmitBtn();
    }
}

// --- STOP GENERATION LOGIC ---
function stopGeneration() {
    if (abortController) {
        abortController.abort();
        abortController = null;
        isTyping = false;
        updateSubmitBtn();
    }
}

// --- EVENT LISTENERS ---
els.chatForm.onsubmit = (e) => {
    e.preventDefault();
    if (isTyping) {
        stopGeneration();
        return;
    }
    const text = els.userInput.value.trim();
    if (text || selectedFile) {
        sendMessage(text, selectedFile ? 'image' : 'text');
    }
};

// Tugmani holatini yangilash (Send <-> Stop)
function updateSubmitBtn() {
    const hasText = els.userInput.value.trim().length > 0;
    const hasFile = !!selectedFile;
    
    els.submitBtn.removeAttribute('disabled');
    els.submitBtn.classList.remove('opacity-50', 'cursor-not-allowed');

    if (isTyping) {
        // STOP HOLATI
        els.submitBtn.innerHTML = '<i class="fa-solid fa-stop text-red-500"></i>'; // Stop icon
        els.submitBtn.classList.add('border', 'border-red-500/30');
    } else {
        // SEND HOLATI
        els.submitBtn.innerHTML = '<i class="fa-solid fa-arrow-up text-lg font-bold"></i>';
        els.submitBtn.classList.remove('border', 'border-red-500/30');
        
        if (!hasText && !hasFile) {
            els.submitBtn.setAttribute('disabled', 'true');
            els.submitBtn.classList.add('opacity-50', 'cursor-not-allowed');
        }
    }
}

els.userInput.addEventListener('input', function() {
    this.style.height = 'auto';
    this.style.height = (this.scrollHeight) + 'px';
    updateSubmitBtn();
});

// --- INIT ---
// Qolgan kodlar (Session yuklash, Sidebar) o'zgarishsiz qoladi...
// ... loadSessions, loadChat, toggleSidebar ...
// Faqat context uchun bu yerga copy qilmadingiz, lekin ular App.js ichida turishi kerak.
// Men tepadagi funksiyalarni to'liq yozdim. Qolgan yordamchi funksiyalarni eski kodingizdan qo'shib qo'yasiz.

// Sidebar logikasi (qisqartirilgan, eski koddan oling):
async function loadSessions() { /* ... */ }
async function loadChat(id) { /* ... */ }
async function deleteSession(id) { /* ... */ }
function toggleSidebar(show) { 
    if(show) {els.sidebar.classList.remove('-translate-x-full'); els.sidebarOverlay.classList.remove('hidden');}
    else {els.sidebar.classList.add('-translate-x-full'); els.sidebarOverlay.classList.add('hidden');}
}

// Bindings
document.getElementById('toggle-sidebar').onclick = () => toggleSidebar(true);
document.getElementById('close-sidebar').onclick = () => toggleSidebar(false);
els.sidebarOverlay.onclick = () => toggleSidebar(false);
document.getElementById('new-chat-btn').onclick = () => { currentSessionId = null; toggleWelcome(true); toggleSidebar(false); };

(function init() {
    loadUserProfile();
    loadSessions(); // Serverdan sessiyalarni olish funksiyasini chaqirish
})();
