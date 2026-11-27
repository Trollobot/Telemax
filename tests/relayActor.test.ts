import { describe, expect, it } from 'vitest';
import { relayActor } from '../src/bridge/sync.js';

describe('relayActor (RELAY=admins)', () => {
  const group = '-1001';
  it('names the sender of a message, an edit and a reaction', () => {
    expect(relayActor({ message: { from: { id: 5 } } }, group)).toEqual({ kind: 'user', userId: 5, what: 'message' });
    expect(relayActor({ edited_message: { from: { id: 6 } } }, group)).toEqual({ kind: 'user', userId: 6, what: 'edit' });
    expect(relayActor({ message_reaction: { user: { id: 7 } } }, group)).toEqual({ kind: 'user', userId: 7, what: 'reaction' });
  });

  it('passes an anonymous admin (posting as the bridge group), but not another chat posting as itself', () => {
    expect(relayActor({ message: { from: { id: 1087968824 }, sender_chat: { id: -1001 } } }, group)).toEqual({ kind: 'anonymous-admin' });
    expect(relayActor({ message_reaction: { actor_chat: { id: -1001 } } }, group)).toEqual({ kind: 'anonymous-admin' });
    expect(relayActor({ message: { from: { id: 136817688 }, sender_chat: { id: -1002 } } }, group)).toEqual({ kind: 'user', userId: 136817688, what: 'message' });
  });

  it('fails closed without a sender and ignores other updates', () => {
    expect(relayActor({ message_reaction: { actor_chat: { id: -1002 } } }, group)).toEqual({ kind: 'unknown' });
    expect(relayActor({}, group)).toEqual({ kind: 'none' });
  });
});
