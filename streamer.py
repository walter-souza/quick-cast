import asyncio
import json
import random
import string
import sys
import time
import fractions
import numpy as np
import websockets
import bettercam
import soundcard as sc

from aiortc import MediaStreamTrack, RTCPeerConnection, RTCSessionDescription, RTCIceCandidate
from av import VideoFrame, AudioFrame

# Constantes de Conexão
PEER_PREFIX = "streamshare-room-"
PEERJS_HOST = "0.peerjs.com"
PEERJS_PORT = 443
PEERJS_PATH = "/peerjs"
PEERJS_KEY = "peerjs"

# Configurações de Captura
FPS = 30

# Dicionários globais de controle
active_connections = {}  # {viewer_id: RTCPeerConnection (Data)}
active_media_connections = {}  # {viewer_id: (RTCPeerConnection (Media), connection_id)}

# Tracks compartilhados globais
screen_track = None
audio_track = None


# --- TRACK DE VÍDEO (DXGI / DirectX Screen Capture) ---
class ScreenShareTrack(MediaStreamTrack):
    kind = "video"

    def __init__(self, fps=30):
        super().__init__()
        print("[Vídeo] Inicializando captura DirectX (bettercam)...")
        self.camera = bettercam.create()
        self.fps = fps
        self.frame_time = 1.0 / fps
        self.pts = 0
        self.time_base = fractions.Fraction(1, 90000)
        self.pts_increment = int(90000 / fps)
        print("[Vídeo] Captura DirectX inicializada com sucesso.")

    async def recv(self):
        try:
            # Captura o frame atual da GPU em RGB
            frame_data = self.camera.grab(color_mode="RGB")
            while frame_data is None:
                await asyncio.sleep(0.005)
                frame_data = self.camera.grab(color_mode="RGB")
        except Exception as e:
            print(f"[Vídeo] Erro ao capturar frame: {e}. Enviando frame preto temporário.")
            await asyncio.sleep(self.frame_time)
            frame_data = np.zeros((720, 1280, 3), dtype=np.uint8)

        # Converte para VideoFrame (RGB24)
        rgb_frame = VideoFrame.from_ndarray(frame_data, format="rgb24")
        
        # Converte para YUV420p (obrigatório para WebRTC encoders)
        yuv_frame = rgb_frame.reformat(format="yuv420p")
        
        # Incrementa PTS de forma linear para evitar travamentos e jitter
        self.pts += self.pts_increment
        yuv_frame.pts = self.pts
        yuv_frame.time_base = self.time_base
        
        # Controla a taxa de quadros (FPS)
        await asyncio.sleep(self.frame_time)
        return yuv_frame

    def stop(self):
        if self.camera:
            self.camera.stop()
            print("[Vídeo] Captura DirectX encerrada.")


# --- TRACK DE ÁUDIO (Windows WASAPI Loopback Capture) ---
class SystemAudioTrack(MediaStreamTrack):
    kind = "audio"

    def __init__(self):
        super().__init__()
        print("[Áudio] Inicializando captura de áudio do sistema (soundcard)...")
        self.speaker = sc.default_speaker()
        self.samplerate = 48000
        self.channels = 2
        
        # 20ms de áudio é o padrão ideal para WebRTC (Opus)
        self.frame_duration = 0.02 
        self.num_samples = int(self.samplerate * self.frame_duration)
        
        # Inicializa o gravador de loopback
        self.recorder = self.speaker.recorder(samplerate=self.samplerate, channels=self.channels)
        self.recorder.__enter__()
        
        self.pts = 0
        self.time_base = fractions.Fraction(1, self.samplerate)
        print("[Áudio] Captura de áudio inicializada com sucesso.")

    async def recv(self):
        loop = asyncio.get_event_loop()
        # Grava os blocos de áudio de forma não bloqueante usando o executor
        try:
            data = await loop.run_in_executor(None, self.recorder.record, self.num_samples)
        except Exception as e:
            print(f"[Áudio] Erro na captura de áudio: {e}")
            await asyncio.sleep(self.frame_duration)
            data = np.zeros((self.num_samples, self.channels), dtype=np.float32)

        # Converte float32 [-1.0, 1.0] para PCM int16
        data_int16 = (data * 32767).astype(np.int16)
        
        # Transpõe de (samples, channels) para (channels, samples) como exigido pelo PyAV
        frame = AudioFrame.from_ndarray(data_int16.T, format="s16", layout="stereo")
        frame.sample_rate = self.samplerate
        
        self.pts += self.num_samples
        frame.pts = self.pts
        frame.time_base = self.time_base
        
        return frame

    def stop(self):
        if self.recorder:
            try:
                self.recorder.__exit__(None, None, None)
                print("[Áudio] Captura de áudio encerrada.")
            except Exception as e:
                print(f"[Áudio] Erro ao encerrar gravador: {e}")


# --- AUXILIARES E PARSER DE SINALIZAÇÃO ---

# Função para converter ICE candidate do formato PeerJS para o objeto do aiortc
def parse_ice_candidate(cand_dict):
    cand_str = cand_dict.get('candidate', '')
    sdp_mid = cand_dict.get('sdpMid')
    sdp_mline_index = cand_dict.get('sdpMLineIndex')

    if not cand_str:
        return None

    # Remove o prefixo "candidate:" se houver e quebra os campos por espaço
    clean_str = cand_str.replace("candidate:", "").strip()
    parts = clean_str.split(" ")
    
    if len(parts) >= 7:
        try:
            candidate = RTCIceCandidate(
                foundation=parts[0],
                component=int(parts[1]),
                protocol=parts[2],
                priority=int(parts[3]),
                ip=parts[4],
                port=int(parts[5]),
                type=parts[6],
                sdpMid=sdp_mid,
                sdpMLineIndex=sdp_mline_index
            )
            # Adiciona informações de endereço relacionado se for candidato reflexivo (srflx/relay)
            if len(parts) >= 9 and parts[7] == "raddr":
                candidate.relatedAddress = parts[8]
            if len(parts) >= 11 and parts[9] == "rport":
                candidate.relatedPort = int(parts[10])
            return candidate
        except Exception as e:
            print(f"[Signaling] Erro ao parsear ICE candidate: {e}")
    return None


# Envia mensagens estruturadas para o PeerJS Server
async def send_peerjs_message(ws, msg_type, dst_peer_id, payload, connection_id, label=""):
    message = {
        "type": msg_type,
        "src": ws.peer_id,
        "dst": dst_peer_id,
        "payload": payload,
        "connectionId": connection_id,
        "label": label
    }
    await ws.send(json.dumps(message))


# Loop de Heartbeat exigido pelo PeerJS Server para não cair a conexão WebSocket
async def heartbeat_loop(ws):
    try:
        while True:
            await asyncio.sleep(15)
            await ws.send(json.dumps({"type": "HEARTBEAT"}))
    except asyncio.CancelledError:
        pass
    except Exception as e:
        print(f"[Signaling] Falha no heartbeat: {e}")


# --- FLUXO DE CONEXÃO E GERENCIAMENTO WEBRTC ---

# Cria e responde à conexão inicial de dados (DataConnection)
async def handle_data_connection(ws, viewer_id, dc_offer, conn_id):
    print(f"\n[Conexão] Viewer {viewer_id} solicitou conexão de dados (DataChannel).")
    
    pc_data = RTCPeerConnection()
    active_connections[viewer_id] = pc_data

    @pc_data.on("datachannel")
    def on_datachannel(channel):
        print(f"[DataChannel] Canal de dados aberto por {viewer_id} (Label: {channel.label})")

        @channel.on("open")
        def on_open():
            # Assim que o canal de dados abre, o streamer toma a iniciativa de fazer a chamada de vídeo (Call)
            print(f"[DataChannel] Canal de dados ativo com {viewer_id}. Iniciando transmissão de áudio/vídeo...")
            asyncio.create_task(initiate_media_connection(ws, viewer_id))

        @channel.on("close")
        def on_close():
            print(f"[DataChannel] Canal de dados fechado por {viewer_id}.")
            cleanup_viewer(viewer_id)

    @pc_data.on("iceconnectionstatechange")
    def on_ice_change():
        print(f"[Conexão] Estado ICE com {viewer_id} mudou para: {pc_data.iceConnectionState}")
        if pc_data.iceConnectionState in ["failed", "closed"]:
            cleanup_viewer(viewer_id)

    # 1. Configura oferta recebida do viewer
    await pc_data.setRemoteDescription(RTCSessionDescription(
        sdp=dc_offer['sdp'],
        type=dc_offer['type']
    ))

    # 2. Cria a resposta (Answer)
    answer = await pc_data.createAnswer()
    await pc_data.setLocalDescription(answer)

    # 3. Aguarda o recolhimento completo dos ICE candidates locais para embuti-los no SDP
    while pc_data.iceGatheringState != "complete":
        await asyncio.sleep(0.05)

    # 4. Envia resposta via WebSocket de sinalização
    payload = {
        "sdp": pc_data.localDescription.sdp,
        "type": pc_data.localDescription.type
    }
    await send_peerjs_message(ws, "ANSWER", viewer_id, payload, conn_id, label="peerjs")
    print(f"[Signaling] Resposta de dados enviada para {viewer_id}.")


# Inicia a chamada WebRTC com vídeo/áudio (MediaConnection)
async def initiate_media_connection(ws, viewer_id):
    # Gera um ID de chamada compatível com o PeerJS
    media_conn_id = "mc_" + "".join(random.choices(string.ascii_lowercase + string.digits, k=16))
    
    pc_media = RTCPeerConnection()
    active_media_connections[viewer_id] = (pc_media, media_conn_id)

    # Adiciona faixas de vídeo e áudio compartilhadas
    if screen_track:
        pc_media.addTrack(screen_track)
    if audio_track:
        pc_media.addTrack(audio_track)

    # Cria a oferta de mídia
    offer = await pc_media.createOffer()
    await pc_media.setLocalDescription(offer)

    # Aguarda recolhimento de ICE candidates
    while pc_media.iceGatheringState != "complete":
        await asyncio.sleep(0.05)

    # Envia oferta de mídia para o Viewer
    payload = {
        "sdp": pc_media.localDescription.sdp,
        "type": pc_media.localDescription.type
    }
    
    # Nota: No PeerJS, chamadas de vídeo não têm rótulo (label=""), mas contêm type="media" no payload
    message = {
        "type": "OFFER",
        "src": ws.peer_id,
        "dst": viewer_id,
        "payload": payload,
        "connectionId": media_conn_id,
        "label": "",
        "serialization": "none",
        "type": "media"
    }
    await ws.send(json.dumps(message))
    print(f"[Signaling] Chamada de vídeo (OFFER) iniciada com {viewer_id} (ID: {media_conn_id}).")


# Trata a resposta de mídia do Viewer
async def handle_media_answer(viewer_id, media_answer):
    if viewer_id in active_media_connections:
        pc_media, _ = active_media_connections[viewer_id]
        await pc_media.setRemoteDescription(RTCSessionDescription(
            sdp=media_answer['sdp'],
            type=media_answer['type']
        ))
        print(f"[Conexão] Transmissão WebRTC ativa com o viewer {viewer_id}!")


# Remove e desconecta um viewer limpo
def cleanup_viewer(viewer_id):
    print(f"\n[Desconexão] Limpando conexão do viewer {viewer_id}...")
    
    # Fecha canal de dados
    if viewer_id in active_connections:
        pc = active_connections.pop(viewer_id)
        asyncio.create_task(pc.close())

    # Fecha canal de mídia
    if viewer_id in active_media_connections:
        pc_m, _ = active_media_connections.pop(viewer_id)
        asyncio.create_task(pc_m.close())
    
    print(f"[Desconexão] Viewer {viewer_id} desconectado.")


# --- MAIN EVENT LOOP ---

async def main():
    global screen_track, audio_track

    print("====================================================")
    print("      StreamShare Desktop - Transmissor Python      ")
    print("====================================================")

    # Pede o código da sala se não for informado por argumento
    if len(sys.argv) > 1:
        room_id = sys.argv[1].strip()
    else:
        room_id = input("Digite o código da sala desejada: ").strip()

    if not room_id:
        print("Erro: O código da sala não pode ser vazio.")
        return

    clean_room_id = room_id.lower().replace(" ", "-")
    peer_id = PEER_PREFIX + clean_room_id

    # Inicializa faixas de captura nativa
    try:
        screen_track = ScreenShareTrack(fps=FPS)
    except Exception as e:
        print(f"Erro crítico ao inicializar captura de vídeo: {e}")
        return

    try:
        audio_track = SystemAudioTrack()
    except Exception as e:
        print(f"Aviso: Não foi possível capturar o áudio do sistema ({e}). Transmitindo apenas tela.")
        audio_track = None

    # Gera token aleatório de cliente PeerJS
    token = "".join(random.choices(string.ascii_lowercase + string.digits, k=10))
    ws_url = f"wss://{PEERJS_HOST}{PEERJS_PATH}?key={PEERJS_KEY}&id={peer_id}&token={token}&version=1.3.0"

    print(f"\n[Signaling] Conectando ao servidor de sinalização PeerJS...")
    
    try:
        async with websockets.connect(ws_url) as ws:
            ws.peer_id = peer_id
            
            # Inicia o heartbeat em background
            heartbeat_task = asyncio.create_task(heartbeat_loop(ws))
            
            print("\n====================================================")
            print(" TRANSMISSÃO ATIVA!")
            print(f" Compartilhe este link com seus amigos:")
            print(f" -> https://quick-cast.vercel.app/?room={clean_room_id}")
            print("====================================================")
            print("\nPressione Ctrl+C para encerrar a transmissão.\n")

            # Escuta mensagens de sinalização recebidas
            async for raw_msg in ws:
                msg = json.loads(raw_msg)
                msg_type = msg.get("type")
                src_viewer = msg.get("src")
                conn_id = msg.get("connectionId")
                payload = msg.get("payload")

                if msg_type == "OFFER":
                    # Identifica se é oferta de conexão de dados (data) ou de mídia (media)
                    # PeerJS sinaliza dados com label="peerjs" ou payload.type="data"
                    label = msg.get("label", "")
                    
                    if label == "peerjs" or (payload and payload.get("type") == "offer" and msg.get("serialization") == "binary"):
                        # Trata nova conexão de dados (Viewer querendo conectar)
                        asyncio.create_task(handle_data_connection(ws, src_viewer, payload, conn_id))
                
                elif msg_type == "ANSWER":
                    # Resposta de mídia (Viewer aceitou a chamada de vídeo)
                    if payload and payload.get("type") == "answer":
                        asyncio.create_task(handle_media_answer(src_viewer, payload))

                elif msg_type == "CANDIDATE":
                    # ICE candidate recebido de um viewer (adiciona à conexão apropriada)
                    candidate_obj = parse_ice_candidate(payload.get("candidate"))
                    if candidate_obj:
                        # Identifica se o candidato pertence à conexão de dados ou de mídia
                        # Se o ID da conexão começar com "mc_", pertence à conexão de mídia
                        if conn_id and conn_id.startswith("mc_"):
                            if src_viewer in active_media_connections:
                                pc_m, _ = active_media_connections[src_viewer]
                                await pc_m.addIceCandidate(candidate_obj)
                        else:
                            if src_viewer in active_connections:
                                pc = active_connections[src_viewer]
                                await pc.addIceCandidate(candidate_obj)

    except KeyboardInterrupt:
        print("\n[Encerrando] Ctrl+C detectado.")
    except Exception as e:
        print(f"\n[Erro] Conexão com o servidor falhou: {e}")
    finally:
        # Cleanup geral
        print("[Encerrando] Parando capturas e fechando conexões...")
        if heartbeat_task:
            heartbeat_task.cancel()
        if screen_track:
            screen_track.stop()
        if audio_track:
            audio_track.stop()
        
        # Fecha todas as conexões ativas
        for pc in active_connections.values():
            asyncio.create_task(pc.close())
        for pc_m, _ in active_media_connections.values():
            asyncio.create_task(pc_m.close())
            
        print("[Encerrando] Transmissão finalizada. Até logo!")


if __name__ == "__main__":
    # Ajuste de event loop para Windows (obrigatório para melhorcam e websockets assíncronos)
    if sys.platform == 'win32':
        asyncio.set_event_loop_policy(asyncio.WindowsSelectorEventLoopPolicy())
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
