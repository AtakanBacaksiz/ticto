const { PeerServer } = require('peer');

const peerServer = PeerServer({
  port: Number(process.env.PORT) || 9000,
  path: '/',
  proxied: true,          // trust Render / Railway reverse-proxy headers
  allow_discovery: false, // don't expose the peer list publicly
  alive_timeout: 60000,
  key: 'peerjs',
});

peerServer.on('connection', client => {
  console.log('[ticto] connected :', client.getId());
});

peerServer.on('disconnect', client => {
  console.log('[ticto] disconnected:', client.getId());
});

console.log(`[ticto] PeerJS server listening on port ${process.env.PORT || 9000}`);
