# 📡 QuickCast Signaling Server (PeerServer)

Servidor de sinalização WebRTC exclusivo e otimizado para o **QuickCast**.

---

## 🚀 Como fazer o Deploy Gratuito no Render.com

1. Acesse o [Render Dashboard](https://dashboard.render.com/) e faça login (pode usar sua conta GitHub).
2. Clique no botão **New +** no topo e selecione **Web Service**.
3. Conecte o repositório do **QuickCast** (`walter-souza/quick-cast`).
4. Preencha as configurações:
   - **Name**: `quickcast-signaling` (ou o nome que preferir)
   - **Region**: `Ohio (US East)` ou a mais próxima de você
   - **Root Directory**: `server` ⚠️ *(Importante: aponte para a pasta `server`)*
   - **Environment**: `Node`
   - **Build Command**: `npm install`
   - **Start Command**: `node server.js`
   - **Instance Type**: `Free` (Gratuito)
5. Clique em **Deploy Web Service**.

---

## 🔗 Como conectar com a Vercel

Assim que o Render finalizar o deploy, ele exibirá a URL do seu serviço no topo (exemplo: `https://quickcast-signaling.onrender.com`).

No arquivo `app.js` (Web) e `desktop-app/renderer.js` (Desktop), localize a constante:

```javascript
const SIGNALING_SERVER = {
    host: 'quickcast-signaling.onrender.com', // Coloque o seu domínio do Render aqui (sem https://)
    port: 443,
    path: '/peerjs',
    key: 'quickcast',
    secure: true
};
```

Pronto! Seu QuickCast agora tem um servidor de sinalização 100% dedicado, rápido e sem limites de conexões.
