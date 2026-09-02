// CANON — single source of truth for game constants.
// Mirrors docs/environment.md (which mirrors the PRD). Code must import from here.

export const TRACE = {
  SCAN: 4,
  STEALTH_SCAN: 1,
  EXPLOIT: 6,
  LOGWIPE: 10,
  DECAY_PER_SEC: 0.4, // -1 / 2.5s
  ANCHOR_REST: -20,
  WATCHING_THRESHOLD: 60,
  MAX: 100,
  PURGE_COUNTDOWN_SEC: 15,
  ZONE_LOCKDOWN_SEC: 60,
} as const;

export const COMMANDS = [
  'help', 'scan', 'enum', 'exploit', 'shell', 'crack',
  'token-steal', 'anchor plant', 'pivot', 'logwipe', 'trace',
] as const;

export type HostName = 'the-beacon' | 'vault.spire' | 'hearth-ward' | 'gate-post' | 'registry';

export type Service = {
  port: string; state: 'open' | 'filtered'; service: string; version: string;
  vuln?: string; misconfig?: string;
};

export type Host = {
  name: HostName; role: 'PUBLIC' | 'WARDED' | 'FIREWALL' | 'GOD-TIER LOCK' | 'OPEN';
  services: Service[];
};

export const TOPOLOGY: Record<HostName, Host> = {
  'the-beacon': { name: 'the-beacon', role: 'PUBLIC', services: [{ port: '80/tcp', state: 'open', service: 'beacon-http', version: 'haven 1.2' }] },
  'gate-post': { name: 'gate-post', role: 'OPEN', services: [{ port: '22/tcp', state: 'open', service: 'glyph-ssh', version: 'spiresh 3.4.0' }] },
  'vault.spire': {
    name: 'vault.spire', role: 'WARDED',
    services: [
      { port: '22/tcp', state: 'open', service: 'glyph-ssh', version: 'spiresh 3.4.1', vuln: '2026-12-0314' },
      { port: '31337', state: 'open', service: 'ward-socket', version: 'warden-d 2.1.0' },
      { port: '443/tcp', state: 'filtered', service: 'ward-tls', version: '—' },
    ],
  },
  'hearth-ward': {
    name: 'hearth-ward', role: 'FIREWALL',
    services: [
      { port: '21/tcp', state: 'open', service: 'rune-ftp', version: 'emberd 0.9.2' },
      { port: '1337/tcp', state: 'open', service: 'glyph-shell', version: '1.0.0', vuln: '2026-11-0777' },
    ],
  },
  registry: { name: 'registry', role: 'GOD-TIER LOCK', services: [] },
};

export const MISCONFIG_PASSWORD_SCROLL = 'vault.spire:/etc/weave/passwd (world-readable)';

export const KEYS = {
  MOVE: 'WASD', SPRINT: 'Shift', JUMP: 'Space', DODGE: 'Right-click',
  ATTACK: 'Left-click', CAST: '1', JACK_IN: 'Tab', FULLSCREEN: 'F1', FPS: 'F3',
} as const;

export const CAMERA = { ZOOM_MIN: 3.2, ZOOM_MAX: 9, LERP: 0.16 } as const;

export const MOVEMENT = {
  WALK_SPEED: 6.0, SPRINT_MULT: 1.6, JUMP_VELOCITY: 7.5, GRAVITY: -18.0,
  MAX_SERVER_DELTA_PER_TICK: 0.5, // server-side anticheat clamp (m/tick)
} as const;

export const COMBAT = {
  COMBO_STAGES: 3, DODGE_IFRAMES_MS: 300, DODGE_COOLDOWN_MS: 1200,
  CRIT_CHANCE: 0.10, BASE_DAMAGE: [12, 14, 20] as const,
} as const;

export const PARTY = { MAX: 4 } as const;
export const CHAT = { RATE_LIMIT: 10, RATE_WINDOW_SEC: 10 } as const;

// Pure trace math (unit-tested)
export function applyTrace(current: number, delta: number): number {
  return Math.max(0, Math.min(TRACE.MAX, current + delta));
}
export function decayTrace(current: number, seconds: number): number {
  return Math.max(0, current - TRACE.DECAY_PER_SEC * seconds);
}
export function traceState(value: number): 'idle' | 'watching' | 'alert' {
  if (value >= TRACE.MAX) return 'alert';
  if (value >= TRACE.WATCHING_THRESHOLD) return 'watching';
  return 'idle';
}
