// Snapshot interpolation shared by remote players (2.2) and mobs (3.2).
// Allocation-free: samples write into a caller-owned object.

export type Snap = { x: number; y: number; z: number; yaw: number; t: number };

export const INTERP_MS = 100;
export const MAX_SNAPS = 3;

export function lerpAngle(a: number, b: number, t: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

// Newest-last buffer; renderT trails the newest snapshot by INTERP_MS.
export function sampleSnaps(snaps: Snap[], renderT: number, out: Snap): void {
  const n = snaps.length;
  if (n === 0) return;
  const latest = snaps[n - 1]!;
  if (n >= 2) {
    const a = snaps[n - 2]!;
    const span = latest.t - a.t;
    const alpha = span > 0 ? Math.min(1, Math.max(0, (renderT - a.t) / span)) : 1;
    out.x = a.x + (latest.x - a.x) * alpha;
    out.y = a.y + (latest.y - a.y) * alpha;
    out.z = a.z + (latest.z - a.z) * alpha;
    out.yaw = lerpAngle(a.yaw, latest.yaw, alpha);
  } else {
    out.x = latest.x; out.y = latest.y; out.z = latest.z; out.yaw = latest.yaw;
  }
}

export function pushSnap(snaps: Snap[], x: number, y: number, z: number, yaw: number, now: number): void {
  snaps.push({ x, y, z, yaw, t: now });
  if (snaps.length > MAX_SNAPS) snaps.shift();
}
