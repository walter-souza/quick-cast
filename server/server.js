const { PeerServer } = require('peer');

const PORT = process.env.PORT || 9000;

const peerServer = PeerServer({
    port: PORT,
    path: '/peerjs',
    proxied: true,
    allow_discovery: true,
    alive_timeout: 60000
}, (server) => {
    console.log(`========================================`);
    console.log(`📡 QuickCast PeerServer rodando na porta ${PORT}`);
    console.log(`🔗 Endpoint: /peerjs`);
    console.log(`========================================`);
});

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
