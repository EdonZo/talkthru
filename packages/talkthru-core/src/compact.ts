import fs from 'node:fs/promises';
import path from 'node:path';
import { BUNDLE, COMPACT } from './constants.js';
import { VIDEO_EXT, AUDIO_EXT } from './pipeline.js';
import { listSessionIds, patchStatus, readStatus, sessionDir } from './store.js';
import { defaultArchiveDir } from './watch.js';
import { log } from './log.js';
import type { TalkthruConfig } from './config.js';

/**
 * Reclaim disk from processed recordings while keeping the history.
 *
 * A processed session is two very different things on disk: the bundle
 * (frames + session.md + session.json, ~1 MB) which is what anyone ever looks
 * at again, and the raw media (the original video/audio, tens to hundreds of
 * MB) whose only remaining use is re-processing with different settings.
 * Compacting deletes the second and keeps the first, plus a receipt saying
 * exactly what was removed and how much it saved.
 *
 * THE INVARIANT — stated here, enforced below, pinned in compact.test.ts:
 * nothing that has not been successfully turned into frames + text is ever
 * deleted automatically. Only sessions in state 'ready' are touched, by any
 * code path in this file, including under size-budget pressure. A failed
 * session keeps its media until a human deletes it, full stop.
 */

/** Sidecars are part of the history — tiny, and they explain the bundle. */
const KEEP_IN_RAW = new Set(['meta.json', 'hierarchy.json', 'events.json']);

export interface CompactResult {
  id: string;
  freedBytes: number;
  removed: string[];
  /** False when there was nothing left to remove (already compact). */
  changed: boolean;
}

export interface SweepOptions {
  /** Compact ready sessions older than this many days. */
  days?: number;
  /** ...or once total raw bytes exceed this budget, oldest first. */
  maxRawBytes?: number;
  /** The newest N sessions are never touched. */
  keepRecent?: number;
  /** Report what would happen without deleting anything. */
  dryRun?: boolean;
}

export interface SweepReport {
  compacted: CompactResult[];
  freedBytes: number;
  /** Sessions holding raw media that policy says should go but state forbids. */
  skippedNotReady: number;
  /** True when the size budget is still exceeded after doing all we may do. */
  overBudget: boolean;
}

async function statSize(p: string): Promise<number> {
  try {
    const s = await fs.stat(p);
    return s.isFile() ? s.size : 0;
  } catch {
    return 0;
  }
}

/** The heavy media inside a session's raw dir — what compaction removes. */
async function heavyFiles(cfg: TalkthruConfig, id: string): Promise<string[]> {
  const rawDir = path.join(sessionDir(cfg, id), BUNDLE.RAW_DIR);
  let entries: string[];
  try {
    entries = await fs.readdir(rawDir);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const name of entries) {
    if (KEEP_IN_RAW.has(name.toLowerCase())) continue;
    const ext = path.extname(name).toLowerCase();
    // Frame-sequence uploads put images under raw/frames; those ARE the
    // history for video-less sessions, so only video and audio count as heavy.
    if (VIDEO_EXT.has(ext) || AUDIO_EXT.has(ext)) out.push(path.join(rawDir, name));
  }
  return out;
}

/** Bytes compaction could reclaim from one session (media + its archived original). */
export async function compactableBytes(cfg: TalkthruConfig, id: string): Promise<number> {
  const status = await readStatus(cfg, id);
  if (!status || status.state !== 'ready' || status.compacted) return 0;
  let total = 0;
  for (const f of await heavyFiles(cfg, id)) total += await statSize(f);
  if (status.archivedTo) total += await statSize(status.archivedTo);
  return total;
}

/**
 * Compact one session. Refuses anything that is not 'ready' — that refusal is
 * the invariant, not a convenience default, so there is deliberately no
 * `force` option here. Deleting a failed session is `talkthru delete`, a
 * different verb a human types on purpose.
 */
export async function compactSession(
  cfg: TalkthruConfig,
  id: string,
  opts: { dryRun?: boolean } = {},
): Promise<CompactResult> {
  const status = await readStatus(cfg, id);
  const none: CompactResult = { id, freedBytes: 0, removed: [], changed: false };
  if (!status || status.state !== 'ready' || status.compacted) return none;

  const targets = await heavyFiles(cfg, id);
  if (status.archivedTo && (await statSize(status.archivedTo)) > 0) {
    targets.push(status.archivedTo);
  }
  if (targets.length === 0) return none;

  let freed = 0;
  const removed: string[] = [];
  for (const file of targets) {
    freed += await statSize(file);
    removed.push(path.basename(file));
  }
  if (opts.dryRun) return { id, freedBytes: freed, removed, changed: true };

  for (const file of targets) {
    await fs.rm(file, { force: true });
  }
  await patchStatus(cfg, id, {
    compacted: { at: new Date().toISOString(), freedBytes: freed, removed },
  });
  return { id, freedBytes: freed, removed, changed: true };
}

/**
 * Apply the retention policy across all sessions: age first, then the size
 * budget oldest-first until under budget. Both triggers respect keepRecent and
 * the ready-only invariant.
 */
export async function compactSweep(cfg: TalkthruConfig, opts: SweepOptions = {}): Promise<SweepReport> {
  const days = opts.days ?? COMPACT.DEFAULT_DAYS;
  const maxRaw = opts.maxRawBytes ?? COMPACT.DEFAULT_MAX_RAW_BYTES;
  const keepRecent = opts.keepRecent ?? COMPACT.KEEP_RECENT;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

  // Newest first, as listSessionIds sorts; the protected head of the list.
  const ids = await listSessionIds(cfg);
  const candidates = ids.slice(keepRecent);

  const report: SweepReport = { compacted: [], freedBytes: 0, skippedNotReady: 0, overBudget: false };

  interface Entry {
    id: string;
    createdMs: number;
    /** Bytes compaction may reclaim (zero unless ready — the invariant). */
    bytes: number;
    /** Bytes actually on disk, whatever the state — the honest usage number. */
    rawBytes: number;
    ready: boolean;
  }
  const entries: Entry[] = [];
  for (const id of candidates) {
    const status = await readStatus(cfg, id);
    if (!status) continue;
    const bytes = await compactableBytes(cfg, id);
    let rawBytes = 0;
    for (const file of await heavyFiles(cfg, id)) rawBytes += await statSize(file);
    if (status.archivedTo) rawBytes += await statSize(status.archivedTo);
    if (rawBytes === 0) continue;
    entries.push({
      id,
      createdMs: Date.parse(status.createdAt) || 0,
      bytes,
      rawBytes,
      ready: status.state === 'ready' && !status.compacted,
    });
  }

  // Pass 1: age. Anything ready and older than the cutoff goes.
  for (const e of entries) {
    if (!e.ready) continue;
    if (e.createdMs > cutoff) continue;
    const result = await compactSession(cfg, e.id, { dryRun: opts.dryRun });
    if (result.changed) {
      report.compacted.push(result);
      report.freedBytes += result.freedBytes;
      e.rawBytes -= result.freedBytes;
      e.bytes = 0;
    }
  }

  // Pass 2: budget. Usage counts EVERY byte on disk — including unprocessed
  // sessions the invariant protects — because the point of the number is to
  // be true, not to be reducible.
  let remaining = 0;
  for (const e of entries) remaining += Math.max(0, e.rawBytes);
  for (const id of ids.slice(0, keepRecent)) remaining += await compactableBytes(cfg, id);

  if (remaining > maxRaw) {
    const byAge = entries.filter((e) => e.rawBytes > 0).sort((a, b) => a.createdMs - b.createdMs);
    for (const e of byAge) {
      if (remaining <= maxRaw) break;
      if (!e.ready) {
        // Policy says this space should go; the invariant says no. Count it,
        // say so at the end, delete nothing.
        report.skippedNotReady++;
        continue;
      }
      const result = await compactSession(cfg, e.id, { dryRun: opts.dryRun });
      if (result.changed) {
        report.compacted.push(result);
        report.freedBytes += result.freedBytes;
        remaining -= result.freedBytes;
        e.rawBytes -= result.freedBytes;
        e.bytes = 0;
      }
    }
    report.overBudget = remaining > maxRaw;
    if (report.overBudget) {
      log.warn(
        'compact: still over the raw-media budget, but the remaining media belongs to ' +
          'recent or unprocessed sessions, which are never deleted automatically',
        { remainingBytes: remaining, budgetBytes: maxRaw },
      );
    }
  }

  // Orphaned archive files: originals from before archivedTo was recorded.
  // Everything in archive/ was moved there only after successful processing
  // (see archiveFile's call site in watch.ts), so age-based cleanup preserves
  // the invariant by construction.
  const archiveDir = defaultArchiveDir(cfg);
  let archiveEntries: string[] = [];
  try {
    archiveEntries = await fs.readdir(archiveDir);
  } catch {
    /* no archive yet */
  }
  const claimed = new Set<string>();
  for (const id of ids) {
    const status = await readStatus(cfg, id);
    if (status?.archivedTo) claimed.add(path.resolve(status.archivedTo));
  }
  for (const name of archiveEntries) {
    const file = path.join(archiveDir, name);
    if (claimed.has(path.resolve(file))) continue; // handled with its session
    let stat;
    try {
      stat = await fs.stat(file);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (stat.mtimeMs > cutoff) continue;
    if (!opts.dryRun) await fs.rm(file, { force: true });
    report.compacted.push({ id: `archive/${name}`, freedBytes: stat.size, removed: [name], changed: true });
    report.freedBytes += stat.size;
  }

  return report;
}

/** "500MB" | "10GB" | "1.5gb" -> bytes. Bare numbers are bytes. */
export function parseSize(input: string): number | null {
  const m = /^\s*([\d.]+)\s*(b|kb|mb|gb|tb)?\s*$/i.exec(input);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  const unit = (m[2] ?? 'b').toLowerCase();
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3, tb: 1024 ** 4 }[unit]!;
  return Math.round(n * mult);
}

/** "14d" | "36h" -> days (fractional for hours). */
export function parseDays(input: string): number | null {
  const m = /^\s*([\d.]+)\s*(d|h)?\s*$/i.exec(input);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n < 0) return null;
  return (m[2] ?? 'd').toLowerCase() === 'h' ? n / 24 : n;
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}
