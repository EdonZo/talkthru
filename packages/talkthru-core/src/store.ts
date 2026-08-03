import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { BUNDLE, STORE } from './constants.js';
import { TalkthruError, ErrorCodes, toTalkthruError } from './errors.js';
import type { TalkthruConfig } from './config.js';
import type { SessionBundle, SessionStatus, SessionSummary, SessionState, PipelineStage } from './types.js';

const ID_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** `20260803-001500-a1b2c3` — lexicographically sortable by time. */
export function newSessionId(now: Date = new Date()): string {
  const p = (n: number, w = 2) => String(n).padStart(w, '0');
  const stamp =
    `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  const bytes = crypto.randomBytes(STORE.ID_RANDOM_CHARS);
  let rand = '';
  for (let i = 0; i < STORE.ID_RANDOM_CHARS; i++) {
    rand += ID_ALPHABET[bytes[i]! % ID_ALPHABET.length];
  }
  return `${stamp}-${rand}`;
}

export function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && STORE.ID_PATTERN.test(id);
}

/**
 * SECURITY INVARIANT: every filesystem path derived from client input goes
 * through here. Ids are format-checked (which already excludes `/`, `.` and
 * `..`) and the resolved path is re-checked to be inside the sessions dir.
 */
export function sessionDir(cfg: TalkthruConfig, id: string): string {
  if (!isValidSessionId(id)) {
    throw new TalkthruError(ErrorCodes.BAD_SESSION_ID, `Invalid session id: ${JSON.stringify(id)}`, {
      hint: 'Session ids look like 20260803-001500-a1b2c3.',
    });
  }
  const root = path.resolve(cfg.sessionsDir);
  const dir = path.resolve(root, id);
  if (dir !== path.join(root, id)) {
    throw new TalkthruError(ErrorCodes.BAD_SESSION_ID, `Session id escapes the sessions directory: ${id}`);
  }
  return dir;
}

/**
 * Sanitise a client-supplied *file* name into something safe to write inside a
 * session dir. Keeps the extension, drops everything else exotic.
 */
export function safeFileName(name: string, fallback = 'file.bin'): string {
  const base = path.basename(name ?? '').replace(/[^A-Za-z0-9._-]/g, '_');
  if (!base || base === '.' || base === '..' || base.startsWith('.')) return fallback;
  return base.slice(0, 128);
}

export async function ensureSessionDirs(cfg: TalkthruConfig, id: string): Promise<string> {
  const dir = sessionDir(cfg, id);
  await fs.mkdir(path.join(dir, BUNDLE.RAW_DIR), { recursive: true });
  await fs.mkdir(path.join(dir, BUNDLE.FRAMES_DIR), { recursive: true });
  return dir;
}

/** Write via temp file + rename so a reader never sees a half-written JSON. */
export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
}

export async function writeTextAtomic(file: string, text: string): Promise<void> {
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(tmp, text, 'utf8');
  await fs.rename(tmp, file);
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw) as T;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return null;
    // A corrupt status file must not poison `list`; treat it as absent.
    if (e instanceof SyntaxError) return null;
    throw toTalkthruError(e);
  }
}

/**
 * Move a pre-rename `~/.narrate` directory to `~/.talkthru`, once.
 *
 * The tool was called `narrate` until 2026-08-03. Anyone who used it before the
 * rename has sessions, a downloaded model and a token under the old path;
 * silently starting fresh would look like the tool had lost their recordings.
 * Only runs when the new path does not exist yet, so it can never clobber.
 */
export async function migrateLegacyHome(cfg: TalkthruConfig): Promise<string | null> {
  const legacy = path.join(path.dirname(cfg.home), '.narrate');
  if (legacy === cfg.home) return null;
  try {
    await fs.access(cfg.home);
    return null; // new home already exists — nothing to do
  } catch {
    // fall through
  }
  try {
    await fs.access(legacy);
  } catch {
    return null; // no legacy home either
  }
  try {
    await fs.rename(legacy, cfg.home);
    return legacy;
  } catch {
    return null; // different volume or permissions: not worth failing startup
  }
}

export function statusPath(cfg: TalkthruConfig, id: string): string {
  return path.join(sessionDir(cfg, id), BUNDLE.STATUS_NAME);
}

export function bundlePath(cfg: TalkthruConfig, id: string): string {
  return path.join(sessionDir(cfg, id), BUNDLE.JSON_NAME);
}

export function markdownPath(cfg: TalkthruConfig, id: string): string {
  return path.join(sessionDir(cfg, id), BUNDLE.MARKDOWN_NAME);
}

export async function initStatus(
  cfg: TalkthruConfig,
  id: string,
  source: SessionStatus['source'],
): Promise<SessionStatus> {
  const now = new Date().toISOString();
  const status: SessionStatus = {
    id,
    state: 'uploading',
    createdAt: now,
    updatedAt: now,
    warnings: [],
    source,
  };
  await writeJsonAtomic(statusPath(cfg, id), status);
  return status;
}

export async function readStatus(cfg: TalkthruConfig, id: string): Promise<SessionStatus | null> {
  return readJson<SessionStatus>(statusPath(cfg, id));
}

export async function patchStatus(
  cfg: TalkthruConfig,
  id: string,
  patch: Partial<Omit<SessionStatus, 'id' | 'createdAt'>> & { stage?: PipelineStage; state?: SessionState },
): Promise<SessionStatus> {
  const existing = (await readStatus(cfg, id)) ?? (await initStatus(cfg, id, 'local'));
  const next: SessionStatus = {
    ...existing,
    ...patch,
    warnings: patch.warnings ?? existing.warnings,
    updatedAt: new Date().toISOString(),
  };
  await writeJsonAtomic(statusPath(cfg, id), next);
  return next;
}

export async function addWarning(cfg: TalkthruConfig, id: string, warning: string): Promise<void> {
  const existing = await readStatus(cfg, id);
  const warnings = existing?.warnings ?? [];
  if (!warnings.includes(warning)) warnings.push(warning);
  await patchStatus(cfg, id, { warnings });
}

export async function listSessionIds(cfg: TalkthruConfig): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(cfg.sessionsDir);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return [];
    throw toTalkthruError(e);
  }
  // Newest first; ids sort chronologically as strings.
  return entries.filter(isValidSessionId).sort((a, b) => b.localeCompare(a));
}

function firstLineSummary(bundle: SessionBundle | null): string {
  if (!bundle) return '';
  const text = bundle.timeline[0]?.utterance ?? bundle.transcript.text ?? '';
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > 90 ? `${clean.slice(0, 89)}…` : clean;
}

export async function summarise(cfg: TalkthruConfig, id: string): Promise<SessionSummary | null> {
  const status = await readStatus(cfg, id);
  if (!status) return null;
  const bundle = await readJson<SessionBundle>(bundlePath(cfg, id));
  return {
    id,
    state: status.state,
    createdAt: status.createdAt,
    durationMs: bundle?.durationMs ?? 0,
    frameCount: bundle?.keyframes.length ?? 0,
    utteranceCount: bundle?.timeline.length ?? 0,
    summary: firstLineSummary(bundle),
    warnings: status.warnings ?? [],
    app: bundle?.metadata?.app,
  };
}

export async function listSessions(cfg: TalkthruConfig, limit = 20): Promise<SessionSummary[]> {
  const ids = await listSessionIds(cfg);
  const out: SessionSummary[] = [];
  for (const id of ids.slice(0, Math.max(0, limit))) {
    const s = await summarise(cfg, id);
    if (s) out.push(s);
  }
  return out;
}

export async function latestReadySession(cfg: TalkthruConfig): Promise<SessionSummary | null> {
  for (const id of await listSessionIds(cfg)) {
    const s = await summarise(cfg, id);
    if (s && s.state === 'ready') return s;
  }
  return null;
}

export async function deleteSession(cfg: TalkthruConfig, id: string): Promise<boolean> {
  const dir = sessionDir(cfg, id);
  try {
    await fs.rm(dir, { recursive: true, force: false });
    return true;
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code === 'ENOENT') return false;
    throw toTalkthruError(e);
  }
}

export interface PruneOptions {
  keep?: number;
  days?: number;
  dryRun?: boolean;
}

/** Delete old sessions. Keeps the newest `keep` and anything newer than `days`. */
export async function pruneSessions(
  cfg: TalkthruConfig,
  opts: PruneOptions = {},
): Promise<{ deleted: string[]; kept: number }> {
  const keep = opts.keep ?? STORE.KEEP_SESSIONS;
  const days = opts.days ?? STORE.KEEP_DAYS;
  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const ids = await listSessionIds(cfg);
  const deleted: string[] = [];
  for (let i = 0; i < ids.length; i++) {
    const id = ids[i]!;
    if (i < keep) continue;
    const status = await readStatus(cfg, id);
    const created = status ? Date.parse(status.createdAt) : 0;
    if (Number.isFinite(created) && created > cutoff) continue;
    if (!opts.dryRun) await deleteSession(cfg, id);
    deleted.push(id);
  }
  return { deleted, kept: ids.length - deleted.length };
}

/** Total bytes under a session dir — used by `talkthru list --size` and doctor. */
export async function sessionBytes(cfg: TalkthruConfig, id: string): Promise<number> {
  const dir = sessionDir(cfg, id);
  let total = 0;
  const walk = async (p: string): Promise<void> => {
    const entries = await fs.readdir(p, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile()) total += (await fs.stat(full)).size;
    }
  };
  try {
    await walk(dir);
  } catch {
    return total;
  }
  return total;
}
