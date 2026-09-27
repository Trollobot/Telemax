import { describe, expect, it } from 'vitest';
import { classifyProbeResult, isReactionInvalid, probeIntervalMs, probeLinkGuard } from '../src/bridge/sync.js';
import { isThreadNotFound } from '../src/bridge/transient.js';

describe('probeIntervalMs (decay ladder)', () => {
  it('pings densely right after send (hot phase)', () => {
    expect(probeIntervalMs(0)).toBe(15_000);
    expect(probeIntervalMs(90_000)).toBe(15_000); // 1.5 min
  });

  it('steps out as the message ages', () => {
    expect(probeIntervalMs(5 * 60_000)).toBe(60_000); // 5 min -> every minute
    expect(probeIntervalMs(30 * 60_000)).toBe(5 * 60_000); // 30 min -> every 5 min
    expect(probeIntervalMs(3 * 60 * 60_000)).toBe(30 * 60_000); // 3 h -> every 30 min
  });

  it('stops probing after 6 hours (cooled off)', () => {
    expect(probeIntervalMs(6 * 60 * 60_000)).toBeNull();
    expect(probeIntervalMs(24 * 60 * 60_000)).toBeNull();
  });

  it('is monotonic — intervals never shrink with age', () => {
    const samples = [0, 60_000, 5 * 60_000, 30 * 60_000, 3 * 60 * 60_000];
    const intervals = samples.map((a) => probeIntervalMs(a) ?? Infinity);
    for (let i = 1; i < intervals.length; i++) {
      expect(intervals[i] as number).toBeGreaterThanOrEqual(intervals[i - 1] as number);
    }
  });
});

describe('classifyProbeResult', () => {
  it('reports a live message from REACTION_EMPTY', () => {
    expect(classifyProbeResult('Bad Request: REACTION_EMPTY')).toBe('alive');
    expect(classifyProbeResult('400: bad request: reaction_empty')).toBe('alive');
  });

  it('reports a deleted message from the known not-found / invalid-id shapes', () => {
    expect(classifyProbeResult('Bad Request: message to react not found')).toBe('gone'); // deleted bot message
    expect(classifyProbeResult('Bad Request: message not found')).toBe('gone');
    expect(classifyProbeResult('Bad Request: message to delete not found')).toBe('gone');
    expect(classifyProbeResult('Bad Request: MESSAGE_ID_INVALID')).toBe('gone'); // deleted USER message (confirmed live 2026-08-15)
  });

  it('NEVER reports gone on rate-limit or network errors (would delete a live message)', () => {
    // This is the safety-critical case: a false 'gone' irreversibly deletes on MAX.
    expect(classifyProbeResult('Too Many Requests: retry after 42')).toBe('unknown');
    expect(classifyProbeResult('EFATAL: socket hang up')).toBe('unknown');
    expect(classifyProbeResult('Bad Gateway')).toBe('unknown');
    expect(classifyProbeResult('')).toBe('unknown');
    expect(classifyProbeResult('chat not found')).toBe('unknown'); // whole chat gone != message deleted
  });
});

describe('isThreadNotFound (topic-gone detector, shared by restore and the probe)', () => {
  it('recognizes a deleted topic in every shape Telegram answers', () => {
    expect(isThreadNotFound(new Error('400: Bad Request: message thread not found'))).toBe(true);
    expect(isThreadNotFound('Bad Request: message thread not found')).toBe(true); // description string
    expect(isThreadNotFound('Bad Request: TOPIC_ID_INVALID')).toBe(true); // editForumTopic (live 2026-08-18)
    expect(isThreadNotFound('Bad Request: TOPIC_DELETED')).toBe(true);
  });

  it('never reads throttling/network/other errors as a deleted topic', () => {
    expect(isThreadNotFound('Too Many Requests: retry after 5')).toBe(false);
    expect(isThreadNotFound(new Error('EFATAL: socket hang up'))).toBe(false);
    expect(isThreadNotFound('Bad Request: message to react not found')).toBe(false);
    expect(isThreadNotFound('')).toBe(false);
  });
});

describe('isReactionInvalid', () => {
  it('flags an emoji Telegram refuses, not a missing message', () => {
    expect(isReactionInvalid('Bad Request: REACTION_INVALID')).toBe(true);
    expect(isReactionInvalid('400: bad request: reaction_invalid')).toBe(true);
    expect(isReactionInvalid('Bad Request: message to react not found')).toBe(false);
    expect(isReactionInvalid('Bad Request: REACTION_EMPTY')).toBe(false);
  });
});

describe('probeLinkGuard', () => {
  const mapping = { telegramTopicId: 42 };

  it('probes a link whose chat and topic are unchanged', () => {
    expect(probeLinkGuard({ telegramTopicId: 42 }, mapping)).toBe('probe');
    expect(probeLinkGuard({}, mapping)).toBe('probe'); // untagged link: topic check happens later
  });

  it('drops links of an unmapped (closed/rebooted) or banned chat', () => {
    expect(probeLinkGuard({ telegramTopicId: 42 }, undefined)).toBe('drop');
    expect(probeLinkGuard({ telegramTopicId: 42 }, { telegramTopicId: 42, banned: true })).toBe('drop');
  });

  it('drops a link written in a topic that has since been recreated', () => {
    expect(probeLinkGuard({ telegramTopicId: 41 }, mapping)).toBe('drop');
  });
});
