import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  deleteSession,
  ensureSessionDirs,
  initStatus,
  isValidSessionId,
  listSessionIds,
  newSessionId,
  patchStatus,
  pruneSessions,
  readJson,
  readStatus,
  safeFileName,
  sessionDir,
  writeJsonAtomic,
} from '../src/store.js';
import { TalkthruError } from '../src/errors.js';
import type { TalkthruConfig } from '../src/config.js';
import { tempHome } from './helpers.js';

let cfg: TalkthruConfig;
let cleanup: () => Promise<void>;

beforeEach(async () => {
  ({ cfg, cleanup } = await tempHome('store'));
});
afterEach(async () => cleanup());

describe('session ids', () => {
  it('generates ids that validate and sort chronologically', () => {
    const early = newSessionId(new Date('2026-01-02T03:04:05'));
    const late = newSessionId(new Date('2026-01-02T03:04:06'));
    expect(isValidSessionId(early)).toBe(true);
    expect(early < late).toBe(true);
    expect(early).toMatch(/^20260102-030405-[a-z0-9]{6}$/);
  });

  it('rejects anything that is not exactly the id format', () => {
    for (const bad of [
      '',
      'latest',
      '../../etc/passwd',
      '20260102-030405',
      '20260102-030405-ABCDEF',
      '20260102-030405-a1b2c3/extra',
      '20260102-030405-a1b2c-',
      null,
      undefined,
      42,
    ]) {
      expect(isValidSessionId(bad), String(bad)).toBe(false);
    }
  });
});

describe('sessionDir path safety', () => {
  it('resolves a valid id inside the sessions directory', () => {
    const id = newSessionId();
    expect(sessionDir(cfg, id)).toBe(path.join(cfg.sessionsDir, id));
  });

  it('refuses traversal attempts', () => {
    for (const bad of ['../escape', '..', '/etc/passwd', 'a/../../b', './x']) {
      expect(() => sessionDir(cfg, bad), bad).toThrow(TalkthruError);
    }
  });
});

describe('safeFileName', () => {
  it('strips directories and exotic characters', () => {
    expect(safeFileName('../../evil.mp4')).toBe('evil.mp4');
    expect(safeFileName('/abs/path/video.mov')).toBe('video.mov');
    expect(safeFileName('we ird;name.wav')).toBe('we_ird_name.wav');
  });

  it('falls back for names that would be hidden or empty', () => {
    expect(safeFileName('')).toBe('file.bin');
    expect(safeFileName('.')).toBe('file.bin');
    expect(safeFileName('..')).toBe('file.bin');
    expect(safeFileName('.ssh')).toBe('file.bin');
  });

  it('caps absurd lengths', () => {
    expect(safeFileName(`${'a'.repeat(500)}.mp4`).length).toBeLessThanOrEqual(128);
  });
});

describe('atomic json', () => {
  it('round-trips and leaves no temp files behind', async () => {
    const file = path.join(cfg.home, 'thing.json');
    await writeJsonAtomic(file, { a: 1 });
    expect(await readJson<{ a: number }>(file)).toEqual({ a: 1 });
    const leftovers = (await fs.readdir(cfg.home)).filter((n) => n.includes('.tmp-'));
    expect(leftovers).toEqual([]);
  });

  it('returns null for a missing file', async () => {
    expect(await readJson(path.join(cfg.home, 'nope.json'))).toBeNull();
  });

  it('returns null for a corrupt file rather than throwing', async () => {
    const file = path.join(cfg.home, 'corrupt.json');
    await fs.writeFile(file, '{ not json');
    expect(await readJson(file)).toBeNull();
  });
});

describe('status lifecycle', () => {
  it('initialises, patches, and preserves createdAt', async () => {
    const id = newSessionId();
    await ensureSessionDirs(cfg, id);
    const initial = await initStatus(cfg, id, 'ingest');
    expect(initial.state).toBe('uploading');

    await patchStatus(cfg, id, { state: 'processing', stage: 'keyframes' });
    const after = await readStatus(cfg, id);
    expect(after!.state).toBe('processing');
    expect(after!.stage).toBe('keyframes');
    expect(after!.createdAt).toBe(initial.createdAt);
    expect(after!.source).toBe('ingest');
  });

  it('returns null for an unknown session', async () => {
    expect(await readStatus(cfg, newSessionId())).toBeNull();
  });
});

describe('listing and pruning', () => {
  async function makeSession(date: Date): Promise<string> {
    const id = newSessionId(date);
    await ensureSessionDirs(cfg, id);
    await initStatus(cfg, id, 'local');
    await patchStatus(cfg, id, { state: 'ready' });
    // Backdate createdAt so the age-based rule has something to act on.
    const statusFile = path.join(sessionDir(cfg, id), 'status.json');
    const status = await readJson<Record<string, unknown>>(statusFile);
    await writeJsonAtomic(statusFile, { ...status, createdAt: date.toISOString() });
    return id;
  }

  it('lists newest first and ignores junk directories', async () => {
    const old = await makeSession(new Date('2026-01-01T00:00:00'));
    const recent = await makeSession(new Date('2026-06-01T00:00:00'));
    await fs.mkdir(path.join(cfg.sessionsDir, 'not-a-session'), { recursive: true });
    await fs.writeFile(path.join(cfg.sessionsDir, 'stray.txt'), 'x');

    expect(await listSessionIds(cfg)).toEqual([recent, old]);
  });

  it('keeps the newest N regardless of age', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(await makeSession(new Date(`2020-01-0${i + 1}T00:00:00`)));
    const result = await pruneSessions(cfg, { keep: 2, days: 0 });
    expect(result.deleted).toHaveLength(3);
    expect(await listSessionIds(cfg)).toHaveLength(2);
  });

  it('keeps anything newer than the age cutoff even beyond N', async () => {
    for (let i = 0; i < 4; i++) await makeSession(new Date(Date.now() - i * 1000));
    const result = await pruneSessions(cfg, { keep: 1, days: 14 });
    expect(result.deleted).toEqual([]);
  });

  it('does not delete during a dry run', async () => {
    for (let i = 0; i < 3; i++) await makeSession(new Date('2020-01-01T00:00:00'));
    const result = await pruneSessions(cfg, { keep: 0, days: 0, dryRun: true });
    expect(result.deleted).toHaveLength(3);
    expect(await listSessionIds(cfg)).toHaveLength(3);
  });

  it('reports false when deleting a session that is not there', async () => {
    expect(await deleteSession(cfg, newSessionId())).toBe(false);
  });
});
