// 1. TELEGRAM SETUP & USER PROFILE
const tg = window.Telegram.WebApp;
tg.ready();
tg.expand();
tg.setHeaderColor('#0a0a12'); 
tg.setBackgroundColor('#050509');

// Foydalanuvchi ma'lumotlarini olish va o'rnatish
const initUserProfile = () => {
    const user = tg.initDataUnsafe?.user;
    
    // Elementlarni topish
    const userNameEl = document.getElementById('sidebar-user-name');
    const userAvatarEl = document.getElementById('sidebar-user-avatar');

    if (user) {
        // Ismni yangilash
        const fullName = `${user.first_name} ${user.last_name || ''}`.trim();
        if (userNameEl) userNameEl.textContent = fullName;

        // Rasmni yangilash
        if (userAvatarEl) {
            if (user.photo_url) {
                // Agar Telegram rasm url bersa (ko'pincha bot ruxsati kerak)
                userAvatarEl.src = user.photo_url;
            } else {
                // Agar rasm bo'lmasa, foydalanuvchi ismi yoki username asosida avatar generatsiya qilamiz
                const seed = user.username || user.first_name;
                userAvatarEl.src = `https://api.dicebear.com/7.x/avataaars/svg?seed=${seed}&backgroundColor=b6e3f4,c0aede,d1d4f9`;
            }
        }
    }
};

// 2. THREE.JS BACKGROUND
const initThreeJS = () => {
    const container = document.getElementById('canvas-container');
    const scene = new THREE.Scene();
    
    const camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 0.1, 1000);
    camera.position.z = 50;

    const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(window.devicePixelRatio);
    container.appendChild(renderer.domElement);

    // Particles
    const geometry = new THREE.BufferGeometry();
    const count = window.innerWidth < 768 ? 300 : 600;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);

    const color1 = new THREE.Color(0xff00ff);
    const color2 = new THREE.Color(0x9d00ff);
    const color3 = new THREE.Color(0x00e1ff);

    for(let i = 0; i < count; i++) {
        positions[i * 3] = (Math.random() - 0.5) * 120;
        positions[i * 3 + 1] = (Math.random() - 0.5) * 120;
        positions[i * 3 + 2] = (Math.random() - 0.5) * 120;

        const rand = Math.random();
        let finalColor = rand < 0.33 ? color1 : (rand < 0.66 ? color2 : color3);

        colors[i * 3] = finalColor.r;
        colors[i * 3 + 1] = finalColor.g;
        colors[i * 3 + 2] = finalColor.b;
    }

    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    const material = new THREE.PointsMaterial({
        size: 0.5,
        vertexColors: true,
        transparent: true,
        opacity: 0.6,
        blending: THREE.AdditiveBlending
    });

    const starField = new THREE.Points(geometry, material);
    scene.add(starField);

    const animate = () => {
        requestAnimationFrame(animate);
        starField.rotation.y += 0.0005;
        starField.rotation.x += 0.0002;
        renderer.render(scene, camera);
    };
    animate();

    window.addEventListener('resize', () => {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    });
};

// 3. APP LOGIC
document.addEventListener('DOMContentLoaded', () => {
    initThreeJS();
    initUserProfile(); // Profilni yuklash

    const chatContainer = document.getElementById('chat-container');
    const messagesArea = document.getElementById('messages-area');
    const welcomeScreen = document.getElementById('welcome-screen');
    const userInput = document.getElementById('user-input');
    const submitBtn = document.getElementById('submit-btn');
    const uploadBtn = document.getElementById('upload-btn');
    const fileInput = document.getElementById('file-upload');
    const micBtn = document.getElementById('mic-btn');
    
    // Sidebar Elements
    const sidebar = document.getElementById('sidebar');
    const sidebarOverlay = document.getElementById('sidebar-overlay');
    const toggleSidebar = document.getElementById('toggle-sidebar');
    const closeSidebar = document.getElementById('close-sidebar');
    const chatHistoryList = document.getElementById('chat-history-list');
    const clearHistoryBtn = document.getElementById('clear-history');
    const newChatBtn = document.getElementById('new-chat-btn');

    // State
    let messages = JSON.parse(localStorage.getItem('chatHistory')) || [];

    // Helpers
    const toggleWelcomeScreen = () => {
        if (messages.length > 0) {
            welcomeScreen.classList.add('opacity-0', 'pointer-events-none');
            setTimeout(() => welcomeScreen.classList.add('hidden'), 500);
        } else {
            welcomeScreen.classList.remove('hidden');
            void welcomeScreen.offsetWidth; 
            welcomeScreen.classList.remove('opacity-0', 'pointer-events-none');
        }
    };

    const scrollToBottom = () => {
        chatContainer.scrollTo({ top: chatContainer.scrollHeight, behavior: 'smooth' });
    };

    const saveHistory = () => {
        const toSave = messages.slice(-50);
        localStorage.setItem('chatHistory', JSON.stringify(toSave));
    };

    const renderHistoryList = () => {
        chatHistoryList.innerHTML = '';
        if (messages.length === 0) {
            chatHistoryList.innerHTML = '<div class="text-center text-gray-500 text-xs mt-4">Tarix bo\'sh</div>';
            return;
        }
        
        const userMsgs = messages.filter(m => m.isUser).slice(-10).reverse();
        userMsgs.forEach(msg => {
            const btn = document.createElement('button');
            btn.className = 'w-full text-left px-3 py-3 rounded-lg hover:bg-white/5 text-sm text-gray-300 truncate transition-colors flex items-center gap-2 group';
            
            let icon = msg.type === 'image' ? 'fa-image' : (msg.type === 'voice' ? 'fa-microphone' : 'fa-message');
            let text = msg.type === 'image' ? 'Rasm' : (msg.type === 'voice' ? 'Ovozli xabar' : msg.content);

            btn.innerHTML = `
                <i class="fa-regular ${icon} text-gray-500 group-hover:text-[#d946ef] transition-colors"></i>
                <span class="truncate">${text}</span>
            `;
            chatHistoryList.appendChild(btn);
        });
    };

    const appendMessage = (content, isUser, type = 'text') => {
        toggleWelcomeScreen();

        const div = document.createElement('div');
        div.className = `flex items-start gap-3 max-w-3xl mx-auto w-full animate-slide-in mb-4 ${isUser ? 'flex-row-reverse' : ''}`;
        
        const avatar = isUser 
            ? `<div class="w-8 h-8 rounded-lg bg-white/10 flex items-center justify-center flex-shrink-0"><i class="fa-solid fa-user text-white text-xs"></i></div>`
            : `<div class="w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 bg-gradient-to-br from-[#ff00ff] to-[#00e1ff] shadow-[0_0_10px_rgba(255,0,255,0.4)]"><i class="fa-solid fa-robot text-white text-xs"></i></div>`;

        let contentHtml = '';
        const bubbleClass = isUser ? 'bg-[#2a2a35] border border-white/5' : 'bg-transparent';

        if (type === 'text') {
            contentHtml = `<p class="leading-relaxed text-sm md:text-base whitespace-pre-wrap">${content}</p>`;
        } else if (type === 'image') {
            contentHtml = `<img src="${content}" class="max-w-full sm:max-w-xs rounded-lg border border-white/10 shadow-lg" alt="Uploaded Image">`;
        } else if (type === 'voice') {
            contentHtml = `
                <div class="flex items-center gap-3 bg-white/5 p-2 rounded-lg border border-white/10 min-w-[150px]">
                    <button class="w-8 h-8 rounded-full bg-[#d946ef] flex items-center justify-center play-btn">
                        <i class="fa-solid fa-play text-white text-xs"></i>
                    </button>
                    <div class="flex flex-col w-full">
                        <div class="h-1 w-full bg-gray-600 rounded-full overflow-hidden">
                            <div class="h-full bg-[#d946ef] w-1/3"></div>
                        </div>
                        <span class="text-[10px] text-gray-400 mt-1">0:05</span>
                    </div>
                </div>`;
        }

        div.innerHTML = `
            ${avatar}
            <div class="${bubbleClass} p-3 md:p-4 rounded-2xl rounded-tr-sm text-white ${type === 'image' ? 'p-1 bg-transparent border-none' : ''}">
                ${contentHtml}
            </div>
        `;
        messagesArea.appendChild(div);
        scrollToBottom();
    };

    const showTyping = () => {
        const div = document.createElement('div');
        div.id = 'typing-indicator';
        div.className = 'flex items-start gap-3 max-w-3xl mx-auto w-full pl-11 mb-4';
        div.innerHTML = `
           <div class="flex gap-1 bg-white/5 p-3 rounded-2xl rounded-tl-none w-fit">
                <div class="w-2 h-2 bg-[#d946ef] rounded-full animate-bounce"></div>
                <div class="w-2 h-2 bg-[#00ffff] rounded-full animate-bounce delay-75"></div>
                <div class="w-2 h-2 bg-white rounded-full animate-bounce delay-150"></div>
           </div>
        `;
        messagesArea.appendChild(div);
        scrollToBottom();
        return div;
    };

    // Handlers
    const toggleMenu = (show) => {
        if (show) {
            sidebar.classList.remove('-translate-x-full');
            sidebarOverlay.classList.remove('hidden');
        } else {
            sidebar.classList.add('-translate-x-full');
            sidebarOverlay.classList.add('hidden');
        }
    };

    toggleSidebar.addEventListener('click', () => toggleMenu(true));
    closeSidebar.addEventListener('click', () => toggleMenu(false));
    sidebarOverlay.addEventListener('click', () => toggleMenu(false));

    userInput.addEventListener('input', function() {
        this.style.height = 'auto';
        this.style.height = (this.scrollHeight) + 'px';
        
        if(this.value.trim().length > 0) {
            submitBtn.removeAttribute('disabled');
            submitBtn.classList.replace('bg-white/10', 'bg-gradient-to-r');
            submitBtn.classList.add('from-[#d946ef]', 'to-[#00ffff]', 'text-white');
            submitBtn.classList.remove('text-gray-500', 'cursor-not-allowed');
        } else {
            submitBtn.setAttribute('disabled', 'true');
            submitBtn.classList.remove('bg-gradient-to-r', 'from-[#d946ef]', 'to-[#00ffff]', 'text-white');
            submitBtn.classList.add('bg-white/10', 'text-gray-500', 'cursor-not-allowed');
        }
    });

    const handleSend = async (text, type = 'text') => {
        // 1. Foydalanuvchi xabari
        appendMessage(text, true, type);
        messages.push({ isUser: true, text: type === 'text' ? text : 'Media', type: type, content: text });
        saveHistory();
        renderHistoryList();

        userInput.value = '';
        userInput.style.height = 'auto';
        submitBtn.setAttribute('disabled', 'true');
        submitBtn.classList.add('bg-white/10', 'text-gray-500', 'cursor-not-allowed');
        submitBtn.classList.remove('bg-gradient-to-r', 'from-[#d946ef]', 'to-[#00ffff]', 'text-white');

        // 2. Backendga so'rov yuborish
        const loader = showTyping();

        try {
            const response = await fetch('/api/chat', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ message: type === 'text' ? text : 'Media file', type: type })
            });

            const data = await response.json();
            
            loader.remove();
            
            if (data.success) {
                appendMessage(data.response, false, 'text');
                messages.push({ isUser: false, text: data.response, type: 'text', content: data.response });
                saveHistory();
            } else {
                appendMessage("Kechirasiz, serverda xatolik yuz berdi (API Error).", false, 'text');
            }

        } catch (error) {
            loader.remove();
            console.error('Error:', error);
            appendMessage("Tarmoq xatoligi. Server ishlamayapti yoki internet yo'q.", false, 'text');
        }
    };

    document.getElementById('chat-form').addEventListener('submit', (e) => {
        e.preventDefault();
        if(userInput.value.trim()) handleSend(userInput.value.trim());
    });

    uploadBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', (e) => {
        const file = e.target.files[0];
        if (file) {
            const reader = new FileReader();
            reader.onload = (e) => handleSend(e.target.result, 'image');
            reader.readAsDataURL(file);
        }
    });

    micBtn.addEventListener('click', () => {
        micBtn.classList.add('text-red-500', 'animate-pulse');
        setTimeout(() => {
            micBtn.classList.remove('text-red-500', 'animate-pulse');
            handleSend('dummy-voice', 'voice');
        }, 1000);
    });

    newChatBtn.addEventListener('click', () => {
        messagesArea.innerHTML = ''; 
        welcomeScreen.classList.remove('hidden');
        setTimeout(() => welcomeScreen.classList.remove('opacity-0', 'pointer-events-none'), 10);
        toggleMenu(false);
    });

    clearHistoryBtn.addEventListener('click', () => {
        if(confirm("Tarixni o'chirasizmi?")) {
            localStorage.removeItem('chatHistory');
            messages = [];
            messagesArea.innerHTML = '';
            renderHistoryList();
            toggleWelcomeScreen();
            toggleMenu(false);
        }
    });

    // Initial Render
    if (messages.length > 0) {
        welcomeScreen.classList.add('hidden');
        messages.forEach(msg => appendMessage(msg.content, msg.isUser, msg.type));
        renderHistoryList();
    }
});