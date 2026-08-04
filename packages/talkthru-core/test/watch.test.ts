import fs from 'node:fs/promises';
import { getEventListeners } from 'node:events';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  watchDirectory,
  FileStabilityTracker,
  SCREEN_RECORDING_PATTERN,
  archiveFile,
  isCandidateFile,
  uniqueDestination,
  watchTick,
  type WatchOptions,
} from '../src/watch.js';
import { listSessionIds } from '../src/store.js';
import type { TalkthruConfig } from '../src/config.js';
import type { ProcessResult } from '../src/pipeline.js';
import { tempHome } from './helpers.js';

let cfg: TalkthruConfig;
let cleanup: () => Promise<void>;
let watchDir: string;
let archiveDir: string;

beforeEach(async () => {
  ({ cfg, cleanup } = await tempHome('watch'));
  watchDir = path.join(cfg.home, 'inbox');
  archiveDir = path.join(cfg.home, 'archive');
  await fs.mkdir(watchDir, { recursive: true });
});
afterEach(async () => cleanup());

describe('isCandidateFile', () => {
  it('accepts the containers a screen recorder produces', () => {
    for (const name of ['RPReplay_Final1785110400.mov', 'clip.mp4', 'demo.M4V', 'x.webm']) {
      expect(isCandidateFile(name), name).toBe(true);
    }
  });

  it('rejects non-video files', () => {
    for (const name of ['notes.txt', 'photo.png', 'audio.wav', 'archive.zip']) {
      expect(isCandidateFile(name), name).toBe(false);
    }
  });

  it('rejects in-flight download markers', () => {
    // These are exactly what AirDrop, Safari and Chrome leave behind mid-copy.
    for (const name of ['clip.mov.download', 'clip.mp4.part', 'clip.mov.crdownload', 'clip.mp4.tmp']) {
      expect(isCandidateFile(name), name).toBe(false);
    }
  });

  it('rejects dotfiles', () => {
    expect(isCandidateFile('.clip.mov')).toBe(false);
    expect(isCandidateFile('.DS_Store')).toBe(false);
  });
});

describe('screen-recording name filter (~/Downloads mode)', () => {
  const opts = { pattern: SCREEN_RECORDING_PATTERN };

  it('accepts the names iOS and macOS actually produce', () => {
    // Both of these are real filenames from device recordings.
    for (const name of [
      'RPReplay_Final1785765061.MP4',
      'ScreenRecording_08-03-2026 08-47-17_1.MP4',
      'Screen Recording 2026-08-03 at 08.47.17.mov',
      'Screen-Recording-2026.mp4',
      'Simulator Screen Recording - iPhone 15 - 2026-08-03.mp4',
    ]) {
      expect(isCandidateFile(name, opts), name).toBe(true);
    }
  });

  it('ignores everything else in a shared Downloads folder', () => {
    // The whole point: a video someone AirDrops you is never read, never
    // transcribed, and never moved out of Downloads.
    for (const name of [
      'IMG_2301.MOV',
      'holiday-video.mp4',
      'Movie Trailer 4K.mkv',
      'zoom_recording_2026.mp4',
      'lecture.avi',
    ]) {
      expect(isCandidateFile(name, opts), name).toBe(false);
    }
  });

  it('accepts any video when no pattern is set (custom-folder mode)', () => {
    for (const name of ['holiday-video.mp4', 'IMG_2301.MOV', 'anything.mkv']) {
      expect(isCandidateFile(name, { pattern: null }), name).toBe(true);
    }
  });

  it('still applies extension and partial-download rules under a pattern', () => {
    expect(isCandidateFile('ScreenRecording_1.txt', opts)).toBe(false);
    expect(isCandidateFile('ScreenRecording_1.mp4.part', opts)).toBe(false);
  });
});

describe('FileStabilityTracker', () => {
  const big = 5_000_000;

  it('does not report a file that is still growing', () => {
    const tracker = new FileStabilityTracker({ stableMs: 2_000 });
    // An AirDrop in flight: same name, size climbing each poll.
    expect(tracker.observe([{ name: 'a.mov', size: 1_000_000, mtimeMs: 1 }], 0)).toEqual([]);
    expect(tracker.observe([{ name: 'a.mov', size: 3_000_000, mtimeMs: 2 }], 1_000)).toEqual([]);
    expect(tracker.observe([{ name: 'a.mov', size: big, mtimeMs: 3 }], 2_000)).toEqual([]);
    // Still nothing: the clock restarted on the last change.
    expect(tracker.observe([{ name: 'a.mov', size: big, mtimeMs: 3 }], 3_000)).toEqual([]);
  });

  it('reports once the file has been unchanged long enough', () => {
    const tracker = new FileStabilityTracker({ stableMs: 2_000 });
    const entry = { name: 'a.mov', size: big, mtimeMs: 5 };
    expect(tracker.observe([entry], 0)).toEqual([]);
    expect(tracker.observe([entry], 1_999)).toEqual([]);
    expect(tracker.observe([entry], 2_000)).toEqual(['a.mov']);
  });

  it('reports a file exactly once', () => {
    const tracker = new FileStabilityTracker({ stableMs: 100 });
    const entry = { name: 'a.mov', size: big, mtimeMs: 5 };
    tracker.observe([entry], 0);
    expect(tracker.observe([entry], 500)).toEqual(['a.mov']);
    expect(tracker.observe([entry], 1_000)).toEqual([]);
    expect(tracker.observe([entry], 5_000)).toEqual([]);
  });

  it('treats an mtime change as movement even when the size matches', () => {
    const tracker = new FileStabilityTracker({ stableMs: 1_000 });
    tracker.observe([{ name: 'a.mov', size: big, mtimeMs: 1 }], 0);
    // Rewritten in place at the same length.
    expect(tracker.observe([{ name: 'a.mov', size: big, mtimeMs: 999 }], 1_000)).toEqual([]);
    expect(tracker.observe([{ name: 'a.mov', size: big, mtimeMs: 999 }], 2_000)).toEqual(['a.mov']);
  });

  it('ignores files below the minimum size', () => {
    const tracker = new FileStabilityTracker({ stableMs: 100, minBytes: 1_000_000 });
    const tiny = { name: 'a.mov', size: 2_048, mtimeMs: 1 };
    tracker.observe([tiny], 0);
    expect(tracker.observe([tiny], 5_000)).toEqual([]);
  });

  it('can be told to ignore what was already there', () => {
    const tracker = new FileStabilityTracker({ stableMs: 100 });
    tracker.ignoreExisting(['old.mov']);
    const entries = [
      { name: 'old.mov', size: big, mtimeMs: 1 },
      { name: 'new.mov', size: big, mtimeMs: 2 },
    ];
    tracker.observe(entries, 0);
    expect(tracker.observe(entries, 1_000)).toEqual(['new.mov']);
  });

  it('handles several files arriving at different times', () => {
    const tracker = new FileStabilityTracker({ stableMs: 1_000 });
    const a = { name: 'a.mov', size: big, mtimeMs: 1 };
    const b = { name: 'b.mov', size: big, mtimeMs: 2 };
    tracker.observe([a], 0);
    tracker.observe([a, b], 500);
    expect(tracker.observe([a, b], 1_100)).toEqual(['a.mov']);
    expect(tracker.observe([a, b], 1_600)).toEqual(['b.mov']);
  });

  it('re-arms when a name reappears after being archived away', () => {
    const tracker = new FileStabilityTracker({ stableMs: 100 });
    const entry = { name: 'a.mov', size: big, mtimeMs: 1 };
    tracker.observe([entry], 0);
    expect(tracker.observe([entry], 500)).toEqual(['a.mov']);
    // Processed and moved to the archive.
    tracker.observe([], 600);
    // A second recording lands with the same name — it must not be skipped.
    const again = { name: 'a.mov', size: big, mtimeMs: 900 };
    tracker.observe([again], 1_000);
    expect(tracker.observe([again], 2_000)).toEqual(['a.mov']);
  });
});

describe('archiveFile', () => {
  it('moves rather than deletes', async () => {
    const source = path.join(watchDir, 'clip.mov');
    await fs.writeFile(source, 'video-bytes');
    const destination = await archiveFile(source, archiveDir);

    await expect(fs.access(source)).rejects.toThrow();
    expect(await fs.readFile(destination, 'utf8')).toBe('video-bytes');
    expect(destination.startsWith(archiveDir)).toBe(true);
  });

  it('does not clobber an earlier recording of the same name', async () => {
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, 'clip.mov'), 'first');
    const source = path.join(watchDir, 'clip.mov');
    await fs.writeFile(source, 'second');

    const destination = await archiveFile(source, archiveDir);
    expect(path.basename(destination)).toBe('clip-1.mov');
    expect(await fs.readFile(path.join(archiveDir, 'clip.mov'), 'utf8')).toBe('first');
    expect(await fs.readFile(destination, 'utf8')).toBe('second');
  });

  it('picks the first free suffix', async () => {
    await fs.mkdir(archiveDir, { recursive: true });
    await fs.writeFile(path.join(archiveDir, 'a.mov'), '');
    await fs.writeFile(path.join(archiveDir, 'a-1.mov'), '');
    expect(path.basename(await uniqueDestination(archiveDir, 'a.mov'))).toBe('a-2.mov');
  });
});

describe('watchTick', () => {
  const processed: string[] = [];

  function options(overrides: Partial<WatchOptions> = {}): WatchOptions {
    return {
      dir: watchDir,
      archiveDir,
      // A temp folder the test nominated: custom-folder mode, any video.
      pattern: null,
      stableMs: 0,
      minBytes: 0,
      // Stub the pipeline: this suite is about detection and archiving.
      processFn: async (_cfg, id): Promise<ProcessResult> => {
        processed.push(id);
        return {
          bundle: {
            id,
            createdAt: new Date().toISOString(),
            durationMs: 1_000,
            metadata: {},
            keyframes: [],
            timeline: [],
            transcript: { text: '', engine: 'stub', coarseTiming: false },
            warnings: [],
            estimatedTokens: 10,
          },
          markdown: '# stub',
          warnings: [],
        };
      },
      ...overrides,
    };
  }

  beforeEach(() => {
    processed.length = 0;
  });

  it('imports, processes and archives a dropped recording', async () => {
    const source = path.join(watchDir, 'RPReplay_Final123.mov');
    await fs.writeFile(source, 'x'.repeat(200_000));

    const tracker = new FileStabilityTracker({ stableMs: 0, minBytes: 0 });
    const seen: string[] = [];
    const opts = options({ onProcessed: ({ sessionId }) => seen.push(sessionId) });

    // First tick records the file; second finds it unchanged and acts.
    await watchTick(cfg, tracker, opts, 0);
    const ids = await watchTick(cfg, tracker, opts, 1_000);

    expect(ids).toHaveLength(1);
    expect(processed).toEqual(ids);
    expect(seen).toEqual(ids);
    expect(await listSessionIds(cfg)).toEqual(ids);

    // Original moved to the archive, not deleted.
    await expect(fs.access(source)).rejects.toThrow();
    expect(await fs.readdir(archiveDir)).toEqual(['RPReplay_Final123.mov']);
  });

  it('does not process the same file twice across ticks', async () => {
    await fs.writeFile(path.join(watchDir, 'a.mov'), 'x'.repeat(200_000));
    const tracker = new FileStabilityTracker({ stableMs: 0, minBytes: 0 });
    await watchTick(cfg, tracker, options(), 0);
    await watchTick(cfg, tracker, options(), 1_000);
    await watchTick(cfg, tracker, options(), 2_000);
    expect(processed).toHaveLength(1);
  });

  it('leaves the file in place when processing fails', async () => {
    const source = path.join(watchDir, 'broken.mov');
    await fs.writeFile(source, 'x'.repeat(200_000));

    const errors: string[] = [];
    const opts = options({
      processFn: async () => {
        throw new Error('ffmpeg exploded');
      },
      onError: ({ error }) => errors.push(error.message),
    });

    const tracker = new FileStabilityTracker({ stableMs: 0, minBytes: 0 });
    await watchTick(cfg, tracker, opts, 0);
    const ids = await watchTick(cfg, tracker, opts, 1_000);

    expect(ids).toEqual([]);
    expect(errors[0]).toContain('ffmpeg exploded');
    // The recording is the only copy — it must survive a failure.
    await expect(fs.access(source)).resolves.toBeUndefined();
  });

  it('ignores non-video files entirely', async () => {
    await fs.writeFile(path.join(watchDir, 'notes.txt'), 'x'.repeat(200_000));
    await fs.writeFile(path.join(watchDir, 'clip.mov.part'), 'x'.repeat(200_000));
    const tracker = new FileStabilityTracker({ stableMs: 0, minBytes: 0 });
    await watchTick(cfg, tracker, options(), 0);
    expect(await watchTick(cfg, tracker, options(), 1_000)).toEqual([]);
  });

  it('never touches a non-recording when the name filter is on', async () => {
    // The Downloads case: someone AirDrops you a holiday video while the
    // watcher is running. It must not be read, processed, or moved.
    const innocent = path.join(watchDir, 'holiday-video.mp4');
    const recording = path.join(watchDir, 'RPReplay_Final999.mov');
    await fs.writeFile(innocent, 'x'.repeat(200_000));
    await fs.writeFile(recording, 'x'.repeat(200_000));

    const opts = options({ pattern: SCREEN_RECORDING_PATTERN });
    const tracker = new FileStabilityTracker({ stableMs: 0, minBytes: 0 });
    await watchTick(cfg, tracker, opts, 0);
    const ids = await watchTick(cfg, tracker, opts, 1_000);

    expect(ids).toHaveLength(1);
    expect(processed).toHaveLength(1);
    // The recording was consumed and archived...
    await expect(fs.access(recording)).rejects.toThrow();
    // ...and the holiday video is still sitting exactly where it landed.
    await expect(fs.access(innocent)).resolves.toBeUndefined();
    expect(await fs.readdir(archiveDir)).toEqual(['RPReplay_Final999.mov']);
  });

  it('survives the watch directory not existing', async () => {
    const tracker = new FileStabilityTracker({ stableMs: 0 });
    const opts = options({ dir: path.join(cfg.home, 'nope') });
    await expect(watchTick(cfg, tracker, opts, 0)).resolves.toEqual([]);
  });

  it('waits out a file that is still being written', async () => {
    const source = path.join(watchDir, 'growing.mov');
    await fs.writeFile(source, 'x'.repeat(100_000));

    const tracker = new FileStabilityTracker({ stableMs: 2_000, minBytes: 0 });
    const opts = options({ stableMs: 2_000 });

    await watchTick(cfg, tracker, opts, 0);
    // AirDrop appends more data before the stability window elapses.
    await fs.appendFile(source, 'y'.repeat(100_000));
    expect(await watchTick(cfg, tracker, opts, 2_500)).toEqual([]);
    // Now it has settled.
    await watchTick(cfg, tracker, opts, 3_000);
    expect(await watchTick(cfg, tracker, opts, 6_000)).toHaveLength(1);
  });
});

describe('watchDirectory', () => {
  /**
   * REGRESSION: the poll loop attached an abort listener per iteration and only
   * detached it if the signal actually fired, so a watcher left running all day
   * leaked one listener a second. Node warned after eleven.
   */
  it('does not accumulate abort listeners while polling', async () => {
    const controller = new AbortController();
    const loop = watchDirectory(cfg, {
      dir: watchDir,
      archiveDir,
      pattern: null,
      pollMs: 5,
      stableMs: 0,
      minBytes: 0,
      signal: controller.signal,
      processFn: async () => {
        throw new Error('should never run — the folder is empty');
      },
    });

    await new Promise((r) => setTimeout(r, 120)); // ~20 polls
    const listeners = getEventListeners(controller.signal, 'abort').length;
    controller.abort();
    await loop;

    expect(listeners).toBeLessThanOrEqual(2);
  });
});
