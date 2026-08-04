import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { WATCH } from './constants.js';
import { toTalkthruError } from './errors.js';
import { log } from './log.js';
import { importMedia } from './import.js';
import { processSession, type ProcessOptions, type ProcessResult } from './pipeline.js';
import type { TalkthruConfig } from './config.js';

/* ------------------------------------------------------------------ *
 * Pure helpers — no I/O, so the tricky debounce logic is unit-tested.
 * ------------------------------------------------------------------ */

/**
 * Names the OS gives a screen recording.
 *
 *   RPReplay_Final1785765061.MP4                 iOS, via the share sheet
 *   ScreenRecording_08-03-2026 08-47-17_1.MP4    iOS, saved to Files
 *   Screen Recording 2026-08-03 at 08.47.17.mov  macOS
 *   Simulator Screen Recording - iPhone 15.mp4   Xcode Simulator
 *
 * Matching on the name is how the default mode avoids touching the rest of your
 * Downloads folder. A holiday video someone AirDrops you is never read, never
 * transcribed and never moved.
 */
export const SCREEN_RECORDING_PATTERN = /(rpreplay|screen[ _-]?recording)/i;

export interface CandidateOptions {
  extensions?: readonly string[];
  /** Only accept names matching this. `null` accepts any video. */
  pattern?: RegExp | null;
}

/** Is this directory entry a video we should consider processing? */
export function isCandidateFile(name: string, opts: CandidateOptions = {}): boolean {
  const extensions = opts.extensions ?? WATCH.EXTENSIONS;
  // Dotfiles include AirDrop's own in-flight temporaries.
  if (name.startsWith('.')) return false;
  const lower = name.toLowerCase();
  for (const suffix of WATCH.PARTIAL_SUFFIXES) {
    if (lower.endsWith(suffix)) return false;
  }
  if (!extensions.includes(path.extname(lower))) return false;
  const pattern = opts.pattern === undefined ? null : opts.pattern;
  return pattern === null ? true : pattern.test(name);
}

export interface FileObservation {
  name: string;
  size: number;
  mtimeMs: number;
}

export interface StabilityOptions {
  stableMs?: number;
  minBytes?: number;
}

/**
 * Decides when a file has finished being written.
 *
 * There is no "AirDrop finished" event available to us: the file appears at its
 * final path immediately and then grows. So we watch size and mtime, and only
 * report a file once both have been unchanged for `stableMs`. A file that is
 * still growing simply resets its own timer.
 *
 * Each file is reported exactly once, so a poll loop can call `observe` freely.
 */
export class FileStabilityTracker {
  private readonly firstSeen = new Map<string, FileObservation>();
  private readonly unchangedSince = new Map<string, number>();
  private readonly reported = new Set<string>();
  private readonly stableMs: number;
  private readonly minBytes: number;

  constructor(opts: StabilityOptions = {}) {
    this.stableMs = opts.stableMs ?? WATCH.STABLE_MS;
    this.minBytes = opts.minBytes ?? WATCH.MIN_BYTES;
  }

  /** Mark files as already-known so a watcher does not reprocess a full folder. */
  ignoreExisting(names: Iterable<string>): void {
    for (const name of names) this.reported.add(name);
  }

  /**
   * Feed the current directory listing; get back the files that just became
   * stable. `now` is injected so tests need no timers.
   */
  observe(entries: FileObservation[], now: number): string[] {
    const present = new Set(entries.map((e) => e.name));

    // Forget files that disappeared (we archive them after processing), so a
    // later file with the same name is treated as new.
    for (const key of [...this.firstSeen.keys()]) {
      if (!present.has(key)) {
        this.firstSeen.delete(key);
        this.unchangedSince.delete(key);
        this.reported.delete(key);
      }
    }

    const ready: string[] = [];
    for (const entry of entries) {
      if (this.reported.has(entry.name)) continue;

      const previous = this.firstSeen.get(entry.name);
      if (!previous || previous.size !== entry.size || previous.mtimeMs !== entry.mtimeMs) {
        // First sighting, or it changed since the last poll: restart the clock.
        this.firstSeen.set(entry.name, entry);
        this.unchangedSince.set(entry.name, now);
        continue;
      }

      // A file too small to be a real recording is almost certainly a
      // placeholder the sender has not started filling yet.
      if (entry.size < this.minBytes) continue;

      const since = this.unchangedSince.get(entry.name) ?? now;
      if (now - since >= this.stableMs) {
        this.reported.add(entry.name);
        ready.push(entry.name);
      }
    }
    return ready;
  }

  /** Stop tracking a file entirely (used after archiving). */
  forget(name: string): void {
    this.firstSeen.delete(name);
    this.unchangedSince.delete(name);
    this.reported.delete(name);
  }
}

/** Pick a non-colliding name in `dir` for `preferred`, e.g. `clip-1.mov`. */
export async function uniqueDestination(dir: string, preferred: string): Promise<string> {
  const ext = path.extname(preferred);
  const base = path.basename(preferred, ext);
  for (let i = 0; i < 1_000; i++) {
    const candidate = i === 0 ? preferred : `${base}-${i}${ext}`;
    const full = path.join(dir, candidate);
    try {
      await fs.access(full);
    } catch {
      return full;
    }
  }
  return path.join(dir, `${base}-${Date.now()}${ext}`);
}

/**
 * Move a processed recording into the archive.
 *
 * Never deletes: the original is the only copy of something that took a human
 * a minute to record and cannot be reproduced. Falls back to copy+unlink when
 * the archive lives on a different volume (rename fails with EXDEV).
 */
export async function archiveFile(source: string, archiveDir: string): Promise<string> {
  await fs.mkdir(archiveDir, { recursive: true });
  const destination = await uniqueDestination(archiveDir, path.basename(source));
  try {
    await fs.rename(source, destination);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== 'EXDEV') throw toTalkthruError(e);
    await fs.copyFile(source, destination);
    await fs.unlink(source);
  }
  return destination;
}

/* ------------------------------------------------------------------ *
 * The watcher.
 * ------------------------------------------------------------------ */

export interface WatchOptions {
  /** Directory to watch. Defaults to ~/Downloads. */
  dir?: string;
  archiveDir?: string;
  stableMs?: number;
  pollMs?: number;
  minBytes?: number;
  extensions?: readonly string[];
  /**
   * Only accept filenames matching this. `null` accepts every video, which is
   * the right behaviour for a folder the user nominated on purpose. Defaults to
   * SCREEN_RECORDING_PATTERN so the shared ~/Downloads folder stays untouched.
   */
  pattern?: RegExp | null;
  /** Process files that were already in the folder when watching started. */
  includeExisting?: boolean;
  signal?: AbortSignal;
  /** Injected by tests. */
  processFn?: (cfg: TalkthruConfig, id: string, opts: ProcessOptions) => Promise<ProcessResult>;
  processOptions?: ProcessOptions;
  onReady?: (info: { dir: string; ignored: number }) => void;
  onDetected?: (file: string) => void;
  onProcessed?: (info: {
    file: string;
    sessionId: string;
    archivedTo: string;
    bundle: ProcessResult['bundle'];
    elapsedMs: number;
    bytes: number;
  }) => void;
  onError?: (info: { file: string; error: Error }) => void;
}

/** Resolve the filename filter for a watch run. */
export function candidateOptions(opts: WatchOptions): CandidateOptions {
  return {
    extensions: opts.extensions ?? WATCH.EXTENSIONS,
    pattern: opts.pattern === undefined ? SCREEN_RECORDING_PATTERN : opts.pattern,
  };
}

export function defaultWatchDir(): string {
  return path.join(os.homedir(), WATCH.DEFAULT_DIR_NAME);
}

export function defaultArchiveDir(cfg: TalkthruConfig): string {
  return path.join(cfg.home, WATCH.ARCHIVE_DIR_NAME);
}

async function listCandidates(dir: string, candidateOpts: CandidateOptions): Promise<FileObservation[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return [];
    throw toTalkthruError(e);
  }
  const out: FileObservation[] = [];
  for (const entry of entries) {
    if (!entry.isFile() || !isCandidateFile(entry.name, candidateOpts)) continue;
    try {
      const stat = await fs.stat(path.join(dir, entry.name));
      out.push({ name: entry.name, size: stat.size, mtimeMs: stat.mtimeMs });
    } catch {
      // Vanished mid-listing; it will show up again next poll if it matters.
    }
  }
  return out;
}

/**
 * Run one poll cycle. Exposed so tests can drive the watcher deterministically
 * rather than sleeping.
 */
export async function watchTick(
  cfg: TalkthruConfig,
  tracker: FileStabilityTracker,
  opts: WatchOptions,
  now: number = Date.now(),
): Promise<string[]> {
  const dir = opts.dir ?? defaultWatchDir();
  const archiveDir = opts.archiveDir ?? defaultArchiveDir(cfg);
  const processFn = opts.processFn ?? processSession;

  const entries = await listCandidates(dir, candidateOptions(opts));
  const ready = tracker.observe(entries, now);
  const processed: string[] = [];

  for (const name of ready) {
    const source = path.join(dir, name);
    opts.onDetected?.(source);
    const startedAt = Date.now();
    let bytes = 0;
    try {
      bytes = (await fs.stat(source)).size;
    } catch {
      // Disappeared between detection and processing.
      tracker.forget(name);
      continue;
    }

    try {
      const id = await importMedia(cfg, [source], {
        metadata: {
          client: 'talkthru-watch/0.1.0',
          note: `screen recording imported from ${name}`,
          sourceFile: name,
        },
      });
      const result = await processFn(cfg, id, opts.processOptions ?? {});
      // Archive only after a successful run, so a failure leaves the original
      // exactly where the human can see it.
      const archivedTo = await archiveFile(source, archiveDir);
      processed.push(id);
      opts.onProcessed?.({
        file: source,
        sessionId: id,
        archivedTo,
        bundle: result.bundle,
        elapsedMs: Date.now() - startedAt,
        bytes,
      });
    } catch (e) {
      const error = toTalkthruError(e);
      log.error('watch: processing failed', { file: name, error: error.message });
      opts.onError?.({ file: source, error });
      // Leave the file in place; do not retry in a loop.
    }
  }
  return processed;
}

/** Poll until aborted. Resolves when the abort signal fires. */
export async function watchDirectory(cfg: TalkthruConfig, opts: WatchOptions = {}): Promise<void> {
  const dir = opts.dir ?? defaultWatchDir();
  const pollMs = opts.pollMs ?? WATCH.POLL_MS;
  const tracker = new FileStabilityTracker({
    ...(opts.stableMs === undefined ? {} : { stableMs: opts.stableMs }),
    ...(opts.minBytes === undefined ? {} : { minBytes: opts.minBytes }),
  });

  await fs.mkdir(opts.archiveDir ?? defaultArchiveDir(cfg), { recursive: true });

  // By default, only react to files that arrive AFTER we start. Otherwise
  // pointing this at ~/Downloads would reprocess every video you have ever
  // saved, which is a surprising and expensive first run.
  const existing = await listCandidates(dir, candidateOptions(opts));
  if (!opts.includeExisting) tracker.ignoreExisting(existing.map((e) => e.name));
  opts.onReady?.({ dir, ignored: opts.includeExisting ? 0 : existing.length });

  while (!opts.signal?.aborted) {
    try {
      await watchTick(cfg, tracker, opts);
    } catch (e) {
      log.error('watch: poll failed', { error: String(e) });
    }
    if (opts.signal?.aborted) break;
    // Sleep until the next poll, waking early if we are aborted.
    //
    // The abort listener MUST be removed when the timer wins, not just when it
    // fires: `{ once: true }` only detaches on firing, so a long-running
    // watcher accumulated one listener per second and Node started warning
    // about a leak after eleven polls.
    await new Promise<void>((resolve) => {
      const signal = opts.signal;
      let timer: ReturnType<typeof setTimeout>;
      const done = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      timer = setTimeout(done, pollMs);
      signal?.addEventListener('abort', done, { once: true });
    });
  }
}
