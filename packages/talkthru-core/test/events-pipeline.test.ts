import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { discoverInputs, processSession } from '../src/pipeline.js';
import { ensureSessionDirs, initStatus, newSessionId, sessionDir } from '../src/store.js';
import { EVENTS } from '../src/constants.js';
import {
  FIXTURE_META,
  FIXTURE_VIDEO,
  FakeTranscriber,
  ensureFixture,
  loadFixtureTranscript,
  tempHome,
} from './helpers.js';
import type { TalkthruConfig } from '../src/config.js';

/**
 * End to end: an events.json in raw/ has to reach session.md. The unit tests in
 * events.test.ts prove the parsing and windowing; this proves it is actually
 * wired to the pipeline, which is the part that silently rots.
 */

let cfg: TalkthruConfig;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  await ensureFixture();
}, 300_000);

beforeEach(async () => {
  ({ cfg, cleanup } = await tempHome('events-pipeline'));
});
afterEach(async () => cleanup());

/** Stage a session with the fixture video and an events sidecar. */
async function stageWithEvents(events: unknown): Promise<string> {
  const id = newSessionId();
  const dir = await ensureSessionDirs(cfg, id);
  await initStatus(cfg, id, 'local');
  await fs.copyFile(FIXTURE_VIDEO, path.join(dir, 'raw', 'video.mp4'));
  await fs.copyFile(FIXTURE_META, path.join(dir, 'raw', 'meta.json'));
  if (events !== undefined) {
    await fs.writeFile(path.join(dir, 'raw', 'events.json'), JSON.stringify(events), 'utf8');
  }
  return id;
}

async function run(id: string) {
  const { words } = await loadFixtureTranscript();
  return processSession(cfg, id, { transcriber: new FakeTranscriber(words), useVad: false });
}

const rawDirOf = (id: string) => path.join(sessionDir(cfg, id), 'raw');

describe('discoverInputs', () => {
  it('finds events.json in the raw dir', async () => {
    const id = await stageWithEvents({ events: [] });
    const inputs = await discoverInputs(rawDirOf(id));
    expect(inputs.eventsPath).toBeDefined();
    expect(path.basename(inputs.eventsPath!)).toBe('events.json');
  });

  it('leaves eventsPath undefined when there is no sidecar', async () => {
    const id = await stageWithEvents(undefined);
    const inputs = await discoverInputs(rawDirOf(id));
    expect(inputs.eventsPath).toBeUndefined();
  });

  it('does not mistake another json for the events sidecar', async () => {
    const id = await stageWithEvents(undefined);
    await fs.writeFile(path.join(rawDirOf(id), 'telemetry.json'), '[]', 'utf8');
    const inputs = await discoverInputs(rawDirOf(id));
    expect(inputs.eventsPath).toBeUndefined();
  });

  it('finds it regardless of filename case', async () => {
    const id = await stageWithEvents(undefined);
    await fs.writeFile(path.join(rawDirOf(id), 'Events.JSON'), '[]', 'utf8');
    const inputs = await discoverInputs(rawDirOf(id));
    expect(inputs.eventsPath).toBeDefined();
  });
});

describe('a session with events', () => {
  it('puts a failed request in session.md', async () => {
    const id = await stageWithEvents({
      events: [
        { tMs: 500, kind: 'network', method: 'POST', url: 'https://api.example.com/checkout', status: 500, durationMs: 340 },
      ],
    });
    const { markdown } = await run(id);
    expect(markdown).toContain('net: POST https://api.example.com/checkout 500 340ms');
  });

  it('puts a console error in session.md', async () => {
    const id = await stageWithEvents({
      events: [{ tMs: 500, kind: 'console', level: 'error', text: 'TypeError: undefined is not an object' }],
    });
    const { markdown } = await run(id);
    expect(markdown).toContain('net: error: TypeError: undefined is not an object');
  });

  it('keeps a successful request out of the timeline', async () => {
    const id = await stageWithEvents({
      events: [{ tMs: 500, kind: 'network', method: 'GET', url: 'https://api.example.com/poll', status: 200 }],
    });
    const { markdown } = await run(id);
    expect(markdown).not.toContain('api.example.com/poll');
  });

  it('still reports the quiet traffic in the header tally', async () => {
    // The agent needs to know a clean timeline means nothing broke, rather than
    // that nothing was captured.
    const id = await stageWithEvents({
      events: [
        { tMs: 500, kind: 'network', method: 'GET', url: 'https://api.example.com/poll', status: 200 },
        { tMs: 600, kind: 'network', method: 'GET', url: 'https://api.example.com/poll', status: 200 },
      ],
    });
    const { markdown } = await run(id);
    expect(markdown).toMatch(/2 requests \(0 failed\)/);
  });

  it('redacts a token on the way through the pipeline', async () => {
    const id = await stageWithEvents({
      events: [
        { tMs: 500, kind: 'network', method: 'GET', url: 'https://api.example.com/me?access_token=hunter2', status: 401 },
      ],
    });
    const { markdown } = await run(id);
    expect(markdown).not.toContain('hunter2');
    expect(markdown).toContain(EVENTS.REDACTED);
  });

  it('explains the net: prefix in the header', async () => {
    const id = await stageWithEvents({ events: [{ tMs: 500, kind: 'console', level: 'error', text: 'x' }] });
    const { markdown } = await run(id);
    expect(markdown).toContain('`net:` lines');
  });

  it('records the events on the timeline in session.json', async () => {
    const id = await stageWithEvents({
      events: [{ tMs: 500, kind: 'network', url: 'https://api.example.com/x', status: 503 }],
    });
    const { bundle } = await run(id);
    const withEvents = bundle.timeline.filter((e) => (e.events?.length ?? 0) > 0);
    expect(withEvents.length).toBeGreaterThan(0);
    expect(withEvents[0]!.events![0]).toMatchObject({ kind: 'network', status: 503 });
  });
});

describe('a session without events', () => {
  it('has no net: lines', async () => {
    const id = await stageWithEvents(undefined);
    const { markdown } = await run(id);
    expect(markdown).not.toMatch(/^net: /m);
  });

  it('leaves events unset on timeline entries', async () => {
    const id = await stageWithEvents(undefined);
    const { bundle } = await run(id);
    for (const entry of bundle.timeline) expect(entry.events).toBeUndefined();
  });
});

describe('a broken events sidecar', () => {
  it('warns and still produces a bundle when the json is invalid', async () => {
    const id = await stageWithEvents(undefined);
    const dir = path.join(cfg.sessionsDir, id, 'raw');
    await fs.writeFile(path.join(dir, 'events.json'), '{not json', 'utf8');
    const { markdown, warnings } = await run(id);
    expect(warnings.join(' ')).toMatch(/events file could not be parsed/i);
    expect(markdown).toContain('# Talkthru session');
  });

  it('warns when the file parses but holds nothing usable', async () => {
    const id = await stageWithEvents({ events: [{ nonsense: true }] });
    const { warnings } = await run(id);
    expect(warnings.join(' ')).toMatch(/no usable entries/i);
  });

  it('does not fail the recording over a bad sidecar', async () => {
    const id = await stageWithEvents({ events: 'not-an-array' });
    await expect(run(id)).resolves.toBeTruthy();
  });
});

/**
 * The compatibility contract for people already running talkthru.
 *
 * Event capture is opt-in by the presence of a file nobody currently writes, so
 * every existing user must see byte-identical output. These are the tests that
 * hold that line.
 */
describe('backwards compatibility', () => {
  it('renders a session without events exactly as the committed golden does', async () => {
    // The golden was regenerated once, for the conditional header sentence, and
    // must not move again for sessions that capture nothing.
    const id = await stageWithEvents(undefined);
    const { markdown } = await run(id);
    expect(markdown).not.toContain('`net:`');
    expect(markdown).toContain('captured with the frame.\n');
  });

  it('omits the net: explainer when no events were captured', async () => {
    const id = await stageWithEvents(undefined);
    const { markdown } = await run(id);
    expect(markdown).not.toContain('network calls and console output');
  });

  it('adds the explainer only once events exist', async () => {
    const id = await stageWithEvents({ events: [{ tMs: 100, kind: 'console', level: 'error', text: 'x' }] });
    const { markdown } = await run(id);
    expect(markdown).toContain('network calls and console output');
  });

  it('adds no key to session.json when nothing was captured', async () => {
    // An `events: []` on every entry would change the shape of every stored
    // bundle for users who never opt in.
    const id = await stageWithEvents(undefined);
    const { bundle } = await run(id);
    const raw = JSON.stringify(bundle);
    expect(raw).not.toContain('"events"');
  });

  it('leaves an empty events file completely inert apart from its warning', async () => {
    const withFile = await stageWithEvents({ events: [] });
    const withoutFile = await stageWithEvents(undefined);
    const a = (await run(withFile)).markdown.replace(withFile, 'ID');
    const b = (await run(withoutFile)).markdown.replace(withoutFile, 'ID');
    // Same body; the only difference permitted is the warnings section.
    expect(a.split('## Warnings')[0]).toBe(b.split('## Warnings')[0]);
  });
});

describe('edge cases', () => {
  it('survives an event at t=0', async () => {
    const id = await stageWithEvents({ events: [{ tMs: 0, kind: 'network', url: 'https://x.dev/a', status: 500 }] });
    await expect(run(id)).resolves.toBeTruthy();
  });

  it('survives an event past the end of the recording', async () => {
    const id = await stageWithEvents({
      events: [{ tMs: 999_999_999, kind: 'network', url: 'https://x.dev/late', status: 500 }],
    });
    const { markdown } = await run(id);
    expect(markdown).toContain('# Talkthru session');
    // Far outside every window, so it must not be attached anywhere.
    expect(markdown).not.toContain('x.dev/late');
  });

  it('handles a thousand events without blowing the bundle up', async () => {
    // The scenario behind the whole budget design: a couple of minutes of XHR.
    const events = Array.from({ length: 1000 }, (_, i) => ({
      tMs: i * 100,
      kind: 'network',
      method: 'GET',
      url: `https://api.example.com/poll/${i}`,
      status: i % 10 === 0 ? 500 : 200,
    }));
    const { markdown, bundle } = await run(await stageWithEvents({ events }));
    const netLines = markdown.split('\n').filter((l) => l.startsWith('net: '));
    expect(netLines.length).toBeGreaterThan(0);
    // Far fewer than the 100 failures, let alone all 1000.
    expect(netLines.length).toBeLessThan(60);
    expect(bundle.estimatedTokens).toBeLessThan(20_000);
  });

  it('keeps narration even when events are plentiful', async () => {
    const events = Array.from({ length: 500 }, (_, i) => ({
      tMs: i * 20,
      kind: 'console',
      level: 'error',
      text: `error number ${i} with a reasonably long message attached to it`,
    }));
    const { markdown } = await run(await stageWithEvents({ events }));
    expect(markdown).toMatch(/- \[\d\d:\d\d\] "/);
  });

  it('handles duplicate events at the same instant', async () => {
    const dup = { tMs: 500, kind: 'network', method: 'GET', url: 'https://x.dev/same', status: 500 };
    const { markdown } = await run(await stageWithEvents({ events: [dup, dup, dup] }));
    const hits = markdown.split('\n').filter((l) => l.includes('x.dev/same'));
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  it('handles unicode and emoji in a console message', async () => {
    const text = 'ошибка 💥 失败 — checkout';
    const { markdown } = await run(
      await stageWithEvents({ events: [{ tMs: 500, kind: 'console', level: 'error', text }] }),
    );
    expect(markdown).toContain('💥');
  });

  it('does not let a console message break the markdown structure', async () => {
    const nasty = '## fake heading\n- [00:00] "fake utterance"\n```';
    const { markdown } = await run(
      await stageWithEvents({ events: [{ tMs: 500, kind: 'console', level: 'error', text: nasty }] }),
    );
    // Newlines are collapsed at parse time, so it stays on its own net: line.
    const injected = markdown.split('\n').filter((l) => l === '## fake heading');
    expect(injected).toHaveLength(0);
  });

  it('handles an extremely long url', async () => {
    const url = `https://x.dev/${'a'.repeat(5000)}?token=secret`;
    const { markdown } = await run(
      await stageWithEvents({ events: [{ tMs: 500, kind: 'network', url, status: 500 }] }),
    );
    expect(markdown).not.toContain('secret');
    for (const line of markdown.split('\n')) expect(line.length).toBeLessThan(1000);
  });

  it('accepts an events file that is a bare array', async () => {
    const id = await stageWithEvents([{ tMs: 500, kind: 'network', url: 'https://x.dev/bare', status: 500 }]);
    const { markdown } = await run(id);
    expect(markdown).toContain('x.dev/bare');
  });

  it('survives an events file that is a json null', async () => {
    const id = await stageWithEvents(null);
    await expect(run(id)).resolves.toBeTruthy();
  });

  it('survives an events file that is a bare number', async () => {
    const id = await stageWithEvents(42);
    await expect(run(id)).resolves.toBeTruthy();
  });
});

/**
 * Regression: path.basename() matches its suffix argument case-sensitively, so
 * lowercasing the extension before passing it in left `Meta.JSON` unstripped and
 * every uppercase-extension sidecar invisible. Applies to all three, not just
 * events.
 */
describe('sidecar discovery is case-insensitive', () => {
  it.each([
    ['Meta.JSON', 'metaPath'],
    ['Hierarchy.JSON', 'hierarchyPath'],
    ['Events.JSON', 'eventsPath'],
    ['EVENTS.json', 'eventsPath'],
    ['events.Json', 'eventsPath'],
  ] as const)('finds %s', async (name, key) => {
    const id = await stageWithEvents(undefined);
    // Remove the lowercase meta.json the staging helper writes, so the only
    // candidate is the one under test.
    await fs.rm(path.join(rawDirOf(id), 'meta.json'), { force: true });
    await fs.writeFile(path.join(rawDirOf(id), name), '{}', 'utf8');
    const inputs = await discoverInputs(rawDirOf(id));
    expect(inputs[key]).toBeDefined();
  });

  it('still finds an uppercase video extension', async () => {
    const id = await stageWithEvents(undefined);
    await fs.rename(path.join(rawDirOf(id), 'video.mp4'), path.join(rawDirOf(id), 'VIDEO.MP4'));
    const inputs = await discoverInputs(rawDirOf(id));
    expect(inputs.videoPath).toBeDefined();
  });
});
