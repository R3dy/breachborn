// Game server skeleton (M1): transport up, ping/pong live. World sim lands in M2 per ADR-008.
import { WebSocketServer, WebSocket } from 'ws';

const PORT = Number(process.env.PORT ?? 8080);
const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws: WebSocket) => {
  ws.on('message', (raw) => {
    let msg: { t?: string; ts?: number };
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.t === 'ping' && typeof msg.ts === 'number') {
      ws.send(JSON.stringify({ t: 'pong', ts: msg.ts }));
    }
    // hello/welcome/movement/etc. arrive in M2 (story 2.1)
  });
});

console.log(`[breachborn-server] listening on :${PORT}`);
