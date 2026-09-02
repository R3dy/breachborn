// Net: WS connection + ping/pong RTT + offline banner. Full protocol wiring = M2.
import type { ClientMsg, ServerMsg } from '@breachborn/shared';

export type Net = {
  send: (msg: ClientMsg) => void;
  rtt: () => number;
};

export function connectNet(url: string, onOffline: (offline: boolean) => void): Net {
  let ws: WebSocket | null = null;
  let lastRtt = 0;
  let retry = 0;
  let closed = false;

  function open(): void {
    try { ws = new WebSocket(url); } catch { onOffline(true); return; }
    ws.onopen = () => { retry = 0; onOffline(false); };
    ws.onclose = () => { onOffline(true); if (!closed) scheduleRetry(); };
    ws.onerror = () => { onOffline(true); };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as ServerMsg;
        if (msg.t === 'pong') lastRtt = performance.now() - msg.ts;
      } catch { /* ignore malformed */ }
    };
  }
  function scheduleRetry(): void {
    retry = Math.min(retry + 1, 6);
    setTimeout(() => { if (!closed) open(); }, 500 * Math.pow(2, retry));
  }
  open();

  return {
    send: (msg) => { if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg)); },
    rtt: () => lastRtt,
  };
}

// Periodic ping keepalive
export function startPing(net: Net, intervalMs = 5000): void {
  setInterval(() => net.send({ t: 'ping', ts: performance.now() }), intervalMs);
}
