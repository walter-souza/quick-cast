const express = require('express');
const { ExpressPeerServer } = require('peer');
const cors = require('cors');

const app = express();

// Permite requisições CORS do frontend (Vercel e Localhost)
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS']
}));

const PORT = process.env.PORT || 9000;

// Healthcheck e rota informativa
app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'QuickCast PeerServer (Signaling)',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
    });
});

const server = app.listen(PORT, () => {
    console.log(`========================================`);
    console.log(`📡 QuickCast Signaling Server rodando!`);
    console.log(`🚀 Porta: ${PORT}`);
    console.log(`🔗 Endpoint PeerJS: /peerjs`);
    console.log(`========================================`);
});

// Inicialização do PeerServer com compatibilidade total de caminhos
const peerServer = ExpressPeerServer(server, {
    debug: true,
    path: '/',
    allow_discovery: true,
    alive_timeout: 60000
});

app.use('/peerjs', peerServer);
app.use('/', peerServer);

// Monitoramento de conexões
peerServer.on('connection', (client) => {
    console.log(`[+] Novo peer conectado: ${client.getId()} (${new Date().toLocaleTimeString()})`);
});

peerServer.on('disconnect', (client) => {
    console.log(`[-] Peer desconectado: ${client.getId()} (${new Date().toLocaleTimeString()})`);
});

peerServer.on('error', (err) => {
    console.error(`[!] Erro no PeerServer:`, err);
});
