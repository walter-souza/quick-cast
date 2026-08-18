// Constantes e Estados da Aplicação
const PEER_PREFIX = "streamshare-room-"; // Prefixo para evitar conflito de IDs globais no PeerJS Cloud
let peer = null;
let localStream = null;
let screenStream = null;
let micStream = null;
let activeConnections = new Set(); // Para o Streamer rastrear viewers ativos
let streamWatchdogInterval = null;
let lastDataReceivedTime = 0;

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
const chkTransmitMic = document.getElementById('chk-transmit-mic');
const btnStopStream = document.getElementById('btn-stop-stream');
const streamerStatusBadge = document.getElementById('streamer-status-badge');
const streamerStatusText = document.getElementById('streamer-status-text');
const streamerViewersCount = document.getElementById('streamer-viewers-count');
const shareLinkInput = document.getElementById('share-link-input');
const btnCopyLink = document.getElementById('btn-copy-link');
const streamerPreview = document.getElementById('streamer-preview');
const streamerPlaceholder = document.getElementById('streamer-placeholder');
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
}

// Configura volta para a tela inicial
btnBackElements.forEach(btn => {
    btn.addEventListener('click', () => {
        streamerForm.classList.add('hidden');
        viewerForm.classList.add('hidden');
        selectStreamer.parentNode.classList.remove('hidden');
    });
});

// Seleção do Card Streamer
selectStreamer.addEventListener('click', () => {
    selectStreamer.parentNode.classList.add('hidden');
    streamerForm.classList.remove('hidden');
    // Sugere um código aleatório simples
    streamerRoomInput.value = Math.random().toString(36).substring(2, 8);
    streamerRoomInput.focus();
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


// --- LÓGICA DO STREAMER ---

// Função auxiliar para mixar faixas de áudio da tela (sistema) e do microfone
function mixAudioTracks(screenStream, micStream) {
    const hasScreenAudio = screenStream && screenStream.getAudioTracks().length > 0;
    const hasMicAudio = micStream && micStream.getAudioTracks().length > 0;

    if (!hasScreenAudio && !hasMicAudio) {
        return null;
    }

    // Se apenas um tem áudio, retorna a faixa dele diretamente (sem precisar de AudioContext)
    if (hasScreenAudio && !hasMicAudio) {
        return screenStream.getAudioTracks()[0];
    }
    if (!hasScreenAudio && hasMicAudio) {
        return micStream.getAudioTracks()[0];
    }

    // Se ambos têm áudio, usamos o AudioContext para mesclá-los
    try {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        const audioCtx = new AudioContextClass();
        const destNode = audioCtx.createMediaStreamDestination();

        // Fonte 1: Áudio do Sistema (tela)
        const screenSource = audioCtx.createMediaStreamSource(screenStream);
        screenSource.connect(destNode);

        // Fonte 2: Áudio do Microfone
        const micSource = audioCtx.createMediaStreamSource(micStream);
        micSource.connect(destNode);

        // Retorna a faixa resultante mixada
        return destNode.stream.getAudioTracks()[0];
    } catch (e) {
        console.error("Erro ao inicializar AudioContext para mixagem:", e);
        // Fallback: retorna o áudio da tela
        return screenStream.getAudioTracks()[0];
    }
}

// Definições de qualidade suportadas
const QUALITY_SETTINGS = {
    '720p': {
        width: 1280,
        height: 720,
        frameRate: 30,
        bitrate: 1500000 // 1.5 Mbps
    },
    '1080p': {
        width: 1920,
        height: 1080,
        frameRate: 30,
        bitrate: 3000000 // 3.0 Mbps
    },
    'max': {
        width: null, // sem limite (resolução nativa)
        height: null,
        frameRate: 60,
        bitrate: null // sem limite (automático do WebRTC)
    }
};

// Aplica configurações de vídeo (resolução, FPS) e bitrate em tempo real
async function applyQualitySettings(qualityKey) {
    if (!screenStream || !localStream) return;

    const settings = QUALITY_SETTINGS[qualityKey];
    const videoTrack = screenStream.getVideoTracks()[0];

    if (videoTrack) {
        // 1. Aplica novos limites de resolução e framerate no track da tela
        const constraints = {
            width: settings.width ? { max: settings.width, ideal: settings.width } : undefined,
            height: settings.height ? { max: settings.height, ideal: settings.height } : undefined,
            frameRate: settings.frameRate ? { max: settings.frameRate, ideal: settings.frameRate } : undefined
        };

        try {
            await videoTrack.applyConstraints(constraints);
            console.log(`Constraints aplicadas para ${qualityKey}:`, constraints);
        } catch (err) {
            console.error("Erro ao aplicar constraints de vídeo:", err);
            showToast("Não foi possível ajustar a resolução da tela.");
        }
    }

    // 2. Aplica limites de bitrate em todas as conexões de viewers ativos
    applyBitrateLimit(settings.bitrate);
}

// Varre todos os viewers ativos e limita a banda de vídeo
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

async function startStreaming(roomId) {
    if (!roomId) {
        showToast("Por favor, digite ou gere um código de sala.");
        return;
    }

    // Filtra caracteres inválidos
    const cleanRoomId = roomId.trim().toLowerCase().replace(/[^a-z0-9-_]/g, '');
    if (!cleanRoomId) {
        showToast("Código inválido. Use apenas letras, números, hífen e sublinhado.");
        return;
    }

    const peerId = PEER_PREFIX + cleanRoomId;
    btnStartStream.disabled = true;
    btnStartStream.textContent = "Solicitando Mídia...";

    try {
        // 1. Captura da tela e áudio do sistema
        // Nota: áudio do sistema só funciona no Windows se o usuário marcar "Compartilhar áudio do sistema"
        screenStream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: "always",
                frameRate: { ideal: 30, max: 60 }
            },
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        // 2. Captura do microfone (se marcado e disponível)
        if (chkTransmitMic && chkTransmitMic.checked) {
            try {
                micStream = await navigator.mediaDevices.getUserMedia({
                    audio: {
                        echoCancellation: true,
                        noiseSuppression: true,
                        autoGainControl: true
                    }
                });
            } catch (micErr) {
                console.warn("Microfone não autorizado ou indisponível:", micErr);
                showToast("Aviso: Microfone indisponível. Transmitindo apenas áudio do sistema.");
            }
        }

        // 3. Monta o stream final combinado (vídeo + áudio mixado)
        const tracks = [];
        
        // Adiciona faixa de vídeo da tela
        if (screenStream.getVideoTracks().length > 0) {
            tracks.push(screenStream.getVideoTracks()[0]);
        }

        // Mixa e adiciona áudio
        const mixedAudioTrack = mixAudioTracks(screenStream, micStream);
        if (mixedAudioTrack) {
            tracks.push(mixedAudioTrack);
        }

        localStream = new MediaStream(tracks);

        // Aplica as configurações iniciais de qualidade selecionadas no dropdown
        const currentQuality = selectStreamQuality.value;
        await applyQualitySettings(currentQuality);

        // Ouvir quando o usuário clica no botão nativo "Parar Compartilhamento" do navegador
        screenStream.getVideoTracks()[0].onended = () => {
            stopStreaming();
            showToast("Transmissão encerrada pelo navegador.");
        };

        // Exibe preview local (mutado para não dar eco)
        streamerPreview.srcObject = localStream;
        streamerPlaceholder.classList.add('hidden');

        // 4. Inicializa conexão com o servidor de sinalização do PeerJS
        peer = new Peer(peerId);

        peer.on('open', (id) => {
            showSection(streamerSection);
            streamerStatusBadge.className = "badge badge-live";
            streamerStatusBadge.textContent = "LIVE";
            streamerStatusText.textContent = `Transmitindo sala: ${cleanRoomId}`;
            
            // Gera link de compartilhamento
            const shareUrl = `${window.location.origin}${window.location.pathname}?room=${cleanRoomId}`;
            shareLinkInput.value = shareUrl;
            
            showToast("Transmissão iniciada! Envie o link para os amigos. 🚀");
            activeConnections.clear();
            updateViewerCount();
        });

        // 5. Aguarda conexões de sinalização dos Viewers
        peer.on('connection', (conn) => {
            activeConnections.add(conn);
            updateViewerCount();

            // Quando a conexão de dados abrir, ligamos (call) enviando o stream de vídeo
            conn.on('open', () => {
                const call = peer.call(conn.peer, localStream);
                
                // Aplica o limite de bitrate da qualidade atual para esta conexão após a negociação
                setTimeout(() => {
                    const currentQuality = selectStreamQuality.value;
                    const settings = QUALITY_SETTINGS[currentQuality];
                    applyBitrateLimit(settings.bitrate);
                }, 1000);

                // Trata desconexão do viewer
                conn.on('close', () => {
                    activeConnections.delete(conn);
                    updateViewerCount();
                });
            });

            conn.on('error', (err) => {
                console.error("Erro na conexão com viewer:", err);
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
        console.error("Erro ao capturar tela:", err);
        showToast("Permissão de tela negada ou erro ao iniciar captura.");
        stopStreaming();
    }
}

function stopStreaming() {
    if (localStream) {
        localStream.getTracks().forEach(track => track.stop());
        localStream = null;
    }
    if (screenStream) {
        screenStream.getTracks().forEach(track => track.stop());
        screenStream = null;
    }
    if (micStream) {
        micStream.getTracks().forEach(track => track.stop());
        micStream = null;
    }
    if (peer) {
        peer.destroy();
        peer = null;
    }
    activeConnections.clear();
    resetStreamerUI();
    showSection(setupSection);
}

function resetStreamerUI() {
    btnStartStream.disabled = false;
    btnStartStream.textContent = "Iniciar Transmissão";
    streamerStatusBadge.className = "badge badge-offline";
    streamerStatusBadge.textContent = "Offline";
    streamerStatusText.textContent = "Iniciando...";
    streamerViewersCount.textContent = "0";
    shareLinkInput.value = "";
    streamerPreview.srcObject = null;
    streamerPlaceholder.classList.remove('hidden');
}

function updateViewerCount() {
    streamerViewersCount.textContent = activeConnections.size;
}

btnStartStream.addEventListener('click', () => {
    startStreaming(streamerRoomInput.value);
});

btnStopStream.addEventListener('click', stopStreaming);


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

selectStreamQuality.addEventListener('change', (e) => {
    applyQualitySettings(e.target.value);
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
