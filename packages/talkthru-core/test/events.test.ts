import { describe, expect, it } from 'vitest';
import {
  eventsForWindow,
  formatEvent,
  isNotable,
  normaliseEvents,
  redactUrl,
  summariseEvents,
} from '../src/events.js';
import { EVENTS } from '../src/constants.js';
import type { TimedEvent } from '../src/types.js';

const net = (over: Partial<TimedEvent> = {}): TimedEvent => ({
  tMs: 1000,
  kind: 'network',
  method: 'GET',
  url: 'https://api.example.com/things',
  status: 200,
  ...over,
});

const con = (over: Partial<TimedEvent> = {}): TimedEvent => ({
  tMs: 1000,
  kind: 'console',
  level: 'log',
  text: 'hello',
  ...over,
});

describe('normaliseEvents: shape', () => {
  it('parses the canonical wrapper', () => {
    const out = normaliseEvents({
      version: 1,
      events: [
        { tMs: 1200, kind: 'network', method: 'post', url: 'https://api.example.com/checkout', status: 500, durationMs: 340 },
        { tMs: 1250, kind: 'console', level: 'error', text: 'TypeError: undefined is not an object' },
      ],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({
      tMs: 1200,
      kind: 'network',
      method: 'POST',
      status: 500,
      durationMs: 340,
    });
    expect(out[1]).toMatchObject({ kind: 'console', level: 'error' });
  });

  it('accepts a bare array', () => {
    expect(normaliseEvents([{ tMs: 0, kind: 'console', text: 'x' }])).toHaveLength(1);
  });

  it('accepts an entries wrapper', () => {
    expect(normaliseEvents({ entries: [{ tMs: 0, kind: 'console', text: 'x' }] })).toHaveLength(1);
  });

  it('sorts by time', () => {
    const out = normaliseEvents([
      { tMs: 900, kind: 'console', text: 'b' },
      { tMs: 100, kind: 'console', text: 'a' },
    ]);
    expect(out.map((e) => e.tMs)).toEqual([100, 900]);
  });

  it('uppercases the method so GET and get group together', () => {
    expect(normaliseEvents([{ tMs: 0, kind: 'network', url: 'https://x.dev/', method: 'delete' }])[0]!.method).toBe(
      'DELETE',
    );
  });
});

describe('normaliseEvents: aliases', () => {
  it.each([['t'], ['timestampMs'], ['time']])('accepts %s as the timestamp', (key) => {
    expect(normaliseEvents([{ [key]: 500, kind: 'console', text: 'x' }])[0]!.tMs).toBe(500);
  });

  it.each([['message'], ['msg']])('accepts %s as console text', (key) => {
    expect(normaliseEvents([{ tMs: 0, kind: 'console', [key]: 'boom' }])[0]!.text).toBe('boom');
  });

  it('accepts severity as level', () => {
    expect(normaliseEvents([{ tMs: 0, kind: 'console', text: 'x', severity: 'WARN' }])[0]!.level).toBe('warn');
  });

  it.each([['statusCode'], ['responseCode']])('accepts %s as the status', (key) => {
    expect(normaliseEvents([{ tMs: 0, kind: 'network', url: 'https://x.dev/', [key]: 404 }])[0]!.status).toBe(404);
  });

  it.each([['duration'], ['elapsedMs']])('accepts %s as the duration', (key) => {
    expect(normaliseEvents([{ tMs: 0, kind: 'network', url: 'https://x.dev/', [key]: 12 }])[0]!.durationMs).toBe(12);
  });

  it.each([['xhr'], ['fetch'], ['request'], ['http']])('treats kind=%s as network', (kind) => {
    expect(normaliseEvents([{ tMs: 0, kind, url: 'https://x.dev/' }])[0]!.kind).toBe('network');
  });

  it('infers network from the presence of a url', () => {
    expect(normaliseEvents([{ tMs: 0, url: 'https://x.dev/' }])[0]!.kind).toBe('network');
  });

  it('infers console from the presence of a message', () => {
    expect(normaliseEvents([{ tMs: 0, message: 'boom' }])[0]!.kind).toBe('console');
  });
});

describe('normaliseEvents: failure behaviour', () => {
  it('never throws on malformed input', () => {
    for (const bad of [null, undefined, 42, 'str', {}, [], [null], [{}], { events: 'no' }]) {
      expect(() => normaliseEvents(bad)).not.toThrow();
    }
  });

  it('drops entries with no timestamp', () => {
    expect(normaliseEvents([{ kind: 'console', text: 'x' }])).toHaveLength(0);
  });

  it('drops a network entry with no url', () => {
    expect(normaliseEvents([{ tMs: 0, kind: 'network', status: 500 }])).toHaveLength(0);
  });

  it('drops a console entry with no text', () => {
    expect(normaliseEvents([{ tMs: 0, kind: 'console', level: 'error' }])).toHaveLength(0);
  });

  it('keeps good entries alongside bad ones', () => {
    const out = normaliseEvents([{ kind: 'console' }, { tMs: 5, kind: 'console', text: 'ok' }]);
    expect(out).toHaveLength(1);
  });

  it('clamps a negative timestamp to zero', () => {
    expect(normaliseEvents([{ tMs: -20, kind: 'console', text: 'x' }])[0]!.tMs).toBe(0);
  });

  it('drops a negative duration rather than reporting it', () => {
    expect(normaliseEvents([{ tMs: 0, kind: 'network', url: 'https://x.dev/', durationMs: -5 }])[0]!.durationMs).toBeUndefined();
  });

  it('truncates a huge console message', () => {
    const out = normaliseEvents([{ tMs: 0, kind: 'console', text: 'x'.repeat(5000) }]);
    expect(out[0]!.text!.length).toBeLessThanOrEqual(EVENTS.MAX_TEXT_CHARS);
  });

  it('collapses newlines so a stack trace stays one line', () => {
    const out = normaliseEvents([{ tMs: 0, kind: 'console', text: 'Error\n  at foo\n  at bar' }]);
    expect(out[0]!.text).toBe('Error at foo at bar');
  });

  it('ignores unknown fields', () => {
    const out = normaliseEvents([{ tMs: 0, kind: 'console', text: 'x', extra: true }]);
    expect(out[0]).not.toHaveProperty('extra');
  });
});

describe('redactUrl', () => {
  it('leaves a clean url alone', () => {
    expect(redactUrl('https://api.example.com/v1/orders')).toBe('https://api.example.com/v1/orders');
  });

  it.each([
    'token',
    'access_token',
    'api_key',
    'apiKey',
    'secret',
    'password',
    'auth',
    'signature',
    'sessionId',
    'credential',
  ])('redacts the %s parameter value', (param) => {
    const out = redactUrl(`https://api.example.com/v1?${param}=supersecret123`);
    expect(out).not.toContain('supersecret123');
    expect(out).toContain(EVENTS.REDACTED);
  });

  it('keeps the parameter name, which is diagnostic', () => {
    expect(redactUrl('https://x.dev/?access_token=abc')).toContain('access_token');
  });

  it('leaves harmless parameters intact', () => {
    const out = redactUrl('https://x.dev/?page=2&sort=desc&token=abc');
    expect(out).toContain('page=2');
    expect(out).toContain('sort=desc');
    expect(out).not.toContain('abc');
  });

  it('strips user:pass out of the authority', () => {
    const out = redactUrl('https://admin:hunter2@x.dev/thing');
    expect(out).not.toContain('hunter2');
    expect(out).not.toContain('admin');
  });

  it('redacts a token carried in the fragment', () => {
    const out = redactUrl('https://x.dev/cb#access_token=abc123&state=xyz');
    expect(out).not.toContain('abc123');
  });

  it('still redacts when the url will not parse', () => {
    const out = redactUrl('/relative/path?api_key=abc123&page=1');
    expect(out).not.toContain('abc123');
    expect(out).toContain('page=1');
  });

  it('returns an unparseable url with no query unchanged', () => {
    expect(redactUrl('not a url at all')).toBe('not a url at all');
  });

  it('is applied by normaliseEvents, not left to the caller', () => {
    const out = normaliseEvents([{ tMs: 0, kind: 'network', url: 'https://x.dev/?token=leaky' }]);
    expect(out[0]!.url).not.toContain('leaky');
  });
});

describe('isNotable', () => {
  it('counts a 500 as notable', () => {
    expect(isNotable(net({ status: 500 }))).toBe(true);
  });

  it('counts a 404 as notable', () => {
    expect(isNotable(net({ status: 404 }))).toBe(true);
  });

  it('counts a request that never completed as notable', () => {
    expect(isNotable(net({ status: 0 }))).toBe(true);
  });

  it('does not count a 200', () => {
    expect(isNotable(net({ status: 200 }))).toBe(false);
  });

  it('does not count a 304', () => {
    expect(isNotable(net({ status: 304 }))).toBe(false);
  });

  it('does not count a request with no status at all', () => {
    expect(isNotable(net({ status: undefined }))).toBe(false);
  });

  it.each([['error'], ['warn']])('counts a console %s', (level) => {
    expect(isNotable(con({ level }))).toBe(true);
  });

  it.each([['log'], ['info'], ['debug']])('does not count a console %s', (level) => {
    expect(isNotable(con({ level }))).toBe(false);
  });

  it('does not count a console line with no level', () => {
    expect(isNotable(con({ level: undefined }))).toBe(false);
  });
});

describe('eventsForWindow', () => {
  const events = normaliseEvents([
    { tMs: 1000, kind: 'network', url: 'https://x.dev/a', status: 500 },
    { tMs: 4000, kind: 'network', url: 'https://x.dev/b', status: 200 },
    { tMs: 9000, kind: 'console', level: 'error', text: 'boom' },
    { tMs: 30_000, kind: 'network', url: 'https://x.dev/c', status: 500 },
  ]);

  it('returns nothing when there are no events', () => {
    expect(eventsForWindow([], 0, 1000)).toEqual([]);
  });

  it('reaches backwards, because the failure precedes the complaint', () => {
    // Utterance at 5s; the 500 at 1s is 4s earlier and inside the lookbehind.
    const out = eventsForWindow(events, 5000, 6000);
    expect(out.map((e) => e.url)).toContain('https://x.dev/a');
  });

  it('does not reach back further than the lookbehind', () => {
    const out = eventsForWindow(events, 20_000, 21_000);
    expect(out).toHaveLength(0);
  });

  it('excludes events after the utterance ends', () => {
    const out = eventsForWindow(events, 1000, 2000);
    expect(out.map((e) => e.tMs)).not.toContain(30_000);
  });

  it('filters to notable events by default', () => {
    const out = eventsForWindow(events, 5000, 6000);
    expect(out.every(isNotable)).toBe(true);
    expect(out.map((e) => e.url)).not.toContain('https://x.dev/b');
  });

  it('returns everything in the window when asked', () => {
    const out = eventsForWindow(events, 5000, 6000, { includeAll: true });
    expect(out.map((e) => e.url)).toContain('https://x.dev/b');
  });

  it('honours the lookbehind override', () => {
    const out = eventsForWindow(events, 20_000, 21_000, { lookbehindMs: 20_000 });
    expect(out.length).toBeGreaterThan(0);
  });

  it('caps the number returned', () => {
    const many = normaliseEvents(
      Array.from({ length: 50 }, (_, i) => ({ tMs: 1000 + i * 10, kind: 'network', url: `https://x.dev/${i}`, status: 500 })),
    );
    expect(eventsForWindow(many, 1200, 1300)).toHaveLength(EVENTS.MAX_PER_ENTRY);
  });

  it('keeps the events nearest what was said when over budget', () => {
    // The one fired mid-sentence matters more than one at the edge of the window.
    const many = normaliseEvents(
      Array.from({ length: 50 }, (_, i) => ({ tMs: 1000 + i * 100, kind: 'network', url: `https://x.dev/${i}`, status: 500 })),
    );
    const out = eventsForWindow(many, 5000, 5200, { max: 3 });
    const mid = 5100;
    for (const ev of out) expect(Math.abs(ev.tMs - mid)).toBeLessThan(1000);
  });

  it('returns the picked events in time order, not distance order', () => {
    const many = normaliseEvents(
      Array.from({ length: 20 }, (_, i) => ({ tMs: 1000 + i * 100, kind: 'network', url: `https://x.dev/${i}`, status: 500 })),
    );
    const out = eventsForWindow(many, 2000, 2400, { max: 4 });
    expect(out.map((e) => e.tMs)).toEqual([...out.map((e) => e.tMs)].sort((a, b) => a - b));
  });

  it('returns nothing when max is zero', () => {
    expect(eventsForWindow(events, 5000, 6000, { max: 0 })).toEqual([]);
  });

  it('tolerates an end before the start', () => {
    expect(() => eventsForWindow(events, 5000, 1000)).not.toThrow();
  });
});

describe('formatEvent', () => {
  it('renders a failed request', () => {
    expect(formatEvent(net({ method: 'POST', url: 'https://api.x.dev/checkout', status: 500, durationMs: 340 }))).toBe(
      'POST https://api.x.dev/checkout 500 340ms',
    );
  });

  it('says "failed" rather than "0" for a request that never completed', () => {
    expect(formatEvent(net({ status: 0, durationMs: undefined }))).toContain('failed');
    expect(formatEvent(net({ status: 0, durationMs: undefined }))).not.toContain(' 0');
  });

  it('defaults the method to GET', () => {
    expect(formatEvent(net({ method: undefined, status: 200, durationMs: undefined }))).toMatch(/^GET /);
  });

  it('omits the duration when unknown', () => {
    expect(formatEvent(net({ durationMs: undefined }))).not.toContain('ms');
  });

  it('renders a console line with its level', () => {
    expect(formatEvent(con({ level: 'error', text: 'boom' }))).toBe('error: boom');
  });

  it('renders a console line with no level', () => {
    expect(formatEvent(con({ level: undefined, text: 'boom' }))).toBe('boom');
  });
});

describe('summariseEvents', () => {
  it('returns null when nothing was captured', () => {
    expect(summariseEvents([])).toBeNull();
  });

  it('counts requests and failures', () => {
    const out = summariseEvents([net({ status: 200 }), net({ status: 500 }), net({ status: 404 })]);
    expect(out).toContain('3 requests');
    expect(out).toContain('2 failed');
  });

  it('counts console lines and errors', () => {
    const out = summariseEvents([con({ level: 'log' }), con({ level: 'error' })]);
    expect(out).toContain('2 console lines');
    expect(out).toContain('1 error/warn');
  });

  it('uses the singular for one', () => {
    expect(summariseEvents([net({ status: 200 })])).toContain('1 request ');
  });

  it('reports both kinds together', () => {
    const out = summariseEvents([net({ status: 500 }), con({ level: 'error' })])!;
    expect(out).toContain('request');
    expect(out).toContain('console');
  });
});
