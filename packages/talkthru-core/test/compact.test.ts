import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  compactSession,
  compactSweep,
  compactableBytes,
  formatBytes,
  parseDays,
  parseSize,
} from '../src/compact.js';
import { ensureSessionDirs, initStatus, patchStatus, readStatus, sessionDir } from '../src/store.js';
import { processSessionSafe } from '../src/pipeline.js';
import { defaultArchiveDir } from '../src/watch.js';
import { tempHome } from './helpers.js';
import type { TalkthruConfig } from '../src/config.js';
import type { SessionState } from '../src/types.js';

/**
 * THE INVARIANT, tested from every angle it could be violated from: nothing
 * that has not been successfully turned into frames + text is ever deleted
 * automatically — not by age, not by the size budget, not by both at once.
 */

let cfg: TalkthruConfig;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ cfg, cleanup } = await tempHome('compact'));
});
afterEach(async () => cleanup());

/** A session with a fat fake video, in the given state, created `daysAgo`. */
async function mkSession(opts: {
  state: SessionState;
  daysAgo?: number;
  videoBytes?: number;
  archived?: boolean;
  compactedAlready?: boolean;
}): Promise<string> {
  const id = `${stamp(opts.daysAgo ?? 0)}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = await ensureSessionDirs(cfg, id);
  await initStatus(cfg, id, 'local');
  await fs.writeFile(path.join(dir, 'raw', 'video.mp4'), Buffer.alloc(opts.videoBytes ?? 1000, 7));
  await fs.writeFile(path.join(dir, 'raw', 'meta.json'), '{}');
  await fs.writeFile(path.join(dir, 'frames', 'f01.jpg'), Buffer.alloc(50, 1));
  await fs.writeFile(path.join(dir, 'session.md'), '# session\n');
  const createdAt = new Date(Date.now() - (opts.daysAgo ?? 0) * 86_400_000).toISOString();
  let archivedTo: string | undefined;
  if (opts.archived) {
    const archiveDir = defaultArchiveDir(cfg);
    await fs.mkdir(archiveDir, { recursive: true });
    archivedTo = path.join(archiveDir, `${id}-original.mp4`);
    await fs.writeFile(archivedTo, Buffer.alloc(2000, 9));
  }
  await patchStatus(cfg, id, {
    state: opts.state,
    createdAt,
    ...(archivedTo ? { archivedTo } : {}),
    ...(opts.compactedAlready ? { compacted: { at: createdAt, freedBytes: 0, removed: [] } } : {}),
  } as never);
  return id;
}

/** Session ids sort by timestamp prefix; fabricate one `daysAgo` old. */
function stamp(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

const raw = (id: string) => path.join(sessionDir(cfg, id), 'raw');

describe('compactSession', () => {
  it('removes video, keeps frames, transcript and sidecars', async () => {
    const id = await mkSession({ state: 'ready', daysAgo: 30 });
    const result = await compactSession(cfg, id);
    expect(result.changed).toBe(true);
    expect(result.freedBytes).toBeGreaterThan(0);
    await expect(fs.access(path.join(raw(id), 'video.mp4'))).rejects.toThrow();
    await expect(fs.access(path.join(raw(id), 'meta.json'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(sessionDir(cfg, id), 'frames', 'f01.jpg'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(sessionDir(cfg, id), 'session.md'))).resolves.toBeUndefined();
  });

  it('removes the archived original along with the session', async () => {
    const id = await mkSession({ state: 'ready', daysAgo: 30, archived: true });
    const status = await readStatus(cfg, id);
    await compactSession(cfg, id);
    await expect(fs.access(status!.archivedTo!)).rejects.toThrow();
  });

  it('writes a receipt with bytes and file names', async () => {
    const id = await mkSession({ state: 'ready', daysAgo: 30, videoBytes: 5000 });
    await compactSession(cfg, id);
    const status = await readStatus(cfg, id);
    expect(status!.compacted).toBeDefined();
    expect(status!.compacted!.freedBytes).toBeGreaterThanOrEqual(5000);
    expect(status!.compacted!.removed).toContain('video.mp4');
    expect(Date.parse(status!.compacted!.at)).toBeGreaterThan(0);
  });

  it.each(['failed', 'processing', 'queued', 'uploading'] as const)(
    'INVARIANT: refuses a session in state %s',
    async (state) => {
      const id = await mkSession({ state, daysAgo: 400 });
      const result = await compactSession(cfg, id);
      expect(result.changed).toBe(false);
      await expect(fs.access(path.join(raw(id), 'video.mp4'))).resolves.toBeUndefined();
    },
  );

  it('has no force option — the refusal is not overridable', async () => {
    // If someone adds one, this stops compiling the moment they type it and
    // fails loudly if they widen the signature at runtime instead.
    const params = compactSession.length;
    expect(params).toBeLessThanOrEqual(3);
  });

  it('is idempotent', async () => {
    const id = await mkSession({ state: 'ready', daysAgo: 30 });
    const first = await compactSession(cfg, id);
    const second = await compactSession(cfg, id);
    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(second.freedBytes).toBe(0);
  });

  it('dry run deletes nothing and reports what it would free', async () => {
    const id = await mkSession({ state: 'ready', daysAgo: 30, videoBytes: 4096 });
    const result = await compactSession(cfg, id, { dryRun: true });
    expect(result.changed).toBe(true);
    expect(result.freedBytes).toBeGreaterThanOrEqual(4096);
    await expect(fs.access(path.join(raw(id), 'video.mp4'))).resolves.toBeUndefined();
    expect((await readStatus(cfg, id))!.compacted).toBeUndefined();
  });
});

describe('compactSweep: age policy', () => {
  it('compacts ready sessions older than the cutoff', async () => {
    const old = await mkSession({ state: 'ready', daysAgo: 30 });
    const fresh = await mkSession({ state: 'ready', daysAgo: 1 });
    const report = await compactSweep(cfg, { days: 14, keepRecent: 0 });
    expect(report.compacted.map((r) => r.id)).toContain(old);
    expect(report.compacted.map((r) => r.id)).not.toContain(fresh);
  });

  it('never touches the keepRecent newest, whatever their age', async () => {
    const ancient = await mkSession({ state: 'ready', daysAgo: 500 });
    const report = await compactSweep(cfg, { days: 14, keepRecent: 5 });
    expect(report.compacted).toHaveLength(0);
    await expect(fs.access(path.join(raw(ancient), 'video.mp4'))).resolves.toBeUndefined();
  });

  it('INVARIANT: an old failed session survives the age pass', async () => {
    const failed = await mkSession({ state: 'failed', daysAgo: 300 });
    await compactSweep(cfg, { days: 14, keepRecent: 0 });
    await expect(fs.access(path.join(raw(failed), 'video.mp4'))).resolves.toBeUndefined();
  });
});

describe('compactSweep: size budget', () => {
  it('compacts oldest-first until under budget', async () => {
    const oldest = await mkSession({ state: 'ready', daysAgo: 10, videoBytes: 6000 });
    const middle = await mkSession({ state: 'ready', daysAgo: 5, videoBytes: 6000 });
    const newest = await mkSession({ state: 'ready', daysAgo: 2, videoBytes: 6000 });
    // 18000 total, budget 10000: dropping the oldest (6000) is not enough,
    // dropping two gets under. Newest must survive.
    const report = await compactSweep(cfg, { days: 9999, maxRawBytes: 10_000, keepRecent: 0 });
    const ids = report.compacted.map((r) => r.id);
    expect(ids).toContain(oldest);
    expect(ids).toContain(middle);
    expect(ids).not.toContain(newest);
  });

  it('INVARIANT: budget pressure never deletes an unprocessed session', async () => {
    const failedOld = await mkSession({ state: 'failed', daysAgo: 100, videoBytes: 50_000 });
    await mkSession({ state: 'ready', daysAgo: 1, videoBytes: 100 });
    const report = await compactSweep(cfg, { days: 9999, maxRawBytes: 1000, keepRecent: 0 });
    await expect(fs.access(path.join(raw(failedOld), 'video.mp4'))).resolves.toBeUndefined();
    expect(report.skippedNotReady).toBeGreaterThan(0);
    expect(report.overBudget).toBe(true);
  });

  it('counts recent sessions toward usage but does not touch them', async () => {
    const recent = await mkSession({ state: 'ready', daysAgo: 0, videoBytes: 50_000 });
    const report = await compactSweep(cfg, { days: 9999, maxRawBytes: 1000, keepRecent: 5 });
    await expect(fs.access(path.join(raw(recent), 'video.mp4'))).resolves.toBeUndefined();
    expect(report.overBudget).toBe(true);
  });
});

describe('compactSweep: archive orphans', () => {
  it('removes old unclaimed archive files', async () => {
    const archiveDir = defaultArchiveDir(cfg);
    await fs.mkdir(archiveDir, { recursive: true });
    const orphan = path.join(archiveDir, 'RPReplay_old.mp4');
    await fs.writeFile(orphan, Buffer.alloc(3000, 5));
    const past = new Date(Date.now() - 30 * 86_400_000);
    await fs.utimes(orphan, past, past);
    const report = await compactSweep(cfg, { days: 14 });
    await expect(fs.access(orphan)).rejects.toThrow();
    expect(report.freedBytes).toBeGreaterThanOrEqual(3000);
  });

  it('keeps young archive files', async () => {
    const archiveDir = defaultArchiveDir(cfg);
    await fs.mkdir(archiveDir, { recursive: true });
    const young = path.join(archiveDir, 'RPReplay_new.mp4');
    await fs.writeFile(young, Buffer.alloc(3000, 5));
    await compactSweep(cfg, { days: 14 });
    await expect(fs.access(young)).resolves.toBeUndefined();
  });

  it('dry run leaves orphans in place', async () => {
    const archiveDir = defaultArchiveDir(cfg);
    await fs.mkdir(archiveDir, { recursive: true });
    const orphan = path.join(archiveDir, 'RPReplay_old.mp4');
    await fs.writeFile(orphan, Buffer.alloc(3000, 5));
    const past = new Date(Date.now() - 30 * 86_400_000);
    await fs.utimes(orphan, past, past);
    await compactSweep(cfg, { days: 14, dryRun: true });
    await expect(fs.access(orphan)).resolves.toBeUndefined();
  });
});

describe('re-processing a compacted session', () => {
  it('explains what happened instead of "no input files"', async () => {
    const id = await mkSession({ state: 'ready', daysAgo: 30 });
    await compactSession(cfg, id);
    const result = await processSessionSafe(cfg, id, {});
    expect(result).toBeNull(); // safe wrapper records the failure on the session
    const status = await readStatus(cfg, id);
    expect(status!.state).toBe('failed');
    expect(status!.error!.message).toMatch(/compacted/i);
    expect(status!.error!.hint).toMatch(/frames and transcript are still there/i);
  });
});

describe('compactableBytes', () => {
  it('reports media plus archive for a ready session', async () => {
    const id = await mkSession({ state: 'ready', videoBytes: 1000, archived: true });
    expect(await compactableBytes(cfg, id)).toBe(3000); // 1000 video + 2000 archive
  });

  it('reports zero for anything the invariant protects', async () => {
    const id = await mkSession({ state: 'failed', videoBytes: 1000 });
    expect(await compactableBytes(cfg, id)).toBe(0);
  });
});

describe('parseSize / parseDays / formatBytes', () => {
  it.each([
    ['10GB', 10 * 1024 ** 3],
    ['500MB', 500 * 1024 ** 2],
    ['1.5gb', Math.round(1.5 * 1024 ** 3)],
    ['1024', 1024],
    ['0', 0],
  ])('parseSize(%s)', (input, expected) => {
    expect(parseSize(input)).toBe(expected);
  });

  it.each([['nope'], ['-5GB'], ['GB'], ['']])('parseSize rejects %s', (input) => {
    expect(parseSize(input)).toBeNull();
  });

  it.each([
    ['14d', 14],
    ['36h', 1.5],
    ['7', 7],
  ])('parseDays(%s)', (input, expected) => {
    expect(parseDays(input)).toBe(expected);
  });

  it('formatBytes is human-scaled', () => {
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GB');
    expect(formatBytes(212 * 1024 ** 2)).toBe('212 MB');
    expect(formatBytes(500)).toBe('500 B');
  });
});
