import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importMedia } from '../src/import.js';
import { readStatus, safeFileName, sessionDir } from '../src/store.js';
import { BUNDLE, STORE } from '../src/constants.js';
import { ErrorCodes } from '../src/errors.js';
import { tempHome } from './helpers.js';
import type { TalkthruConfig } from '../src/config.js';

/**
 * importMedia is the "try it on a video you already have" entry point, and the
 * only way a hierarchy file gets into a session today. It copies rather than
 * links, so these tests check the copies actually land and the source is left
 * untouched.
 */

let cfg: TalkthruConfig;
let cleanup: () => Promise<void>;
let src: string;

/** A file on disk to hand to importMedia. Contents are irrelevant; it is copied verbatim. */
async function srcFile(name: string, body = 'video-bytes'): Promise<string> {
  const p = path.join(src, name);
  await fs.mkdir(path.dirname(p), { recursive: true });
  await fs.writeFile(p, body);
  return p;
}

async function rawDirOf(id: string): Promise<string> {
  return path.join(sessionDir(cfg, id), BUNDLE.RAW_DIR);
}

beforeEach(async () => {
  ({ cfg, cleanup } = await tempHome('import'));
  src = await fs.mkdtemp(path.join(os.tmpdir(), 'talkthru-import-src-'));
});

afterEach(async () => {
  await cleanup();
  await fs.rm(src, { recursive: true, force: true });
});

describe('importMedia validation', () => {
  it('refuses an empty file list', async () => {
    await expect(importMedia(cfg, [])).rejects.toMatchObject({ code: ErrorCodes.NO_MEDIA });
  });

  it('refuses a file that does not exist', async () => {
    await expect(importMedia(cfg, [path.join(src, 'ghost.mp4')])).rejects.toMatchObject({
      code: ErrorCodes.NO_MEDIA,
    });
  });

  it('names the unreadable file in the error', async () => {
    const missing = path.join(src, 'ghost.mp4');
    await expect(importMedia(cfg, [missing])).rejects.toThrow(missing);
  });

  it('refuses a directory handed in place of a file', async () => {
    const dir = path.join(src, 'a-directory');
    await fs.mkdir(dir, { recursive: true });
    await expect(importMedia(cfg, [dir])).rejects.toMatchObject({ code: ErrorCodes.NO_MEDIA });
  });

  it('validates every file before copying any of them', async () => {
    const good = await srcFile('good.mp4');
    const bad = path.join(src, 'ghost.mp4');
    await expect(importMedia(cfg, [good, bad])).rejects.toMatchObject({ code: ErrorCodes.NO_MEDIA });
    // No half-built session should be left behind.
    const sessions = await fs.readdir(cfg.sessionsDir).catch(() => []);
    expect(sessions).toHaveLength(0);
  });
});

describe('importMedia session creation', () => {
  it('returns an id matching the documented shape', async () => {
    const id = await importMedia(cfg, [await srcFile('clip.mp4')]);
    expect(id).toMatch(STORE.ID_PATTERN);
  });

  it('copies the media into the session raw dir', async () => {
    const id = await importMedia(cfg, [await srcFile('clip.mp4', 'hello')]);
    const copied = path.join(await rawDirOf(id), 'clip.mp4');
    await expect(fs.readFile(copied, 'utf8')).resolves.toBe('hello');
  });

  it('leaves the source file in place', async () => {
    const file = await srcFile('clip.mp4', 'hello');
    await importMedia(cfg, [file]);
    await expect(fs.readFile(file, 'utf8')).resolves.toBe('hello');
  });

  it('copies a video and audio pair together', async () => {
    const id = await importMedia(cfg, [await srcFile('clip.mp4'), await srcFile('clip.wav')]);
    const raw = await rawDirOf(id);
    await expect(fs.readdir(raw)).resolves.toEqual(expect.arrayContaining(['clip.mp4', 'clip.wav']));
  });

  it('marks the session queued so the pipeline picks it up', async () => {
    const id = await importMedia(cfg, [await srcFile('clip.mp4')]);
    const status = await readStatus(cfg, id);
    expect(status?.state).toBe('queued');
  });

  it('gives each import its own session', async () => {
    const a = await importMedia(cfg, [await srcFile('a.mp4')]);
    const b = await importMedia(cfg, [await srcFile('b.mp4')]);
    expect(a).not.toBe(b);
  });
});

describe('importMedia sidecars', () => {
  it('copies a hierarchy file to the name the pipeline looks for', async () => {
    const hierarchy = await srcFile('whatever-they-called-it.json', '{"snapshots":[]}');
    const id = await importMedia(cfg, [await srcFile('clip.mp4')], { hierarchyPath: hierarchy });
    const landed = path.join(await rawDirOf(id), 'hierarchy.json');
    await expect(fs.readFile(landed, 'utf8')).resolves.toBe('{"snapshots":[]}');
  });

  it('writes metadata as readable json', async () => {
    const id = await importMedia(cfg, [await srcFile('clip.mp4')], {
      metadata: { app: 'demo', appVersion: '1.2.3' },
    });
    const meta = path.join(await rawDirOf(id), 'meta.json');
    const parsed = JSON.parse(await fs.readFile(meta, 'utf8')) as Record<string, unknown>;
    expect(parsed).toMatchObject({ app: 'demo', appVersion: '1.2.3' });
  });

  it('writes no sidecars when none were given', async () => {
    const id = await importMedia(cfg, [await srcFile('clip.mp4')]);
    const entries = await fs.readdir(await rawDirOf(id));
    expect(entries).not.toContain('hierarchy.json');
    expect(entries).not.toContain('meta.json');
  });
});

describe('importMedia filename safety', () => {
  it('sanitises a name with spaces', async () => {
    const id = await importMedia(cfg, [await srcFile('my clip final.mp4')]);
    const entries = await fs.readdir(await rawDirOf(id));
    expect(entries).toHaveLength(1);
    expect(entries[0]).not.toContain(' ');
  });

  it('strips quotes from a name', () => {
    // Checked against the sanitiser rather than through the filesystem: NTFS
    // will not create a file with a double quote in it, so the round-trip
    // version of this could only ever run on macOS and Linux.
    expect(safeFileName('my clip "final".mp4')).not.toContain('"');
  });

  it('does not let a traversal in the basename escape the session dir', async () => {
    // basename() strips the directory, but the guard is what stops `..` landing
    // as a literal filename. Both together mean the copy stays inside raw/.
    const nested = await srcFile(path.join('deep', 'clip.mp4'));
    const id = await importMedia(cfg, [nested]);
    const raw = await rawDirOf(id);
    for (const entry of await fs.readdir(raw)) {
      expect(path.resolve(raw, entry).startsWith(path.resolve(raw))).toBe(true);
    }
  });
});
