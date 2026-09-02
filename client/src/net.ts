// Net: WS connection + auto-reconnect + ping/pong RTT + offline banner +
// typed message pump (story 2.1).
import type { ClientMsg, ServerMsg } from '@breachborn/shared';

export type NetHooks = {
  offline: (offline: boolean) => void;
  message: (msg: ServerMsg) => void;
  open?: () => void;
};

export type Net = {
  send: (msg: ClientMsg) => void;
  rtt: () => number;
};

export function connectNet(url: string, hooks: NetHooks): Net {
  let ws: WebSocket | null = null;
  let lastRtt = 0;
  let retry = 0;
  let closed = false;

  function open(): void {
    try { ws = new WebSocket(url); } catch { hooks.offline(true); return; }
    ws.onopen = () => { retry = 0; hooks.offline(false); hooks.open?.(); };
    ws.onclose = () => { hooks.offline(true); if (!closed) scheduleRetry(); };
    ws.onerror = () => { hooks.offline(true); };
    ws.onmessage = (ev) => {
      let msg: ServerMsg;
      try { msg = JSON.parse(String(ev.data)) as ServerMsg; } catch { return; }
      if (msg.t === 'pong') lastRtt = performance.now() - msg.ts;
      hooks.message(msg);
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

// Periodic ping keepalive (RTT + server-pos reconciliation hook, story 2.2).
export function startPing(net: Net, intervalMs = 5000): void {
  setInterval(() => net.send({ t: 'ping', ts: performance.now() }), intervalMs);
}
