// Social: chat sanitation + sliding-window rate limiting, emote whitelist,
// party lifecycle (invite/accept/leave, MAX 4). Pure — transport in index.ts.
// Story 2.3.
import { CHAT, PARTY } from '@breachborn/shared';
import { escapeHtml } from './auth.ts';

export const EMOTES = ['wave', 'dance', 'point'] as const;
export type EmoteName = (typeof EMOTES)[number];

export function isEmote(v: unknown): v is EmoteName {
  return typeof v === 'string' && (EMOTES as readonly string[]).includes(v);
}

// Structural view of a char — World's Char satisfies this; lets Social stay
// decoupled (and unit-testable) from the World class.
export type PartyChar = { charId: string; name: string; partyId?: string };
export type Resolver = (charId: string) => PartyChar | undefined;

export type OpFail = { ok: false; code: string; message: string };
export type OpOk = { ok: true };
export type MembersOk = { ok: true; memberIds: string[] };
export type MembersResult = MembersOk | OpFail;

// HTML-entity escape → inert text for any HTML consumer. Length-capped.
export function sanitizeChat(text: string): string {
  return escapeHtml(text.slice(0, 240));
}

export class Social {
  private windows = new Map<string, number[]>();
  private parties = new Map<string, Set<string>>();
  private pending = new Map<string, string>(); // targetId → inviterId
  private nextPartyId = 1;

  // Sliding window: CHAT.RATE_LIMIT messages per CHAT.RATE_WINDOW_SEC.
  // The 11th message inside the window is denied.
  allowChat(charId: string, now: number): boolean {
    const cutoff = now - CHAT.RATE_WINDOW_SEC * 1000;
    const prev = this.windows.get(charId);
    const kept: number[] = [];
    if (prev) for (const ts of prev) if (ts > cutoff) kept.push(ts);
    if (kept.length >= CHAT.RATE_LIMIT) {
      this.windows.set(charId, kept);
      return false;
    }
    kept.push(now);
    this.windows.set(charId, kept);
    return true;
  }

  // Stage an invite. Name→char resolution happens in the transport layer;
  // `target` here is already resolved (or the invite never reaches us).
  stageInvite(inviter: PartyChar, target: PartyChar): OpOk | OpFail {
    if (target.charId === inviter.charId) {
      return { ok: false, code: 'no-such-soul', message: 'no soul by that name on this shard' };
    }
    if (inviter.partyId) {
      const p = this.parties.get(inviter.partyId);
      if (p && p.size >= PARTY.MAX) {
        return { ok: false, code: 'party-full', message: 'your party is full' };
      }
    }
    if (target.partyId) {
      return { ok: false, code: 'already-in-party', message: `${target.name} is already in a party` };
    }
    this.pending.set(target.charId, inviter.charId);
    return { ok: true };
  }

  // Accept the pending invite. Both chars' partyId is mutated in place
  // (shared-quest-credit stub reads char.partyId).
  acceptInvite(target: PartyChar, resolve: Resolver): MembersResult {
    const inviterId = this.pending.get(target.charId);
    this.pending.delete(target.charId);
    if (!inviterId) return { ok: false, code: 'invite-expired', message: 'no pending invite' };
    const inviter = resolve(inviterId);
    if (!inviter) {
      return { ok: false, code: 'invite-expired', message: 'the one who invited you has left the shard' };
    }
    if (target.partyId) return { ok: false, code: 'already-in-party', message: 'you are already in a party' };
    // The inviter may have joined a party (or partied up with someone else)
    // between invite and accept — join their current party, else form one.
    const partyId = inviter.partyId ?? this.createParty(inviter);
    const members = this.parties.get(partyId);
    if (!members) return { ok: false, code: 'party-gone', message: 'that party no longer exists' };
    if (members.size >= PARTY.MAX) {
      return { ok: false, code: 'party-full', message: 'that party is full' };
    }
    members.add(target.charId);
    target.partyId = partyId;
    return { ok: true, memberIds: [...members] };
  }

  leave(member: PartyChar): MembersResult {
    const partyId = member.partyId;
    if (!partyId) return { ok: false, code: 'no-party', message: 'you are not in a party' };
    member.partyId = undefined;
    const members = this.parties.get(partyId);
    if (!members) return { ok: true, memberIds: [] };
    members.delete(member.charId);
    if (members.size === 0) {
      this.parties.delete(partyId);
      return { ok: true, memberIds: [] };
    }
    return { ok: true, memberIds: [...members] };
  }

  memberIdsOf(partyId: string): string[] {
    const m = this.parties.get(partyId);
    return m ? [...m] : [];
  }

  private createParty(first: PartyChar): string {
    const id = `p${this.nextPartyId++}`;
    this.parties.set(id, new Set([first.charId]));
    first.partyId = id;
    return id;
  }
}
