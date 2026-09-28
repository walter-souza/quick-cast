const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const { ExpressPeerServer } = require('peer');

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 9000;
const CLIENT_BASE_URL = process.env.CLIENT_BASE_URL || 'https://quick-cast-one.vercel.app';

// Middlewares
app.use(cors());
app.use(express.json());

// Servidor PeerJS montado em /peerjs
const peerServer = ExpressPeerServer(server, {
    path: '/',
    allow_discovery: true,
    alive_timeout: 60000
});

app.use('/peerjs', peerServer);

// Monitoramento de conexões PeerJS
peerServer.on('connection', (client) => {
    console.log(`[+] Novo peer conectado: ${client.getId()} (${new Date().toLocaleTimeString()})`);
});

peerServer.on('disconnect', (client) => {
    console.log(`[-] Peer desconectado: ${client.getId()} (${new Date().toLocaleTimeString()})`);
});

peerServer.on('error', (err) => {
    console.error(`[!] Erro no PeerServer:`, err);
});

// =========================================================================
// Rota de Embed & OpenGraph para Discord (GET /watch/:roomId)
// Quando essa URL é colada no Discord, o Discordbot renderiza o card rico
// =========================================================================
app.get(['/watch/:roomId', '/embed/:roomId', '/live/:roomId'], (req, res) => {
    const roomId = req.params.roomId;
    const targetUrl = `${CLIENT_BASE_URL}/?room=${encodeURIComponent(roomId)}`;
    const pageTitle = `🔴 QuickCast - Sala ${roomId} Ao Vivo!`;
    const description = `Transmissão em tempo real com zero delay (P2P WebRTC). Clique para assistir agora sem precisar baixar nada!`;

    // Resposta HTML otimizada com tags OpenGraph e Twitter Player
    const html = `<!DOCTYPE html>
<html lang="pt-BR">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${pageTitle}</title>
    
    <!-- Metatags OpenGraph / Discord Embed -->
    <meta property="og:site_name" content="QuickCast Live" />
    <meta property="og:title" content="${pageTitle}" />
    <meta property="og:description" content="${description}" />
    <meta property="og:type" content="video.other" />
    <meta property="og:url" content="${targetUrl}" />
    <meta name="theme-color" content="#5865F2" />

    <!-- Twitter Card -->
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${pageTitle}" />
    <meta name="twitter:description" content="${description}" />

    <!-- Redirecionamento automático imediato para navegadores humanos -->
    <meta http-equiv="refresh" content="0; url=${targetUrl}" />

    <style>
        body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background-color: #0f172a;
            color: #f8fafc;
            display: flex;
            align-items: center;
            justify-content: center;
            height: 100vh;
            margin: 0;
            text-align: center;
        }
        .card {
            background: #1e293b;
            padding: 2.5rem;
            border-radius: 16px;
            box-shadow: 0 10px 25px rgba(0,0,0,0.5);
            max-width: 450px;
            border: 1px solid #334155;
        }
        .live-badge {
            background: #ef4444;
            color: white;
            padding: 4px 12px;
            border-radius: 9999px;
            font-weight: 700;
            font-size: 0.85rem;
            display: inline-block;
            margin-bottom: 1rem;
            animation: pulse 2s infinite;
        }
        @keyframes pulse {
            0%, 100% { opacity: 1; }
            50% { opacity: 0.6; }
        }
        a.btn {
            display: inline-block;
            background: #5865F2;
            color: white;
            text-decoration: none;
            padding: 12px 24px;
            border-radius: 8px;
            font-weight: 600;
            margin-top: 1.5rem;
            transition: background 0.2s;
        }
        a.btn:hover {
            background: #4752C4;
        }
    </style>
</head>
<body>
    <div class="card">
        <div class="live-badge">🔴 AO VIVO</div>
        <h2>Entrando na Sala: <code>${roomId}</code></h2>
        <p>Você está sendo redirecionado para a transmissão ao vivo no QuickCast...</p>
        <a href="${targetUrl}" class="btn">Assistir Transmissão ➔</a>
    </div>
    <script>
        window.location.replace("${targetUrl}");
    </script>
</body>
</html>`;

    res.send(html);
});

// =========================================================================
// API de Notificação de Webhook do Discord (POST /api/notify-discord)
// =========================================================================
app.post('/api/notify-discord', async (req, res) => {
    const { webhookUrl, roomId, streamTitle, streamerName } = req.body;

    if (!webhookUrl || !roomId) {
        return res.status(400).json({ error: 'webhookUrl e roomId são obrigatórios' });
    }

    const watchUrl = `${CLIENT_BASE_URL}/?room=${encodeURIComponent(roomId)}`;
    const title = streamTitle || `Transmissão Ao Vivo no QuickCast!`;
    const author = streamerName || `Streamer`;

    const discordPayload = {
        username: "QuickCast Live",
        avatar_url: "https://raw.githubusercontent.com/Vendicated/Vencord/main/assets/icon.png",
        embeds: [
            {
                title: `🔴 ${title}`,
                description: `**${author}** acabou de iniciar uma transmissão ao vivo com zero delay!\n\nClique no link abaixo para assistir instantaneamente no seu navegador sem instalar nada:`,
                url: watchUrl,
                color: 0x5865F2, // Discord Blurple
                fields: [
                    {
                        name: "🔑 Código da Sala",
                        value: `\`${roomId}\``,
                        inline: true
                    },
                    {
                        name: "⚡ Tecnologia",
                        value: "WebRTC Ultra-Low Latency",
                        inline: true
                    },
                    {
                        name: "📺 Assistir Agora",
                        value: `[**👉 Assistir Transmissão**](${watchUrl})`,
                        inline: false
                    }
                ],
                footer: {
                    text: "QuickCast • Compartilhamento de tela em tempo real"
                },
                timestamp: new Date().toISOString()
            }
        ]
    };

    try {
        // Envio via fetch nativo do Node
        const response = await fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(discordPayload)
        });

        if (response.ok) {
            return res.json({ success: true, message: 'Notificação enviada ao Discord com sucesso!' });
        } else {
            const errText = await response.text();
            return res.status(response.status).json({ error: 'Erro ao enviar para o Discord', details: errText });
        }
    } catch (err) {
        console.error('Erro ao disparar webhook do Discord:', err);
        return res.status(500).json({ error: 'Falha interna ao disparar webhook', details: err.message });
    }
});

// Inicialização do servidor HTTP
server.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`📡 QuickCast Server rodando na porta ${PORT}`);
    console.log(`🔗 Endpoint PeerJS: /peerjs`);
    console.log(`🎮 Endpoint Discord Embed: /watch/:roomId`);
    console.log(`📣 Endpoint Discord Webhook: /api/notify-discord`);
    console.log(`========================================`);
});
