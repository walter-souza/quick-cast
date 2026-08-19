// Constantes do PeerJS
const PEER_PREFIX = "streamshare-room-";
let peer = null;
let localStream = null;
const activeConnections = new Set(); // { conn }
const activeCalls = new Set(); // { call }

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

// --- ESTADO DO STUDIO (SCENES E SOURCES) ---
let scenes = [
    {
        id: 'scene-default',
        name: 'Cena 1',
        sources: []
    }
];
let activeSceneId = 'scene-default';
let selectedSourceId = null;

// --- ELEMENTOS E CANVASES DO DOM ---
const previewCanvas = document.getElementById('preview-canvas');
const previewCtx = previewCanvas.getContext('2d');
const composerCanvas = document.getElementById('composer-canvas');
const composerCtx = composerCanvas.getContext('2d');

const statusBadge = document.getElementById('status-badge');
const statusText = document.getElementById('status-text');
const roomInput = document.getElementById('room-input');
const qualitySelect = document.getElementById('quality-select');
const btnStart = document.getElementById('btn-start');
const btnStop = document.getElementById('btn-stop');
const viewerCountSpan = document.getElementById('viewer-count');
const bitrateValueSpan = document.getElementById('bitrate-value');
const sharePanel = document.getElementById('share-panel');
const shareUrlInput = document.getElementById('share-url');
const btnCopy = document.getElementById('btn-copy');
const toast = document.getElementById('toast');

// Picker Modal
const sourcePickerModal = document.getElementById('source-picker-modal');
const pickerModalTitle = document.getElementById('picker-modal-title');
const pickerSourcesList = document.getElementById('picker-sources-list');
const btnCancelPicker = document.getElementById('btn-cancel-picker');

// --- CONTROLES DE ÁUDIO WEB API ---
let audioContext = null;
let audioDestination = null;

// --- NOTIFICAÇÕES (TOAST) ---
function showToast(message) {
    toast.textContent = message;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 4000);
}

// --- CONFIGURAÇÃO DE QUALIDADE ---
const QUALITY_PROFILES = {
    '720p': { width: 1280, height: 720, fps: 30, bitrate: 1500 },
    '1080p': { width: 1920, height: 1080, fps: 30, bitrate: 3000 },
    'max': { width: 1920, height: 1080, fps: 60, bitrate: 6000 }
};

function getSelectedQualityProfile() {
    const key = qualitySelect.value;
    return QUALITY_PROFILES[key] || QUALITY_PROFILES['720p'];
}

qualitySelect.addEventListener('change', () => {
    const profile = getSelectedQualityProfile();
    bitrateValueSpan.textContent = `${profile.bitrate} Kbps`;
    
    if (localStream) {
        activeCalls.forEach(call => {
            if (call.peerConnection) {
                applyBitrateControl(call.peerConnection, profile.bitrate);
            }
        });
        showToast(`Qualidade de saída alterada para ${qualitySelect.value.toUpperCase()}!`);
    }
});

// --- CONTROLE DE BITRATE WEBRTC ---
function applyBitrateControl(peerConnection, maxBitrateKbps) {
    const senders = peerConnection.getSenders();
    const videoSender = senders.find(sender => sender.track && sender.track.kind === 'video');
    if (videoSender) {
        const parameters = videoSender.getParameters();
        if (!parameters.encodings) {
            parameters.encodings = [{}];
        }
        parameters.encodings[0].maxBitrate = maxBitrateKbps * 1000;
        videoSender.setParameters(parameters)
            .then(() => console.log(`Bitrate de vídeo limitado para: ${maxBitrateKbps} Kbps`))
            .catch(err => console.error("Erro ao aplicar controle de bitrate:", err));
    }
}

// --- CONFIGURAR ÁUDIO CONTEXT ---
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
        console.error("Erro ao inicializar nó de áudio no Mixer:", e);
    }
}

// --- AUXILIARES E GERENCIAMENTO DE ESTADO ---
function activeScene() {
    return scenes.find(s => s.id === activeSceneId);
}

function showPlaceholder() {
    document.getElementById('preview-placeholder').classList.remove('hidden');
}

function hidePlaceholder() {
    document.getElementById('preview-placeholder').classList.add('hidden');
}

function renderScenes() {
    const list = document.getElementById('scenes-list');
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
    list.innerHTML = '';
    
    const scene = activeScene();
    if (!scene) return;
    
    const sortedSources = [...scene.sources].sort((a, b) => b.zIndex - a.zIndex);
    
    sortedSources.forEach(src => {
        const item = document.createElement('div');
        item.className = `panel-item ${src.id === selectedSourceId ? 'selected' : ''}`;
        
        let typeIcon = '🖥️';
        if (src.type === 'webcam') typeIcon = '📷';
        if (src.type === 'window') typeIcon = '🪟';
        
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
    list.innerHTML = '';
    
    const scene = activeScene();
    if (!scene) return;
    
    scene.sources.forEach(src => {
        if (!src.stream || src.stream.getAudioTracks().length === 0) return;
        
        const channel = document.createElement('div');
        channel.className = 'mixer-channel';
        
        let typeIcon = '🎙️';
        if (src.type === 'screen' || src.type === 'window') typeIcon = '🔊';
        
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

// --- ADICIONAR FONTES ---
async function addWebcamSource() {
    try {
        initAudioContext();
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        } catch (e) {
            console.warn("Sem acesso ao áudio da Webcam, capturando apenas vídeo.", e);
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

async function openSourcePicker(type) {
    pickerModalTitle.textContent = type === 'screen' ? 'Selecionar Tela Inteira' : 'Selecionar Janela Específica';
    pickerSourcesList.innerHTML = '<div class="picker-item">Buscando fontes disponíveis...</div>';
    sourcePickerModal.classList.remove('hidden');
    
    try {
        const sources = await window.electronAPI.getSources();
        pickerSourcesList.innerHTML = '';
        
        const filtered = sources.filter(src => {
            if (type === 'screen') return src.id.startsWith('screen:');
            if (type === 'window') return src.id.startsWith('window:');
            return true;
        });
        
        if (filtered.length === 0) {
            pickerSourcesList.innerHTML = '<div class="picker-item">Nenhuma fonte disponível.</div>';
            return;
        }
        
        filtered.forEach(src => {
            const item = document.createElement('div');
            item.className = 'picker-item';
            item.innerHTML = `
                <span>${type === 'screen' ? '🖥️' : '🪟'}</span>
                <span>${escapeHTML(src.name)}</span>
            `;
            item.addEventListener('click', () => {
                sourcePickerModal.classList.add('hidden');
                addCaptureSource(type, src.name, src.id);
            });
            pickerSourcesList.appendChild(item);
        });
    } catch (err) {
        console.error("Erro ao listar fontes:", err);
        pickerSourcesList.innerHTML = '<div class="picker-item">Erro ao listar fontes de captura.</div>';
    }
}

async function addCaptureSource(type, name, sourceId) {
    const profile = getSelectedQualityProfile();
    try {
        // Captura o vídeo
        const videoStream = await navigator.mediaDevices.getUserMedia({
            audio: false,
            video: {
                mandatory: {
                    chromeMediaSource: 'desktop',
                    chromeMediaSourceId: sourceId,
                    minWidth: profile.width,
                    maxWidth: profile.width,
                    minHeight: profile.height,
                    maxHeight: profile.height,
                    minFrameRate: profile.fps,
                    maxFrameRate: profile.fps
                }
            }
        });
        
        // Captura o som do sistema correspondente
        let systemAudioStream = null;
        try {
            systemAudioStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: sourceId
                    }
                },
                video: {
                    mandatory: {
                        chromeMediaSource: 'desktop',
                        chromeMediaSourceId: sourceId,
                        maxWidth: 1,
                        maxHeight: 1,
                        maxFrameRate: 1
                    }
                }
            });
        } catch (e) {
            console.warn("Sem áudio do sistema para esta fonte de captura:", e);
        }
        
        const tracks = [...videoStream.getVideoTracks()];
        if (systemAudioStream && systemAudioStream.getAudioTracks().length > 0) {
            tracks.push(systemAudioStream.getAudioTracks()[0]);
        }
        const combinedStream = new MediaStream(tracks);
        
        const newSourceId = 'source-' + Math.random().toString(36).substr(2, 9);
        const source = {
            id: newSourceId,
            name: name,
            type: type,
            stream: combinedStream,
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
        
        source.videoElement.srcObject = combinedStream;
        source.videoElement.muted = true;
        source.videoElement.playsInline = true;
        await source.videoElement.play();
        
        setupAudioNode(source);
        
        activeScene().sources.push(source);
        selectedSourceId = newSourceId;
        renderSources();
        renderMixer();
        showToast(`Fonte "${name}" adicionada com sucesso!`);
        hidePlaceholder();
    } catch (err) {
        console.error("Erro ao capturar fonte selecionada:", err);
        showToast("Erro ao adicionar fonte de captura: " + err.message);
    }
}

// --- DELETAR FONTES / CENAS ---
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

function startRenderLoop() {
    if (isRendering) return;
    isRendering = true;
    
    function draw() {
        if (!isRendering) return;
        
        // 1. Renderiza no canvas invisível de saída (composer-canvas)
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
        
        // 2. Copia para o preview-canvas visível com a escala correspondente
        previewCtx.clearRect(0, 0, previewCanvas.width, previewCanvas.height);
        previewCtx.drawImage(composerCanvas, 0, 0, previewCanvas.width, previewCanvas.height);
        
        // 3. Desenha as bordas e alças do editor sobre o preview-canvas
        if (scene && selectedSourceId) {
            const src = scene.sources.find(s => s.id === selectedSourceId);
            if (src && src.visible) {
                drawSelectionBorder(src);
            }
        }
        
        requestAnimationFrame(draw);
    }
    
    requestAnimationFrame(draw);
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
    previewCtx.strokeStyle = '#8b5cf6';
    previewCtx.lineWidth = 3;
    previewCtx.strokeRect(src.x, src.y, src.width, src.height);
    
    previewCtx.fillStyle = '#ffffff';
    previewCtx.strokeStyle = '#8b5cf6';
    previewCtx.lineWidth = 2;
    
    const handles = getHandles(src);
    for (const key in handles) {
        const pt = handles[key];
        previewCtx.fillRect(pt.x - HANDLE_SIZE/2, pt.y - HANDLE_SIZE/2, HANDLE_SIZE, HANDLE_SIZE);
        previewCtx.strokeRect(pt.x - HANDLE_SIZE/2, pt.y - HANDLE_SIZE/2, HANDLE_SIZE, HANDLE_SIZE);
    }
}

// --- MENU DE CONTEXTO (BOTAO DIREITO) ---
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

// --- EVENTOS DE INTERAÇÃO COM O MOUSE (DRAG & RESIZE) ---
let interactionMode = null;
let resizeHandle = null;
let startMousePos = { x: 0, y: 0 };
let startSourceRect = { x: 0, y: 0, w: 0, h: 0 };

previewCanvas.addEventListener('mousedown', (e) => {
    const scene = activeScene();
    if (!scene) return;
    
    const rect = previewCanvas.getBoundingClientRect();
    const scaleX = previewCanvas.width / rect.width;
    const scaleY = previewCanvas.height / rect.height;
    const mX = (e.clientX - rect.left) * scaleX;
    const mY = (e.clientY - rect.top) * scaleY;
    
    // 1. Checa se clicou sobre uma alça (handle) do elemento selecionado
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
    
    // 2. Checa se clicou dentro de qualquer outro elemento (do topo para o fundo)
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

// --- LOOP DO MIXER VU METERS ---
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
                // Escala de forma perceptível
                const percent = Math.min(100, Math.round((average / 110) * 100));
                vuBar.style.width = `${percent}%`;
            } else {
                vuBar.style.width = '0%';
            }
        });
    }, 50);
}

function stopVULoop() {
    if (vuInterval) {
        clearInterval(vuInterval);
        vuInterval = null;
    }
}

// --- TRANSMISSÃO WEBRTC (INICIAR / PARAR) ---
async function startStreaming() {
    const roomId = roomInput.value.trim();
    if (!roomId) {
        showToast("Por favor, insira o código da sala.");
        return;
    }
    
    const scene = activeScene();
    if (!scene || scene.sources.length === 0) {
        showToast("Por favor, adicione pelo menos uma fonte de vídeo na sua cena.");
        return;
    }
    
    const profile = getSelectedQualityProfile();
    const cleanRoomId = roomId.toLowerCase().replace(/[^a-z0-9-_]/g, '');
    const streamerPeerId = PEER_PREFIX + cleanRoomId;
    
    btnStart.disabled = true;
    statusText.textContent = "Iniciando mixer e sinalização...";
    
    try {
        initAudioContext();
        
        // Configura dimensões exatas de saída da transmissão
        composerCanvas.width = profile.width;
        composerCanvas.height = profile.height;
        
        // 1. Gera a stream de vídeo combinada do Composer Canvas
        const canvasStream = composerCanvas.captureStream(profile.fps);
        
        // 2. Extrai a track de áudio combinada do Mixer de áudio (se houver)
        const outputTracks = [...canvasStream.getVideoTracks()];
        
        if (audioDestination && audioDestination.stream.getAudioTracks().length > 0) {
            outputTracks.push(audioDestination.stream.getAudioTracks()[0]);
        }
        
        localStream = new MediaStream(outputTracks);
        
        // Inicializa conexão PeerJS
        peer = new Peer(streamerPeerId);
        
        peer.on('open', (id) => {
            statusBadge.className = "badge badge-live";
            statusBadge.textContent = "Ao Vivo";
            statusText.textContent = "Transmissão ativa! Compondo mixer...";
            
            const shareUrl = `https://quick-cast-one.vercel.app/?room=${cleanRoomId}`;
            shareUrlInput.value = shareUrl;
            sharePanel.classList.remove('hidden');
            
            btnStop.disabled = false;
            roomInput.disabled = true;
            
            showToast("Transmissão com mixer OBS ativada! 🚀");
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
                if (conn.peerConnection) {
                    conn.peerConnection.addEventListener('connectionstatechange', () => {
                        if (['failed', 'closed', 'disconnected'].includes(conn.peerConnection.connectionState)) {
                            if (activeConnections.has(conn)) {
                                activeConnections.delete(conn);
                                updateViewerCount();
                            }
                        }
                    });
                }
                
                // Conecta a stream final renderizada do canvas
                const call = peer.call(conn.peer, localStream);
                activeCalls.add(call);
                
                call.on('peerConnection', (pc) => {
                    pc.addEventListener('connectionstatechange', () => {
                        if (pc.connectionState === 'connected') {
                            applyBitrateControl(pc, profile.bitrate);
                        }
                    });
                });
                
                call.on('close', () => {
                    activeCalls.delete(call);
                });
            });
            
            conn.on('close', () => {
                activeConnections.delete(conn);
                updateViewerCount();
            });
        });
        
        peer.on('error', (err) => {
            console.error("Erro no canal de sinalização:", err);
            if (err.type === 'unavailable-id') {
                showToast("Este código de sala já está ativo em outra transmissão. Escolha outro!");
            } else {
                showToast(`Erro de rede: ${err.type}`);
            }
            stopStreaming();
        });
        
    } catch (err) {
        console.error("Erro ao iniciar mixer e WebRTC:", err);
        showToast("Falha ao inicializar mixer ou streams.");
        stopStreaming();
    }
}

function stopStreaming() {
    statusText.textContent = "Encerrando transmissão...";
    
    activeConnections.forEach(conn => conn.close());
    activeConnections.clear();
    
    activeCalls.forEach(call => call.close());
    activeCalls.clear();
    
    if (peer) {
        peer.destroy();
        peer = null;
    }
    
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    
    statusBadge.className = "badge badge-offline";
    statusBadge.textContent = "Offline";
    statusText.textContent = "Pronto para transmitir";
    
    sharePanel.classList.add('hidden');
    shareUrlInput.value = "";
    viewerCountSpan.textContent = "0";
    
    btnStart.disabled = false;
    btnStop.disabled = true;
    roomInput.disabled = false;
    
    showToast("Transmissão encerrada.");
}

function updateViewerCount() {
    viewerCountSpan.textContent = activeConnections.size;
}

// --- EVENTOS DOS BOTÕES DO STUDIO ---
document.getElementById('btn-add-scene').addEventListener('click', () => {
    const name = `Cena ${scenes.length + 1}`;
    addScene(name);
});

document.getElementById('btn-del-scene').addEventListener('click', () => {
    if (confirm("Tem certeza que deseja remover esta cena?")) {
        deleteScene();
    }
});

// Ações de fontes
const addSourceMenuBtn = document.getElementById('btn-add-source-menu');
const addSourceDropdown = document.getElementById('add-source-dropdown');

addSourceMenuBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    addSourceDropdown.classList.toggle('show');
});

document.addEventListener('click', (e) => {
    if (!addSourceDropdown.contains(e.target) && e.target !== addSourceMenuBtn) {
        addSourceDropdown.classList.remove('show');
    }
});

document.getElementById('add-source-webcam').addEventListener('click', () => {
    addSourceDropdown.classList.remove('show');
    addWebcamSource();
});
document.getElementById('add-source-screen').addEventListener('click', () => {
    addSourceDropdown.classList.remove('show');
    openSourcePicker('screen');
});
document.getElementById('add-source-window').addEventListener('click', () => {
    addSourceDropdown.classList.remove('show');
    openSourcePicker('window');
});

document.getElementById('btn-del-source').addEventListener('click', deleteActiveSource);
document.getElementById('btn-source-up').addEventListener('click', () => moveSourceZ('up'));
document.getElementById('btn-source-down').addEventListener('click', () => moveSourceZ('down'));

btnCancelPicker.addEventListener('click', () => {
    sourcePickerModal.classList.add('hidden');
});

btnStart.addEventListener('click', startStreaming);
btnStop.addEventListener('click', stopStreaming);

// Copiar Link
btnCopy.addEventListener('click', () => {
    shareUrlInput.select();
    navigator.clipboard.writeText(shareUrlInput.value)
        .then(() => showToast("Link de transmissão copiado! 📋"))
        .catch(() => showToast("Erro ao copiar link."));
});

// --- INICIALIZAÇÃO DO STUDIO ---
window.addEventListener('DOMContentLoaded', () => {
    roomInput.value = generateSecureRoomId();
    
    const profile = getSelectedQualityProfile();
    bitrateValueSpan.textContent = `${profile.bitrate} Kbps`;
    
    // Configura os canvases
    previewCanvas.width = 1280;
    previewCanvas.height = 720;
    composerCanvas.width = profile.width;
    composerCanvas.height = profile.height;
    
    // Inicia renderização e mixer
    renderScenes();
    renderSources();
    renderMixer();
    
    startRenderLoop();
    startVULoop();
    showPlaceholder();
});

// Adiciona cena
function addScene(name) {
    const id = 'scene-' + Date.now();
    scenes.push({
        id: id,
        name: name,
        sources: []
    });
    activeSceneId = id;
    selectedSourceId = null;
    renderScenes();
    renderSources();
    renderMixer();
    showPlaceholder();
}

// Remove cena
function deleteScene() {
    if (scenes.length <= 1) {
        showToast("Não é possível remover a última cena.");
        return;
    }
    const idx = scenes.findIndex(s => s.id === activeSceneId);
    const scene = scenes[idx];
    
    scene.sources.forEach(src => {
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
    
    if (activeScene().sources.length === 0) {
        showPlaceholder();
    } else {
        hidePlaceholder();
    }
}
