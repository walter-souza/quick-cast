// Constantes e Estados da Aplicação
const PEER_PREFIX = "streamshare-room-"; // Prefixo para evitar conflito de IDs globais no PeerJS Cloud
let peer = null;
let localStream = null;
let activeConnections = new Set(); // Para o Streamer rastrear viewers ativos
let streamWatchdogInterval = null;
let lastDataReceivedTime = 0;

// Função para sanitizar HTML (prevenção de XSS)
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, 
        tag => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            "'": '&#39;',
            '"': '&quot;'
        }[tag] || tag)
    );
}

// Função para gerar ID de sala seguro e puramente alfanumérico (compatibilidade máxima com sinalização)
function generateSecureRoomId() {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    const array = new Uint8Array(16);
    crypto.getRandomValues(array);
    return Array.from(array, b => chars[b % chars.length]).join('');
}

// Referências de Elementos do DOM
const setupSection = document.getElementById('setup-section');
const streamerSection = document.getElementById('streamer-section');
const viewerSection = document.getElementById('viewer-section');

const selectStreamer = document.getElementById('select-streamer');
const selectViewer = document.getElementById('select-viewer');
const streamerForm = document.getElementById('streamer-form');
const viewerForm = document.getElementById('viewer-form');

const streamerRoomInput = document.getElementById('streamer-room-input');
const btnStartStream = document.getElementById('btn-start-stream');
const btnStopStream = document.getElementById('btn-stop-stream');
const streamerStatusBadge = document.getElementById('streamer-status-badge');
const streamerStatusText = document.getElementById('streamer-status-text');
const streamerViewersCount = document.getElementById('streamer-viewers-count');
const shareLinkInput = document.getElementById('share-link-input');
const btnCopyLink = document.getElementById('btn-copy-link');
const selectStreamQuality = document.getElementById('select-stream-quality');

const viewerRoomInput = document.getElementById('viewer-room-input');
const btnConnectViewer = document.getElementById('btn-connect-viewer');
const btnDisconnectViewer = document.getElementById('btn-disconnect-viewer');
const btnTheaterMode = document.getElementById('btn-theater-mode');
const viewerStatusBadge = document.getElementById('viewer-status-badge');
const viewerStatusText = document.getElementById('viewer-status-text');
const viewerVideo = document.getElementById('viewer-video');
const viewerPlaceholder = document.getElementById('viewer-placeholder');
const viewerPlaceholderText = document.getElementById('viewer-placeholder-text');
const btnUnmuteViewer = document.getElementById('btn-unmute-viewer');

const toast = document.getElementById('toast');
const btnBackElements = document.querySelectorAll('.btn-back');

// --- EFEITOS DE TRANSIÇÃO E INTERFACE ---

// Exibe mensagem temporária (Toast)
function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 4000);
}

// Navegação entre seções
function showSection(section) {
    [setupSection, streamerSection, viewerSection].forEach(s => s.classList.remove('active'));
    section.classList.add('active');
    
    // Ajusta o tamanho do container se estiver transmitindo com o mixer
    const container = document.querySelector('.container');
    if (section === streamerSection) {
        container.classList.add('studio-mode');
    } else {
        container.classList.remove('studio-mode');
    }
}

// Configura volta para a tela inicial
btnBackElements.forEach(btn => {
    btn.addEventListener('click', () => {
        viewerForm.classList.add('hidden');
        selectStreamer.parentNode.classList.remove('hidden');
    });
});

// Seleção do Card Streamer (Estúdio OBS)
selectStreamer.addEventListener('click', () => {
    showSection(streamerSection);
    streamerRoomInput.value = generateSecureRoomId();
    setTimeout(initOBSStudio, 150);
});

// Seleção do Card Viewer
selectViewer.addEventListener('click', () => {
    selectViewer.parentNode.classList.add('hidden');
    viewerForm.classList.remove('hidden');
    viewerRoomInput.focus();
});

// Copiar Link da Transmissão
btnCopyLink.addEventListener('click', () => {
    shareLinkInput.select();
    shareLinkInput.setSelectionRange(0, 99999); // Para dispositivos móveis
    navigator.clipboard.writeText(shareLinkInput.value)
        .then(() => showToast("Link copiado para a área de transferência! 📋"))
        .catch(() => showToast("Erro ao copiar link."));
});

// --- ESTADO DO STUDIO WEB (SCENES E SOURCES) ---
let scenes = [
    {
        id: 'scene-default',
        name: 'Cena 1',
        sources: []
    }
];
let activeSceneId = 'scene-default';
let selectedSourceId = null;

// Canvases
let previewCanvas = null;
let previewCtx = null;
let composerCanvas = null;
let composerCtx = null;

// Mixer de áudio
let audioContext = null;
let audioDestination = null;

// Configuração de qualidade
const QUALITY_PROFILES = {
    '720p': { width: 1280, height: 720, fps: 30, bitrate: 1500 },
    '1080p': { width: 1920, height: 1080, fps: 30, bitrate: 3000 },
    'max': { width: 1920, height: 1080, fps: 60, bitrate: 6000 }
};

function getSelectedQualityProfile() {
    const key = selectStreamQuality.value;
    return QUALITY_PROFILES[key] || QUALITY_PROFILES['720p'];
}

function initAudioContext() {
    if (!audioContext) {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        audioContext = new AudioContextClass();
        audioDestination = audioContext.createMediaStreamDestination();
    }
    if (audioContext.state === 'suspended') {
        audioContext.resume();
    }
}

function setupAudioNode(source) {
    if (!source.stream || source.stream.getAudioTracks().length === 0) return;
    
    initAudioContext();
    
    try {
        const audioSourceNode = audioContext.createMediaStreamSource(source.stream);
        const gainNode = audioContext.createGain();
        const analyserNode = audioContext.createAnalyser();
        
        analyserNode.fftSize = 256;
        gainNode.gain.value = source.volume;
        
        audioSourceNode.connect(gainNode);
        gainNode.connect(analyserNode);
        analyserNode.connect(audioDestination);
        
        source.audioSourceNode = audioSourceNode;
        source.gainNode = gainNode;
        source.analyserNode = analyserNode;
    } catch (e) {
        console.error("Erro ao inicializar nó de áudio no Mixer Web:", e);
    }
}

function activeScene() {
    return scenes.find(s => s.id === activeSceneId);
}

function showPlaceholder() {
    document.getElementById('streamer-placeholder').classList.remove('hidden');
}

function hidePlaceholder() {
    document.getElementById('streamer-placeholder').classList.add('hidden');
}

function renderScenes() {
    const list = document.getElementById('scenes-list');
    if (!list) return;
    list.innerHTML = '';
    
    scenes.forEach(scene => {
        const item = document.createElement('div');
        item.className = `panel-item ${scene.id === activeSceneId ? 'selected' : ''}`;
        item.innerHTML = `<span>🎬 ${scene.name}</span>`;
        item.addEventListener('click', () => {
            activeSceneId = scene.id;
            selectedSourceId = null;
            renderScenes();
            renderSources();
            renderMixer();
            if (scene.sources.length === 0) {
                showPlaceholder();
            } else {
                hidePlaceholder();
            }
        });
        list.appendChild(item);
    });
}

function renderSources() {
    const list = document.getElementById('sources-list');
    if (!list) return;
    list.innerHTML = '';
    
    const scene = activeScene();
    if (!scene) return;
    
    const sortedSources = [...scene.sources].sort((a, b) => b.zIndex - a.zIndex);
    
    sortedSources.forEach(src => {
        const item = document.createElement('div');
        item.className = `panel-item ${src.id === selectedSourceId ? 'selected' : ''}`;
        
        let typeIcon = '🖥️';
        if (src.type === 'webcam') typeIcon = '📷';
        
        item.innerHTML = `
            <div class="item-meta">
                <input type="checkbox" id="chk-vis-${src.id}" ${src.visible ? 'checked' : ''}>
                <span>${typeIcon} ${escapeHTML(src.name)}</span>
            </div>
        `;
        
        item.addEventListener('click', (e) => {
            if (e.target.type !== 'checkbox') {
                selectedSourceId = src.id;
                renderSources();
            }
        });
        
        const chk = item.querySelector(`#chk-vis-${src.id}`);
        chk.addEventListener('change', (e) => {
            src.visible = e.target.checked;
        });
        
        list.appendChild(item);
    });
}

function renderMixer() {
    const list = document.getElementById('mixer-list');
    if (!list) return;
    list.innerHTML = '';
    
    const scene = activeScene();
    if (!scene) return;
    
    scene.sources.forEach(src => {
        if (!src.stream || src.stream.getAudioTracks().length === 0) return;
        
        const channel = document.createElement('div');
        channel.className = 'mixer-channel';
        
        let typeIcon = '🎙️';
        if (src.type === 'screen') typeIcon = '🔊';
        
        channel.innerHTML = `
            <div class="channel-header">
                <span>${typeIcon} ${escapeHTML(src.name)}</span>
                <span id="vol-lbl-${src.id}">${Math.round(src.volume * 100)}%</span>
            </div>
            <div class="channel-controls">
                <button class="btn-mute" id="btn-mute-${src.id}">${src.muted ? '🔇' : '🔊'}</button>
                <input type="range" class="channel-fader" id="fader-${src.id}" min="0" max="1" step="0.05" value="${src.muted ? 0 : src.volume}">
            </div>
            <div class="vu-container">
                <div class="vu-bar" id="vu-bar-${src.id}"></div>
            </div>
        `;
        
        const fader = channel.querySelector(`#fader-${src.id}`);
        fader.addEventListener('input', (e) => {
            const vol = parseFloat(e.target.value);
            src.volume = vol;
            src.muted = false;
            channel.querySelector(`#btn-mute-${src.id}`).textContent = '🔊';
            channel.querySelector(`#vol-lbl-${src.id}`).textContent = `${Math.round(vol * 100)}%`;
            if (src.gainNode) {
                src.gainNode.gain.value = vol;
            }
        });
        
        const btnMute = channel.querySelector(`#btn-mute-${src.id}`);
        btnMute.addEventListener('click', () => {
            src.muted = !src.muted;
            btnMute.textContent = src.muted ? '🔇' : '🔊';
            const targetVol = src.muted ? 0 : src.volume;
            fader.value = targetVol;
            if (src.gainNode) {
                src.gainNode.gain.value = targetVol;
            }
        });
        
        list.appendChild(channel);
    });
}

// --- CAPTURA DE FONTES NO WEB CLIENT ---
async function addWebcamSource() {
    try {
        initAudioContext();
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (e) {
            console.warn("Sem acesso ao microfone da Webcam, usando apenas vídeo.", e);
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
        
        const sourceId = 'source-' + Math.random().toString(36).substr(2, 9);
        const source = {
            id: sourceId,
            name: `Webcam ${activeScene().sources.length + 1}`,
            type: 'webcam',
            stream: stream,
            videoElement: document.createElement('video'),
            x: 50,
            y: 50,
            width: 320,
            height: 240,
            zIndex: activeScene().sources.length + 1,
            visible: true,
            muted: false,
            volume: 0.8
        };
        
        source.videoElement.srcObject = stream;
        source.videoElement.muted = true;
        source.videoElement.playsInline = true;
        await source.videoElement.play();
        
        setupAudioNode(source);
        
        activeScene().sources.push(source);
        selectedSourceId = sourceId;
        renderSources();
        renderMixer();
        showToast("Webcam adicionada com sucesso!");
        hidePlaceholder();
    } catch (err) {
        console.error("Erro ao adicionar webcam:", err);
        showToast("Falha ao abrir webcam: " + err.message);
    }
}

async function addDisplaySource() {
    const profile = getSelectedQualityProfile();
    try {
        initAudioContext();
        
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                frameRate: { ideal: profile.fps, max: 60 }
            },
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });
        
        const sourceId = 'source-' + Math.random().toString(36).substr(2, 9);
        const source = {
            id: sourceId,
            name: `Tela/Janela ${activeScene().sources.length + 1}`,
            type: 'screen',
            stream: stream,
            videoElement: document.createElement('video'),
            x: 0,
            y: 0,
            width: 1280,
            height: 720,
            zIndex: activeScene().sources.length + 1,
            visible: true,
            muted: false,
            volume: 0.8
        };
        
        source.videoElement.srcObject = stream;
        source.videoElement.muted = true;
        source.videoElement.playsInline = true;
        await source.videoElement.play();
        
        stream.getVideoTracks()[0].onended = () => {
            selectedSourceId = sourceId;
            deleteActiveSource();
            showToast("Compartilhamento de tela finalizado.");
        };
        
        setupAudioNode(source);
        
        activeScene().sources.push(source);
        selectedSourceId = sourceId;
        renderSources();
        renderMixer();
        showToast("Fonte de tela adicionada com sucesso!");
        hidePlaceholder();
    } catch (err) {
        console.error("Erro ao capturar display:", err);
        showToast("Cancelado ou falha ao iniciar captura de tela.");
    }
}

function deleteActiveSource() {
    if (!selectedSourceId) {
        showToast("Nenhuma fonte selecionada.");
        return;
    }
    const scene = activeScene();
    const idx = scene.sources.findIndex(s => s.id === selectedSourceId);
    if (idx === -1) return;
    
    const src = scene.sources[idx];
    if (src.stream) {
        src.stream.getTracks().forEach(t => t.stop());
    }
    if (src.audioSourceNode) src.audioSourceNode.disconnect();
    if (src.gainNode) src.gainNode.disconnect();
    
    scene.sources.splice(idx, 1);
    selectedSourceId = null;
    
    renderSources();
    renderMixer();
    
    if (scene.sources.length === 0) {
        showPlaceholder();
    }
}

function moveSourceZ(direction) {
    if (!selectedSourceId) return;
    const scene = activeScene();
    
    const sorted = [...scene.sources].sort((a, b) => a.zIndex - b.zIndex);
    const idx = sorted.findIndex(s => s.id === selectedSourceId);
    const src = scene.sources.find(s => s.id === selectedSourceId);
    
    if (direction === 'up' && idx < sorted.length - 1) {
        const next = sorted[idx + 1];
        const temp = src.zIndex;
        src.zIndex = next.zIndex;
        next.zIndex = temp;
    } else if (direction === 'down' && idx > 0) {
        const prev = sorted[idx - 1];
        const temp = src.zIndex;
        src.zIndex = prev.zIndex;
        prev.zIndex = temp;
    }
    
    renderSources();
}

// --- RENDERIZAÇÃO DO COMPOSER CANVAS EM LOOP ---
let isRendering = false;
let renderWorker = null;

function startRenderLoop() {
    if (isRendering) return;
    isRendering = true;
    
    function draw() {
        if (!isRendering) return;
        
        composerCtx.fillStyle = '#000000';
        composerCtx.fillRect(0, 0, composerCanvas.width, composerCanvas.height);
        
        const scene = activeScene();
        if (scene) {
            const sortedSources = [...scene.sources].sort((a, b) => a.zIndex - b.zIndex);
            sortedSources.forEach(src => {
                if (src.visible && src.videoElement && src.videoElement.readyState >= 2) {
                    composerCtx.drawImage(src.videoElement, src.x, src.y, src.width, src.height);
                }
            });
        }
        
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        previewCtx.drawImage(composerCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
        
        if (scene && selectedSourceId) {
            const src = scene.sources.find(s => s.id === selectedSourceId);
            if (src && src.visible) {
                drawSelectionBorder(src);
            }
        }
    }
    
    const profile = getSelectedQualityProfile();
    const fps = profile.fps || 30;
    
    try {
        const blob = new Blob([
            `let intervalId = null;
            self.onmessage = function(e) {
                if (e.data.action === 'start') {
                    if (intervalId) clearInterval(intervalId);
                    intervalId = setInterval(function() {
                        self.postMessage('tick');
                    }, 1000 / e.data.fps);
                } else if (e.data.action === 'stop') {
                    if (intervalId) {
                        clearInterval(intervalId);
                        intervalId = null;
                    }
                }
            };`
        ], { type: 'application/javascript' });
        
        renderWorker = new Worker(URL.createObjectURL(blob));
        renderWorker.onmessage = (e) => {
            if (e.data === 'tick') {
                draw();
            }
        };
        renderWorker.postMessage({ action: 'start', fps: fps });
    } catch (err) {
        console.warn("Falha ao inicializar Web Worker ticker, usando fallback requestAnimationFrame:", err);
        function loop() {
            if (!isRendering) return;
            draw();
            requestAnimationFrame(loop);
        }
        requestAnimationFrame(loop);
    }
}

const HANDLE_SIZE = 10;

function getHandles(src) {
    const x = src.x;
    const y = src.y;
    const w = src.width;
    const h = src.height;
    
    return {
        nw: { x: x, y: y },
        n:  { x: x + w/2, y: y },
        ne: { x: x + w, y: y },
        e:  { x: x + w, y: y + h/2 },
        se: { x: x + w, y: y + h },
        s:  { x: x + w/2, y: y + h },
        sw: { x: x, y: y + h },
        w:  { x: x, y: y + h/2 }
    };
}

function drawSelectionBorder(src) {
    previewCtx.strokeStyle = '#3b82f6';
    previewCtx.lineWidth = 3;
    previewCtx.strokeRect(src.x, src.y, src.width, src.height);
    
    previewCtx.fillStyle = '#ffffff';
    previewCtx.strokeStyle = '#3b82f6';
    previewCtx.lineWidth = 2;
    
    const handles = getHandles(src);
    for (const key in handles) {
        const pt = handles[key];
        previewCtx.fillRect(pt.x - HANDLE_SIZE/2, pt.y - HANDLE_SIZE/2, HANDLE_SIZE, HANDLE_SIZE);
        previewCtx.strokeRect(pt.x - HANDLE_SIZE/2, pt.y - HANDLE_SIZE/2, HANDLE_SIZE, HANDLE_SIZE);
    }
}

// --- DRAG & RESIZE CANVAS ---
let interactionMode = null;
let resizeHandle = null;
let startMousePos = { x: 0, y: 0 };
let startSourceRect = { x: 0, y: 0, w: 0, h: 0 };

function initMouseEvents() {
    const canvasContextMenu = document.getElementById('canvas-context-menu');

    previewCanvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const scene = activeScene();
        if (!scene) return;
        
        const rect = previewCanvas.getBoundingClientRect();
        const scaleX = previewCanvas.width / rect.width;
        const scaleY = previewCanvas.height / rect.height;
        const mX = (e.clientX - rect.left) * scaleX;
        const mY = (e.clientY - rect.top) * scaleY;
        
        // Procura qual fonte foi clicada com o botão direito (do topo para o fundo)
        const sortedSources = [...scene.sources].sort((a, b) => b.zIndex - a.zIndex);
        let clickedSource = null;
        for (const src of sortedSources) {
            if (src.visible && mX >= src.x && mX <= src.x + src.width &&
                mY >= src.y && mY <= src.y + src.height) {
                clickedSource = src;
                break;
            }
        }
        
        if (clickedSource) {
            selectedSourceId = clickedSource.id;
            renderSources();
            
            // Exibe o menu na posição fixa do clique
            canvasContextMenu.style.left = `${e.clientX}px`;
            canvasContextMenu.style.top = `${e.clientY}px`;
            canvasContextMenu.classList.remove('hidden');
        } else {
            canvasContextMenu.classList.add('hidden');
        }
    });

    document.addEventListener('click', (e) => {
        if (!canvasContextMenu.contains(e.target)) {
            canvasContextMenu.classList.add('hidden');
        }
    });

    document.getElementById('menu-reset-size').addEventListener('click', () => {
        canvasContextMenu.classList.add('hidden');
        if (!selectedSourceId) return;
        const scene = activeScene();
        const src = scene.sources.find(s => s.id === selectedSourceId);
        if (src && src.videoElement) {
            const nw = src.videoElement.videoWidth || 320;
            const nh = src.videoElement.videoHeight || 240;
            src.width = nw;
            src.height = nh;
        }
    });

    document.getElementById('menu-fit-screen').addEventListener('click', () => {
        canvasContextMenu.classList.add('hidden');
        if (!selectedSourceId) return;
        const scene = activeScene();
        const src = scene.sources.find(s => s.id === selectedSourceId);
        if (src && src.videoElement) {
            const nw = src.videoElement.videoWidth || src.width;
            const nh = src.videoElement.videoHeight || src.height;
            const scaleX = 1280 / nw;
            const scaleY = 720 / nh;
            const scale = Math.min(scaleX, scaleY);
            
            const newW = nw * scale;
            const newH = nh * scale;
            src.x = (1280 - newW) / 2;
            src.y = (720 - newH) / 2;
            src.width = newW;
            src.height = newH;
        }
    });

    document.getElementById('menu-stretch-screen').addEventListener('click', () => {
        canvasContextMenu.classList.add('hidden');
        if (!selectedSourceId) return;
        const scene = activeScene();
        const src = scene.sources.find(s => s.id === selectedSourceId);
        if (src) {
            src.x = 0;
            src.y = 0;
            src.width = 1280;
            src.height = 720;
        }
    });

    previewCanvas.addEventListener('mousedown', (e) => {
        const scene = activeScene();
        if (!scene) return;
        
        const rect = previewCanvas.getBoundingClientRect();
        const scaleX = previewCanvas.width / rect.width;
        const scaleY = previewCanvas.height / rect.height;
        const mX = (e.clientX - rect.left) * scaleX;
        const mY = (e.clientY - rect.top) * scaleY;
        
        if (selectedSourceId) {
            const src = scene.sources.find(s => s.id === selectedSourceId);
            if (src && src.visible) {
                const handles = getHandles(src);
                for (const key in handles) {
                    const pt = handles[key];
                    if (mX >= pt.x - HANDLE_SIZE && mX <= pt.x + HANDLE_SIZE &&
                        mY >= pt.y - HANDLE_SIZE && mY <= pt.y + HANDLE_SIZE) {
                        interactionMode = 'resize';
                        resizeHandle = key;
                        startMousePos = { x: mX, y: mY };
                        startSourceRect = { x: src.x, y: src.y, w: src.width, h: src.height };
                        return;
                    }
                }
            }
        }
        
        const sortedSources = [...scene.sources].sort((a, b) => b.zIndex - a.zIndex);
        for (const src of sortedSources) {
            if (src.visible && mX >= src.x && mX <= src.x + src.width &&
                mY >= src.y && mY <= src.y + src.height) {
                selectedSourceId = src.id;
                interactionMode = 'drag';
                startMousePos = { x: mX, y: mY };
                startSourceRect = { x: src.x, y: src.y, w: src.width, h: src.height };
                renderSources();
                return;
            }
        }
        
        selectedSourceId = null;
        renderSources();
    });

    previewCanvas.addEventListener('mousemove', (e) => {
        if (!interactionMode || !selectedSourceId) return;
        
        const scene = activeScene();
        if (!scene) return;
        const src = scene.sources.find(s => s.id === selectedSourceId);
        if (!src) return;
        
        const rect = previewCanvas.getBoundingClientRect();
        const scaleX = previewCanvas.width / rect.width;
        const scaleY = previewCanvas.height / rect.height;
        const mX = (e.clientX - rect.left) * scaleX;
        const mY = (e.clientY - rect.top) * scaleY;
        
        const dx = mX - startMousePos.x;
        const dy = mY - startMousePos.y;
        
        if (interactionMode === 'drag') {
            src.x = startSourceRect.x + dx;
            src.y = startSourceRect.y + dy;
        } else if (interactionMode === 'resize') {
            const sX = startSourceRect.x;
            const sY = startSourceRect.y;
            const sW = startSourceRect.w;
            const sH = startSourceRect.h;
            
            switch (resizeHandle) {
                case 'se':
                    src.width = Math.max(20, sW + dx);
                    src.height = Math.max(20, sH + dy);
                    break;
                case 'sw':
                    src.x = Math.min(sX + dx, sX + sW - 20);
                    src.width = sW + (sX - src.x);
                    src.height = Math.max(20, sH + dy);
                    break;
                case 'ne':
                    src.y = Math.min(sY + dy, sY + sH - 20);
                    src.width = Math.max(20, sW + dx);
                    src.height = sH + (sY - src.y);
                    break;
                case 'nw':
                    src.x = Math.min(sX + dx, sX + sW - 20);
                    src.y = Math.min(sY + dy, sY + sH - 20);
                    src.width = sW + (sX - src.x);
                    src.height = sH + (sY - src.y);
                    break;
                case 'e':
                    src.width = Math.max(20, sW + dx);
                    break;
                case 'w':
                    src.x = Math.min(sX + dx, sX + sW - 20);
                    src.width = sW + (sX - src.x);
                    break;
                case 's':
                    src.height = Math.max(20, sH + dy);
                    break;
                case 'n':
                    src.y = Math.min(sY + dy, sY + sH - 20);
                    src.height = sH + (sY - src.y);
                    break;
            }
        }
    });

    window.addEventListener('mouseup', () => {
        interactionMode = null;
        resizeHandle = null;
    });
}

// --- VU LOOP ---
let vuInterval = null;

function startVULoop() {
    if (vuInterval) clearInterval(vuInterval);
    
    vuInterval = setInterval(() => {
        const scene = activeScene();
        if (!scene) return;
        
        scene.sources.forEach(src => {
            const vuBar = document.getElementById(`vu-bar-${src.id}`);
            if (!vuBar) return;
            
            if (src.analyserNode && src.visible && !src.muted) {
                const array = new Uint8Array(src.analyserNode.frequencyBinCount);
                src.analyserNode.getByteFrequencyData(array);
                
                let sum = 0;
                for (let i = 0; i < array.length; i++) {
                    sum += array[i];
                }
                const average = sum / array.length;
                const percent = Math.min(100, Math.round((average / 110) * 100));
                vuBar.style.width = `${percent}%`;
            } else {
                vuBar.style.width = '0%';
            }
        });
    }, 50);
}

// --- BITRATE LIMITS ---
function applyBitrateLimit(bitrateBps) {
    if (!peer) return;

    for (const peerId in peer.connections) {
        const connections = peer.connections[peerId];
        connections.forEach(conn => {
            if (conn.peerConnection) {
                const senders = conn.peerConnection.getSenders();
                const videoSender = senders.find(s => s.track && s.track.kind === 'video');
                if (videoSender) {
                    try {
                        const params = videoSender.getParameters();
                        if (!params.encodings) {
                            params.encodings = [{}];
                        }
                        if (bitrateBps) {
                            params.encodings[0].maxBitrate = bitrateBps;
                        } else {
                            delete params.encodings[0].maxBitrate;
                        }
                        videoSender.setParameters(params);
                        console.log(`Bitrate definido para ${bitrateBps ? bitrateBps / 1000 + 'kbps' : 'ilimitado'} no viewer ${peerId}`);
                    } catch (err) {
                        console.error("Erro ao definir parâmetros de bitrate:", err);
                    }
                }
            }
        });
    }
}

const QUALITY_BITRATE_SETTINGS = {
    '720p': 1500000,
    '1080p': 3000000,
    'max': null
};

async function applyQualitySettings(qualityKey) {
    const profile = QUALITY_PROFILES[qualityKey];
    if (!profile) return;

    if (composerCanvas) {
        const oldWidth = composerCanvas.width;
        const oldHeight = composerCanvas.height;
        const newWidth = profile.width;
        const newHeight = profile.height;

        if (oldWidth !== newWidth || oldHeight !== newHeight) {
            // Atualiza tamanho do canvas do mixer
            composerCanvas.width = newWidth;
            composerCanvas.height = newHeight;

            // Redimensiona as fontes proporcionalmente para manter o layout no canvas
            const scaleX = newWidth / oldWidth;
            const scaleY = newHeight / oldHeight;
            
            scenes.forEach(s => {
                s.sources.forEach(src => {
                    src.x = Math.round(src.x * scaleX);
                    src.y = Math.round(src.y * scaleY);
                    src.width = Math.round(src.width * scaleX);
                    src.height = Math.round(src.height * scaleY);
                });
            });
            console.log(`Canvas redimensionado de ${oldWidth}x${oldHeight} para ${newWidth}x${newHeight}`);
        }
    }

    // Se estiver transmitindo, aplica no WebRTC e no worker
    if (localStream) {
        // Atualiza taxa de frames no worker do renderizador
        if (renderWorker) {
            renderWorker.postMessage({ action: 'start', fps: profile.fps });
        }

        // Aplica o limite de bitrate
        const bps = QUALITY_BITRATE_SETTINGS[qualityKey];
        applyBitrateLimit(bps);
        
        showToast(`Qualidade alterada para ${qualityKey} em tempo real! ⚙️`);
    }
}

selectStreamQuality.addEventListener('change', (e) => {
    applyQualitySettings(e.target.value);
});

// --- RENDER INICIALIZAÇÃO OBS E BINDINGS ---
function initOBSStudio() {
    previewCanvas = document.getElementById('preview-canvas');
    previewCtx = previewCanvas.getContext('2d');
    composerCanvas = document.getElementById('composer-canvas');
    composerCtx = composerCanvas.getContext('2d');
    
    const profile = getSelectedQualityProfile();
    previewCanvas.width = 1280;
    previewCanvas.height = 720;
    composerCanvas.width = profile.width;
    composerCanvas.height = profile.height;
    
    // Bind buttons
    document.getElementById('btn-add-scene').onclick = () => {
        const name = `Cena ${scenes.length + 1}`;
        const id = 'scene-' + Date.now();
        scenes.push({ id, name: name, sources: [] });
        activeSceneId = id;
        selectedSourceId = null;
        renderScenes();
        renderSources();
        renderMixer();
        showPlaceholder();
    };
    
    document.getElementById('btn-del-scene').onclick = () => {
        if (confirm("Deseja remover esta cena?")) {
            if (scenes.length <= 1) {
                showToast("Não é possível remover a única cena.");
                return;
            }
            const idx = scenes.findIndex(s => s.id === activeSceneId);
            scenes[idx].sources.forEach(src => {
                if (src.stream) src.stream.getTracks().forEach(t => t.stop());
                if (src.audioSourceNode) src.audioSourceNode.disconnect();
                if (src.gainNode) src.gainNode.disconnect();
            });
            scenes.splice(idx, 1);
            activeSceneId = scenes[0].id;
            selectedSourceId = null;
            renderScenes();
            renderSources();
            renderMixer();
            if (activeScene().sources.length === 0) showPlaceholder();
        }
    };
    
    const addSourceMenuBtn = document.getElementById('btn-add-source-menu');
    const addSourceDropdown = document.getElementById('add-source-dropdown');

    addSourceMenuBtn.onclick = (e) => {
        e.stopPropagation();
        addSourceDropdown.classList.toggle('show');
    };

    document.addEventListener('click', (e) => {
        if (!addSourceDropdown.contains(e.target) && e.target !== addSourceMenuBtn) {
            addSourceDropdown.classList.remove('show');
        }
    });

    document.getElementById('add-source-webcam').onclick = () => {
        addSourceDropdown.classList.remove('show');
        addWebcamSource();
    };
    document.getElementById('add-source-display').onclick = () => {
        addSourceDropdown.classList.remove('show');
        addDisplaySource();
    };
    
    document.getElementById('btn-del-source').onclick = deleteActiveSource;
    document.getElementById('btn-source-up').onclick = () => moveSourceZ('up');
    document.getElementById('btn-source-down').onclick = () => moveSourceZ('down');
    
    initMouseEvents();
    renderScenes();
    renderSources();
    renderMixer();
    startRenderLoop();
    startVULoop();
    showPlaceholder();
}

// --- STREAMER FLOW INICIAR E PARAR ---

async function startStreaming(roomId) {
    if (!roomId) {
        showToast("Por favor, digite ou gere um código de sala.");
        return;
    }

    const cleanRoomId = roomId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!cleanRoomId) {
        showToast("Código inválido. Use apenas letras, números, hífen e sublinhado.");
        return;
    }

    const scene = activeScene();
    if (!scene || scene.sources.length === 0) {
        showToast("Por favor, adicione pelo menos uma fonte de vídeo para transmitir.");
        return;
    }

    const peerId = PEER_PREFIX + cleanRoomId;
    btnStartStream.disabled = true;
    btnStartStream.textContent = "Iniciando Mixer...";

    try {
        initAudioContext();
        
        const profile = getSelectedQualityProfile();
        composerCanvas.width = profile.width;
        composerCanvas.height = profile.height;
        
        const canvasStream = composerCanvas.captureStream(profile.fps);
        const tracks = [...canvasStream.getVideoTracks()];
        
        if (audioDestination && audioDestination.stream.getAudioTracks().length > 0) {
            tracks.push(audioDestination.stream.getAudioTracks()[0]);
        }
        
        localStream = new MediaStream(tracks);

        await applyQualitySettings(selectStreamQuality.value);

        peer = new Peer(peerId);

        peer.on('open', (id) => {
            streamerStatusBadge.className = "badge badge-live";
            streamerStatusBadge.textContent = "LIVE";
            streamerStatusText.textContent = `Transmitindo sala: ${cleanRoomId}`;
            
            const shareUrl = `${window.location.origin}${window.location.pathname}?room=${cleanRoomId}`;
            shareLinkInput.value = shareUrl;
            
            document.getElementById('share-panel').classList.remove('hidden');
            
            btnStartStream.disabled = true;
            btnStartStream.textContent = "Iniciar Transmissão";
            btnStopStream.disabled = false;
            
            streamerRoomInput.disabled = true;
            document.getElementById('btn-back-to-menu').disabled = true;

            showToast("Transmissão com mixer OBS iniciada! 🚀");
            activeConnections.clear();
            updateViewerCount();
        });

        peer.on('connection', (conn) => {
            if (activeConnections.size >= 5) {
                conn.on('open', () => {
                    conn.close();
                });
                showToast("Conexão recusada: limite de 5 espectadores atingido.");
                return;
            }
            activeConnections.add(conn);
            updateViewerCount();

            conn.on('open', () => {
                const call = peer.call(conn.peer, localStream);
                
                setTimeout(() => {
                    const currentQuality = selectStreamQuality.value;
                    const settings = QUALITY_PROFILES[currentQuality];
                    applyBitrateLimit(settings.bitrate * 1000);
                }, 1000);

                conn.on('close', () => {
                    activeConnections.delete(conn);
                    updateViewerCount();
                });
            });

            conn.on('error', (err) => {
                console.error("Erro na conexão com o viewer:", err);
                activeConnections.delete(conn);
                updateViewerCount();
            });
        });

        peer.on('error', (err) => {
            console.error("Erro no PeerJS do Streamer:", err);
            if (err.type === 'unavailable-id') {
                showToast("Este código de sala já está ativo em outra transmissão. Escolha outro!");
            } else {
                showToast(`Erro de conexão: ${err.type}`);
            }
            stopStreaming();
        });

    } catch (err) {
        console.error("Erro ao iniciar mixer e sinalização:", err);
        showToast("Erro ao iniciar mixer de vídeo/áudio.");
        stopStreaming();
    }
}

function stopStreaming() {
    if (peer) {
        peer.destroy();
        peer = null;
    }
    
    scenes.forEach(s => {
        s.sources.forEach(src => {
            if (src.stream) src.stream.getTracks().forEach(t => t.stop());
            if (src.audioSourceNode) src.audioSourceNode.disconnect();
            if (src.gainNode) src.gainNode.disconnect();
        });
        s.sources = [];
    });
    
    if (vuInterval) {
        clearInterval(vuInterval);
        vuInterval = null;
    }
    
    if (renderWorker) {
        renderWorker.postMessage({ action: 'stop' });
        renderWorker.terminate();
        renderWorker = null;
    }
    isRendering = false;
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    activeConnections.clear();
    resetStreamerUI();
    showSection(setupSection);
}

function resetStreamerUI() {
    btnStartStream.disabled = false;
    btnStartStream.textContent = "Iniciar Transmissão";
    btnStopStream.disabled = true;
    
    streamerRoomInput.disabled = false;
    selectStreamQuality.disabled = false;
    document.getElementById('btn-back-to-menu').disabled = false;
    
    document.getElementById('share-panel').classList.add('hidden');
    
    streamerStatusBadge.className = "badge badge-offline";
    streamerStatusBadge.textContent = "Offline";
    streamerStatusText.textContent = "Pronto";
    streamerViewersCount.textContent = "0";
    shareLinkInput.value = "";
    showPlaceholder();
}

function updateViewerCount() {
    streamerViewersCount.textContent = activeConnections.size;
}

btnStartStream.addEventListener('click', () => {
    startStreaming(streamerRoomInput.value);
});

btnStopStream.addEventListener('click', stopStreaming);

document.getElementById('btn-back-to-menu').addEventListener('click', () => {
    stopStreaming();
});

selectStreamer.addEventListener('click', () => {
    setTimeout(initOBSStudio, 150);
});

// --- LÓGICA DO VIEWER ---

// Monitoramento de inatividade do stream (Watchdog)
function startStreamWatchdog() {
    lastDataReceivedTime = Date.now();
    
    if (streamWatchdogInterval) {
        clearInterval(streamWatchdogInterval);
    }

    streamWatchdogInterval = setInterval(() => {
        // Ignora a contagem se o próprio espectador pausou o player voluntariamente
        if (viewerVideo.paused && viewerVideo.srcObject) {
            lastDataReceivedTime = Date.now();
            return;
        }

        const secondsInactive = (Date.now() - lastDataReceivedTime) / 1000;
        if (secondsInactive >= 30) {
            console.warn("Nenhum dado de transmissão recebido por 30 segundos. Desconectando.");
            showToast("Transmissão interrompida (30s sem novos dados).");
            disconnectViewer();
        }
    }, 2000);
}

function stopStreamWatchdog() {
    if (streamWatchdogInterval) {
        clearInterval(streamWatchdogInterval);
        streamWatchdogInterval = null;
    }
}

function connectToStream(roomId) {
    if (!roomId) {
        showToast("Código de sala inválido.");
        return;
    }

    startStreamWatchdog();

    const cleanRoomId = roomId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    const streamerPeerId = PEER_PREFIX + cleanRoomId;

    showSection(viewerSection);
    viewerStatusBadge.className = "badge badge-offline";
    viewerStatusBadge.textContent = "Conectando";
    viewerStatusText.textContent = "Conectando ao servidor...";
    viewerPlaceholderText.textContent = "Buscando transmissão...";
    btnUnmuteViewer.classList.add('hidden');

    // Inicializa o Peer do Viewer (com ID aleatório gerado pelo servidor)
    peer = new Peer();

    peer.on('open', () => {
        viewerStatusText.textContent = "Procurando streamer...";
        // Conecta ao canal de dados do Streamer para avisar que está online
        const conn = peer.connect(streamerPeerId);

        conn.on('open', () => {
            viewerStatusBadge.className = "badge badge-live";
            viewerStatusBadge.textContent = "Conectado";
            viewerStatusText.textContent = "Conectado ao Streamer. Aguardando vídeo...";
            viewerPlaceholderText.textContent = "Conexão estabelecida! Carregando transmissão...";
        });

        conn.on('close', () => {
            showToast("O streamer encerrou a transmissão.");
            disconnectViewer();
        });
    });

    // Recebe a chamada (call) de vídeo do streamer
    peer.on('call', (call) => {
        call.answer(); // Responde sem enviar stream próprio

        call.on('stream', (remoteStream) => {
            // Evita reatribuir e interromper o play() se o stream já for o mesmo
            if (viewerVideo.srcObject && viewerVideo.srcObject.id === remoteStream.id) {
                return;
            }

            viewerStatusText.textContent = "Assistindo ao vivo";
            viewerVideo.srcObject = remoteStream;
            
            // Oculta o placeholder e tenta rodar o vídeo
            viewerPlaceholder.classList.add('hidden');
            
            viewerVideo.play().catch(err => {
                console.log("Autoplay bloqueado pelo navegador devido a áudio:", err);
                // Se o autoplay falhar, exibe botão de clique do usuário
                viewerPlaceholder.classList.remove('hidden');
                viewerPlaceholderText.textContent = "A transmissão está pronta, mas o navegador bloqueou o som automático.";
                btnUnmuteViewer.classList.remove('hidden');
            });
        });
    });

    peer.on('error', (err) => {
        console.error("Erro no PeerJS do Viewer:", err);
        if (err.type === 'peer-unavailable') {
            showToast("Sala não encontrada. Verifique se o código está correto e se o streamer está online.");
        } else {
            showToast(`Erro de conexão: ${err.type}`);
        }
        disconnectViewer();
    });
}

function disconnectViewer() {
    stopStreamWatchdog();
    if (peer) {
        peer.destroy();
        peer = null;
    }
    viewerVideo.srcObject = null;
    document.body.classList.remove('theater-mode');
    if (btnTheaterMode) {
        btnTheaterMode.textContent = "🎭 Modo Teatro";
    }
    resetViewerUI();
    showSection(setupSection);
}

function resetViewerUI() {
    viewerStatusBadge.className = "badge badge-offline";
    viewerStatusBadge.textContent = "Desconectado";
    viewerStatusText.textContent = "Conectando ao streamer...";
    viewerPlaceholder.classList.remove('hidden');
    viewerPlaceholderText.textContent = "Aguardando transmissão começar...";
    btnUnmuteViewer.classList.add('hidden');
    // Remove parâmetro ?room da URL para limpar o estado se o usuário voltar pro menu
    if (window.location.search.includes('room=')) {
        window.history.pushState({}, document.title, window.location.pathname);
    }
}

// Trata o botão de desmutar caso o autoplay seja bloqueado
btnUnmuteViewer.addEventListener('click', () => {
    lastDataReceivedTime = Date.now();
    viewerVideo.muted = false;
    viewerVideo.play()
        .then(() => {
            viewerPlaceholder.classList.add('hidden');
            btnUnmuteViewer.classList.add('hidden');
        })
        .catch(err => {
            showToast("Erro ao iniciar áudio: " + err.message);
        });
});

btnConnectViewer.addEventListener('click', () => {
    connectToStream(viewerRoomInput.value);
});

btnDisconnectViewer.addEventListener('click', disconnectViewer);

btnTheaterMode.addEventListener('click', () => {
    document.body.classList.toggle('theater-mode');
    if (document.body.classList.contains('theater-mode')) {
        btnTheaterMode.textContent = "📺 Modo Normal";
    } else {
        btnTheaterMode.textContent = "🎭 Modo Teatro";
    }
});

viewerVideo.addEventListener('timeupdate', () => {
    if (viewerVideo.currentTime > 0) {
        lastDataReceivedTime = Date.now();
    }
});


// --- AUTO-CONECTAR SE HOUVER PARÂMETRO NA URL ---

window.addEventListener('DOMContentLoaded', () => {
    const urlParams = new URLSearchParams(window.location.search);
    const roomParam = urlParams.get('room');
    if (roomParam) {
        viewerRoomInput.value = roomParam;
        // Pequeno timeout para garantir que o DOM e bibliotecas estão totalmente prontos
        setTimeout(() => {
            connectToStream(roomParam);
        }, 500);
    }
});
