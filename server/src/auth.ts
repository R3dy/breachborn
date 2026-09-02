// Auth: guest identity — name sanitation/validation, HMAC session tokens,
// deterministic duplicate-name suffixes (story 2.1). Pure — transport in index.ts.
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const SECRET = process.env.BREACHBORN_SECRET ?? 'breachborn-dev-secret';

export const TOKEN_TTL_SEC = 30 * 24 * 60 * 60; // 30 days
export const NAME_MIN = 3;
export const NAME_MAX = 16;

export type TokenPayload = { charId: string; iat: number };

function b64url(buf: Buffer): string {
  return buf.toString('base64url');
}

// Token format: `<charId>.<iat>.<hmac-b64url(charId.iat)>`
export function issueToken(charId: string, nowMs: number = Date.now()): string {
  const iat = Math.floor(nowMs / 1000);
  const body = `${charId}.${iat}`;
  const sig = b64url(createHmac('sha256', SECRET).update(body).digest());
  return `${body}.${sig}`;
}

// Returns the payload when signature + expiry check out, else null.
export function verifyToken(token: string, nowMs: number = Date.now()): TokenPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const charId = parts[0];
  const iatRaw = parts[1];
  const sig = parts[2];
  if (!charId || !iatRaw || !sig || charId.length === 0) return null;
  const expected = b64url(createHmac('sha256', SECRET).update(`${charId}.${iatRaw}`).digest());
  const a = Buffer.from(sig, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const iat = Number(iatRaw);
  if (!Number.isInteger(iat) || iat < 0) return null;
  if (nowMs / 1000 - iat > TOKEN_TTL_SEC) return null;
  return { charId, iat };
}

export function newCharId(): string {
  return randomBytes(8).toString('hex');
}

// `wraith-XXXX` fallback for empty/invalid names (canon: docs/environment.md).
export function fallbackName(): string {
  return `wraith-${randomBytes(2).toString('hex')}`;
}

const HTML_ENTITIES: Record<string, string> = {
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
};

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => HTML_ENTITIES[c] ?? c);
}

// Strip control/format/invisible unicode, collapse whitespace runs, trim.
export function sanitizeName(raw: string): string {
  const stripped = raw.replace(/[\p{C}]/gu, '');
  return stripped.replace(/\s+/g, ' ').trim();
}

// Full validation → wire-safe (HTML-escaped) name, or null when out of 3-16.
export function validateName(raw: string): string | null {
  const clean = sanitizeName(raw);
  if (clean.length < NAME_MIN || clean.length > NAME_MAX) return null;
  return escapeHtml(clean);
}

// Deterministic duplicate suffix `#NNNN`: FNV-1a of the base name seeds the
// probe, then linear probing while a candidate is taken (same world state →
// same suffix, always).
export function dedupeName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  let h = 2166136261;
  for (let i = 0; i < base.length; i++) {
    h ^= base.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const seed = h >>> 0;
  for (let i = 0; i < 10000; i++) {
    const cand = `${base}#${String((seed + i) % 10000).padStart(4, '0')}`;
    if (!taken.has(cand)) return cand;
  }
  // World full of collisions for this base — fall back to a time-salted value.
  return `${base}#${String((seed ^ (Date.now() & 0xffff)) % 10000).padStart(4, '0')}`;
}
