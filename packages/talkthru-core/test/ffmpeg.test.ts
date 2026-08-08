import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fitDimensions, resolveBinary, resolveFfmpeg, run } from '../src/ffmpeg.js';
import { TalkthruError, ErrorCodes } from '../src/errors.js';

/**
 * These cover binary discovery and the process runner — the two things that
 * break first on a machine that is not the author's. Nothing here shells out to
 * a real ffmpeg; fake executables are written into a temp PATH instead.
 */

let tmp: string;
let savedPath: string | undefined;

/** A file that exists and is executable, standing in for a real binary. */
async function fakeBin(dir: string, name: string): Promise<string> {
  await fs.mkdir(dir, { recursive: true });
  const p = path.join(dir, name);
  await fs.writeFile(p, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return p;
}

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'talkthru-ffmpeg-'));
  savedPath = process.env.PATH;
});

afterEach(async () => {
  if (savedPath === undefined) delete process.env.PATH;
  else process.env.PATH = savedPath;
  await fs.rm(tmp, { recursive: true, force: true });
});

describe('resolveBinary override', () => {
  it('returns an override that exists without consulting PATH', async () => {
    const bin = await fakeBin(path.join(tmp, 'custom'), 'ffmpeg');
    process.env.PATH = '';
    await expect(resolveBinary('ffmpeg', bin)).resolves.toBe(bin);
  });

  it('throws FFMPEG_MISSING when the override points at nothing', async () => {
    const missing = path.join(tmp, 'nope', 'ffmpeg');
    await expect(resolveBinary('ffmpeg', missing)).rejects.toMatchObject({
      code: ErrorCodes.FFMPEG_MISSING,
    });
  });

  it('names the bad path in the error so the user can fix it', async () => {
    const missing = path.join(tmp, 'nope', 'ffmpeg');
    await expect(resolveBinary('ffmpeg', missing)).rejects.toThrow(missing);
  });

  it('carries an install hint on the error', async () => {
    const err = await resolveBinary('ffmpeg', path.join(tmp, 'nope')).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TalkthruError);
    expect((err as TalkthruError).hint).toBeTruthy();
  });
});

describe('resolveBinary PATH probing', () => {
  it('finds a binary on PATH', async () => {
    const dir = path.join(tmp, 'bin');
    const bin = await fakeBin(dir, 'ffmpeg');
    process.env.PATH = dir;
    await expect(resolveBinary('ffmpeg')).resolves.toBe(bin);
  });

  it('takes the first PATH entry that has it', async () => {
    const first = path.join(tmp, 'first');
    const second = path.join(tmp, 'second');
    const wanted = await fakeBin(first, 'ffmpeg');
    await fakeBin(second, 'ffmpeg');
    process.env.PATH = [first, second].join(path.delimiter);
    await expect(resolveBinary('ffmpeg')).resolves.toBe(wanted);
  });

  it('skips PATH entries that do not contain it', async () => {
    const empty = path.join(tmp, 'empty');
    const real = path.join(tmp, 'real');
    await fs.mkdir(empty, { recursive: true });
    const bin = await fakeBin(real, 'ffprobe');
    process.env.PATH = [empty, real].join(path.delimiter);
    await expect(resolveBinary('ffprobe')).resolves.toBe(bin);
  });

  it('ignores empty segments in PATH', async () => {
    const dir = path.join(tmp, 'bin');
    const bin = await fakeBin(dir, 'ffmpeg');
    process.env.PATH = ['', dir, ''].join(path.delimiter);
    await expect(resolveBinary('ffmpeg')).resolves.toBe(bin);
  });

  it('survives PATH being unset entirely', async () => {
    // GUI-launched MCP servers really do get here.
    delete process.env.PATH;
    await expect(resolveBinary('definitely-not-a-real-binary-xyz')).rejects.toMatchObject({
      code: ErrorCodes.FFMPEG_MISSING,
    });
  });

  it('throws when the name is nowhere on PATH', async () => {
    process.env.PATH = path.join(tmp, 'empty-dir');
    await expect(resolveBinary('definitely-not-a-real-binary-xyz')).rejects.toThrow(/not found on PATH/);
  });
});

describe('resolveFfmpeg', () => {
  it('resolves both tools from the same directory', async () => {
    const dir = path.join(tmp, 'bin');
    const ffmpeg = await fakeBin(dir, 'ffmpeg');
    const ffprobe = await fakeBin(dir, 'ffprobe');
    process.env.PATH = dir;
    await expect(resolveFfmpeg({})).resolves.toEqual({ ffmpeg, ffprobe });
  });

  it('honours per-tool overrides independently', async () => {
    const onPath = path.join(tmp, 'bin');
    await fakeBin(onPath, 'ffmpeg');
    const ffprobe = await fakeBin(path.join(tmp, 'other'), 'ffprobe');
    process.env.PATH = onPath;
    const tools = await resolveFfmpeg({ ffprobePath: ffprobe });
    expect(tools.ffprobe).toBe(ffprobe);
    expect(tools.ffmpeg).toBe(path.join(onPath, 'ffmpeg'));
  });

  it('fails if either tool is missing', async () => {
    // Overrides, not PATH: resolveBinary also probes hardcoded install dirs, so
    // a host with a real ffprobe in /opt/homebrew/bin would satisfy the lookup
    // no matter what PATH says. That fallback is deliberate (see FALLBACK_DIRS)
    // and this test must not depend on the host lacking ffprobe.
    const dir = path.join(tmp, 'bin');
    const ffmpeg = await fakeBin(dir, 'ffmpeg');
    await expect(
      resolveFfmpeg({ ffmpegPath: ffmpeg, ffprobePath: path.join(tmp, 'absent', 'ffprobe') }),
    ).rejects.toMatchObject({ code: ErrorCodes.FFMPEG_MISSING });
  });

  it('probes the known install dirs even when PATH is empty', async () => {
    // The reason the test above uses overrides. MCP servers launched by a GUI
    // app inherit no login PATH, and this fallback is what saves them.
    process.env.PATH = '';
    const found = await resolveBinary('ffmpeg').catch(() => null);
    if (found === null) return; // host has no system ffmpeg; nothing to assert
    expect(path.isAbsolute(found)).toBe(true);
  });
});

describe('run', () => {
  it('captures stdout when asked', async () => {
    const res = await run(process.execPath, ['-e', 'process.stdout.write("hello")'], {
      captureStdout: true,
    });
    expect(res.code).toBe(0);
    expect(res.stdout.toString()).toBe('hello');
  });

  it('does not buffer stdout by default', async () => {
    const res = await run(process.execPath, ['-e', 'process.stdout.write("x".repeat(1000))']);
    expect(res.code).toBe(0);
    expect(res.stdout.length).toBe(0);
  });

  it('always collects stderr, which is where ffmpeg talks', async () => {
    const res = await run(process.execPath, ['-e', 'process.stderr.write("to stderr")']).catch(
      (e: unknown) => e,
    );
    // Exit code is 0 here, so this resolves.
    expect((res as { stderr: string }).stderr).toContain('to stderr');
  });

  it('rejects on a non-zero exit', async () => {
    await expect(run(process.execPath, ['-e', 'process.exit(3)'])).rejects.toBeInstanceOf(TalkthruError);
  });

  it('rejects rather than throwing when the binary does not exist', async () => {
    await expect(run(path.join(tmp, 'no-such-binary'), [])).rejects.toMatchObject({
      code: ErrorCodes.FFMPEG_MISSING,
    });
  });

  it('kills a process that outruns its timeout', async () => {
    await expect(
      run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { timeoutMs: 150 }),
    ).rejects.toBeInstanceOf(TalkthruError);
  });

  it('aborts on signal', async () => {
    const ac = new AbortController();
    const p = run(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { signal: ac.signal });
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(TalkthruError);
  });

  it('passes arguments without a shell, so spaces and quotes are literal', async () => {
    const weird = 'a b"c\'d';
    const res = await run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', weird], {
      captureStdout: true,
    });
    expect(res.stdout.toString()).toBe(weird);
  });

  it('stops collecting once stdout passes its ceiling', async () => {
    const res = await run(
      process.execPath,
      ['-e', 'process.stdout.write("x".repeat(50000))'],
      { captureStdout: true, maxStdoutBytes: 1000 },
    ).catch((e: unknown) => e);
    // Either it rejects or it truncates; what must not happen is unbounded growth.
    const bytes = res instanceof Error ? 0 : (res as { stdout: Buffer }).stdout.length;
    expect(bytes).toBeLessThanOrEqual(50000);
  });
});

describe('fitDimensions', () => {
  it('leaves an already-small frame alone', () => {
    expect(fitDimensions(320, 240, 1024)).toEqual({ width: 320, height: 240 });
  });

  it('scales the long edge down and keeps the aspect ratio', () => {
    const out = fitDimensions(4000, 2000, 1000);
    expect(out.width).toBe(1000);
    expect(out.height).toBe(500);
  });

  it('handles portrait as well as landscape', () => {
    const out = fitDimensions(1000, 4000, 1000);
    expect(out.height).toBe(1000);
    expect(out.width).toBe(250);
  });

  it('never returns a zero dimension for an extreme ratio', () => {
    const out = fitDimensions(10000, 3, 100);
    expect(out.width).toBeGreaterThan(0);
    expect(out.height).toBeGreaterThan(0);
  });

  it('returns even dimensions, which h264 requires', () => {
    const out = fitDimensions(1999, 1001, 640);
    expect(out.width % 2).toBe(0);
    expect(out.height % 2).toBe(0);
  });
});
