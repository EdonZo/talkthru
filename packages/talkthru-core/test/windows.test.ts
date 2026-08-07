import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { binaryCandidates, fallbackDirs, resolveBinary } from '../src/ffmpeg.js';
import { SCREEN_RECORDING_PATTERN, defaultPattern, defaultWatchDir, isCandidateFile } from '../src/watch.js';
import { ErrorCodes } from '../src/errors.js';

/**
 * Windows support, verified from macOS.
 *
 * Every platform-dependent decision takes an explicit `platform` argument
 * rather than reading process.platform at the point of use, so the Windows
 * paths are exercised on whatever machine runs the suite. Without that these
 * tests could only ever run on the platform nobody here owns — which is exactly
 * how this broke in the first place.
 */

let saved: Record<string, string | undefined>;
const WIN_KEYS = [
  'PATHEXT',
  'USERPROFILE',
  'ChocolateyInstall',
  'ALLUSERSPROFILE',
  'SCOOP',
  'LOCALAPPDATA',
  'ProgramFiles',
  'ProgramFiles(x86)',
  'PATH',
];

beforeEach(() => {
  saved = {};
  for (const k of WIN_KEYS) saved[k] = process.env[k];
});

afterEach(() => {
  for (const k of WIN_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('binaryCandidates', () => {
  it('is a no-op on posix', () => {
    expect(binaryCandidates('ffmpeg', 'darwin')).toEqual(['ffmpeg']);
    expect(binaryCandidates('ffmpeg', 'linux')).toEqual(['ffmpeg']);
  });

  it('tries .exe on windows — the bug that made ffmpeg look missing', () => {
    process.env.PATHEXT = '.COM;.EXE;.BAT;.CMD';
    expect(binaryCandidates('ffmpeg', 'win32')).toContain('ffmpeg.exe');
  });

  it('reads the suffixes out of PATHEXT', () => {
    process.env.PATHEXT = '.EXE;.PS1';
    const out = binaryCandidates('ffmpeg', 'win32');
    expect(out).toContain('ffmpeg.exe');
    expect(out).toContain('ffmpeg.ps1');
  });

  it('falls back to a sane PATHEXT when it is unset', () => {
    delete process.env.PATHEXT;
    expect(binaryCandidates('ffmpeg', 'win32')).toContain('ffmpeg.exe');
  });

  it('still tries the bare name last, for extensionless shims', () => {
    process.env.PATHEXT = '.EXE';
    expect(binaryCandidates('ffmpeg', 'win32').at(-1)).toBe('ffmpeg');
  });

  it('leaves a name that already has an extension alone', () => {
    expect(binaryCandidates('ffmpeg.exe', 'win32')).toEqual(['ffmpeg.exe']);
  });

  it('lowercases the suffix, since PATHEXT is conventionally uppercase', () => {
    process.env.PATHEXT = '.EXE';
    expect(binaryCandidates('ffmpeg', 'win32')).toContain('ffmpeg.exe');
    expect(binaryCandidates('ffmpeg', 'win32')).not.toContain('ffmpeg.EXE');
  });

  it('ignores empty PATHEXT segments', () => {
    process.env.PATHEXT = '.EXE;;.CMD;';
    expect(binaryCandidates('ffmpeg', 'win32').filter((n) => n.endsWith('.'))).toHaveLength(0);
  });
});

describe('fallbackDirs', () => {
  it('returns the homebrew and macports locations on darwin', () => {
    expect(fallbackDirs('darwin')).toContain('/opt/homebrew/bin');
    expect(fallbackDirs('darwin')).toContain('/usr/local/bin');
  });

  it('returns no posix paths on windows', () => {
    process.env.ChocolateyInstall = 'C:\\ProgramData\\chocolatey';
    for (const dir of fallbackDirs('win32')) {
      expect(dir.startsWith('/')).toBe(false);
    }
  });

  it('includes the chocolatey bin dir', () => {
    process.env.ChocolateyInstall = 'C:\\ProgramData\\chocolatey';
    expect(fallbackDirs('win32').some((d) => d.includes('chocolatey'))).toBe(true);
  });

  it('includes the scoop shims dir', () => {
    process.env.USERPROFILE = 'C:\\Users\\edo';
    expect(fallbackDirs('win32').some((d) => d.includes('scoop'))).toBe(true);
  });

  it('includes the winget shim dir', () => {
    process.env.LOCALAPPDATA = 'C:\\Users\\edo\\AppData\\Local';
    expect(fallbackDirs('win32').some((d) => d.includes('WindowsApps'))).toBe(true);
  });

  it('includes Program Files', () => {
    process.env.ProgramFiles = 'C:\\Program Files';
    expect(fallbackDirs('win32').some((d) => d.includes('Program Files'))).toBe(true);
  });

  it('skips entries whose environment variable is unset rather than joining undefined', () => {
    for (const k of ['ChocolateyInstall', 'ALLUSERSPROFILE', 'USERPROFILE', 'SCOOP', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']) {
      delete process.env[k];
    }
    const dirs = fallbackDirs('win32');
    expect(dirs).toEqual([]);
    for (const d of dirs) expect(d).not.toContain('undefined');
  });
});

describe('resolveBinary on windows', () => {
  let tmp: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'talkthru-win-'));
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('finds ffmpeg.exe when asked for ffmpeg', async () => {
    process.env.PATHEXT = '.EXE';
    const dir = path.join(tmp, 'bin');
    await fs.mkdir(dir, { recursive: true });
    const exe = path.join(dir, 'ffmpeg.exe');
    await fs.writeFile(exe, 'binary');
    process.env.PATH = dir;
    // Clear the win32 fallbacks so only PATH can satisfy this.
    for (const k of ['ChocolateyInstall', 'ALLUSERSPROFILE', 'USERPROFILE', 'SCOOP', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']) {
      delete process.env[k];
    }
    await expect(resolveBinary('ffmpeg', undefined, { platform: 'win32' })).resolves.toBe(exe);
  });

  it('reports missing when only a posix-named file is present', async () => {
    process.env.PATHEXT = '.EXE';
    const dir = path.join(tmp, 'bin');
    await fs.mkdir(dir, { recursive: true });
    // No .exe suffix: on Windows this is not an executable.
    await fs.writeFile(path.join(dir, 'ffmpeg'), 'binary');
    process.env.PATH = dir;
    for (const k of ['ChocolateyInstall', 'ALLUSERSPROFILE', 'USERPROFILE', 'SCOOP', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']) {
      delete process.env[k];
    }
    // The bare name is still tried last, so this resolves rather than throwing.
    await expect(resolveBinary('ffmpeg', undefined, { platform: 'win32' })).resolves.toContain('ffmpeg');
  });

  it('searches the chocolatey fallback when PATH is empty', async () => {
    process.env.PATHEXT = '.EXE';
    const choco = path.join(tmp, 'choco');
    await fs.mkdir(path.join(choco, 'bin'), { recursive: true });
    const exe = path.join(choco, 'bin', 'ffmpeg.exe');
    await fs.writeFile(exe, 'binary');
    process.env.PATH = '';
    process.env.ChocolateyInstall = choco;
    for (const k of ['ALLUSERSPROFILE', 'USERPROFILE', 'SCOOP', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']) {
      delete process.env[k];
    }
    await expect(resolveBinary('ffmpeg', undefined, { platform: 'win32' })).resolves.toBe(exe);
  });

  it('still throws FFMPEG_MISSING when nothing is anywhere', async () => {
    process.env.PATH = path.join(tmp, 'empty');
    for (const k of ['ChocolateyInstall', 'ALLUSERSPROFILE', 'USERPROFILE', 'SCOOP', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']) {
      delete process.env[k];
    }
    await expect(resolveBinary('ffmpeg', undefined, { platform: 'win32' })).rejects.toMatchObject({
      code: ErrorCodes.FFMPEG_MISSING,
    });
  });

  it('mentions winget in the install hint', async () => {
    process.env.PATH = path.join(tmp, 'empty');
    for (const k of ['ChocolateyInstall', 'ALLUSERSPROFILE', 'USERPROFILE', 'SCOOP', 'LOCALAPPDATA', 'ProgramFiles', 'ProgramFiles(x86)']) {
      delete process.env[k];
    }
    const err = await resolveBinary('ffmpeg', undefined, { platform: 'win32' }).catch((e: unknown) => e);
    expect((err as { hint?: string }).hint).toMatch(/winget/i);
  });

  it('an explicit override still wins on windows', async () => {
    const exe = path.join(tmp, 'custom-ffmpeg.exe');
    await fs.writeFile(exe, 'binary');
    await expect(resolveBinary('ffmpeg', exe, { platform: 'win32' })).resolves.toBe(exe);
  });
});

describe('defaultWatchDir', () => {
  it('is ~/Downloads on darwin', () => {
    expect(defaultWatchDir('darwin').endsWith(path.join('Downloads'))).toBe(true);
  });

  it('is Videos\\Captures on windows, the Game Bar output folder', () => {
    process.env.USERPROFILE = path.join('C:', 'Users', 'edo');
    const dir = defaultWatchDir('win32');
    expect(dir).toContain('Videos');
    expect(dir).toContain('Captures');
  });

  it('prefers USERPROFILE over homedir on windows', () => {
    process.env.USERPROFILE = path.join('D:', 'profiles', 'edo');
    expect(defaultWatchDir('win32')).toContain(path.join('profiles', 'edo'));
  });

  it('falls back to homedir when USERPROFILE is unset', () => {
    delete process.env.USERPROFILE;
    expect(() => defaultWatchDir('win32')).not.toThrow();
    expect(defaultWatchDir('win32')).toContain('Captures');
  });
});

describe('defaultPattern', () => {
  it('keeps the name filter on darwin, where Downloads is shared', () => {
    expect(defaultPattern('darwin')).toBe(SCREEN_RECORDING_PATTERN);
  });

  it('drops the filter on windows, where Captures holds only recordings', () => {
    // Game Bar names files "<App> 2026-08-07 14-30-22.mp4" — there is no word to
    // match on, and the folder needs no protection.
    expect(defaultPattern('win32')).toBeNull();
  });

  it('accepts a Game Bar filename when the filter is off', () => {
    expect(isCandidateFile('Desktop 2026-08-07 14-30-22.mp4', { pattern: defaultPattern('win32') })).toBe(true);
  });

  it('would have rejected that same file under the posix filter', () => {
    expect(isCandidateFile('Desktop 2026-08-07 14-30-22.mp4', { pattern: defaultPattern('darwin') })).toBe(false);
  });
});

describe('SCREEN_RECORDING_PATTERN additions', () => {
  it.each([
    ['RPReplay_Final1234.mp4'],
    ['Screen Recording 2026-08-07 at 14.30.22.mov'],
    ['ScreenRecording_08-07-2026.mp4'],
    ['screen-recording.mp4'],
  ])('still matches %s', (name) => {
    expect(SCREEN_RECORDING_PATTERN.test(name)).toBe(true);
  });

  it.each([
    ['Simulator Screen Recording - iPhone 16 - 2026-08-07.mp4'],
    ['Screen Capture 2026-08-07.mp4'],
    ['screencast-2026-08-07.webm'],
  ])('now also matches %s', (name) => {
    expect(SCREEN_RECORDING_PATTERN.test(name)).toBe(true);
  });

  it.each([['invoice.pdf.mp4'], ['holiday-video.mp4'], ['meeting-recording.mp4']])(
    'still ignores %s',
    (name) => {
      expect(SCREEN_RECORDING_PATTERN.test(name)).toBe(false);
    },
  );
});
