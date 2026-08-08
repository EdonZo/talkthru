import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { TRANSCRIBE } from './constants.js';
import { TalkthruError, ErrorCodes } from './errors.js';
import { resolveBinary, run } from './ffmpeg.js';
import { log } from './log.js';
import type { TalkthruConfig } from './config.js';
import type { Transcript, TranscriptWord, Transcriber } from './types.js';

const WHISPER_BINARIES = ['whisper-cli', 'whisper-cpp', 'whisper', 'main'];

const WHISPER_INSTALL_HINT =
  'Install it with `brew install whisper-cpp` (macOS) or build https://github.com/ggml-org/whisper.cpp ' +
  'and put `whisper-cli` on PATH, or set TALKTHRU_WHISPER to its full path.';

/**
 * whisper.cpp emits these when it hears nothing. They are not speech and must
 * never reach the timeline — an agent reading "[BLANK_AUDIO]" as narration is
 * worse than an empty bundle.
 */
const NON_SPEECH = /^\s*[[(](blank_audio|silence|music|inaudible|noise|applause|sound)[^\])]*[\])]\s*$/i;
const BRACKETED = /^\s*[[(][^\])]*[\])]\s*$/;

export function isNonSpeech(text: string): boolean {
  const t = text.trim();
  if (t === '') return true;
  if (NON_SPEECH.test(t)) return true;
  // Any fully-bracketed token from whisper is an annotation, not narration.
  if (BRACKETED.test(t)) return true;
  // Pure punctuation.
  return !/[\p{L}\p{N}]/u.test(t);
}

interface WhisperJsonSegment {
  timestamps?: { from?: string; to?: string };
  offsets?: { from?: number; to?: number };
  text?: string;
  tokens?: Array<{ text?: string; offsets?: { from?: number; to?: number }; p?: number }>;
}

interface WhisperJson {
  result?: { language?: string };
  transcription?: WhisperJsonSegment[];
}

/** Normalise whitespace and glue whisper's leading spaces into readable text. */
export function joinWords(words: TranscriptWord[]): string {
  return words
    .map((w) => w.text)
    .join(' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Turn whisper.cpp's JSON into a flat word list.
 * Exported so a golden test can exercise the parser without running whisper.
 */
export function parseWhisperJson(json: unknown, engine: string): Transcript {
  const doc = (json ?? {}) as WhisperJson;
  const segments = Array.isArray(doc.transcription) ? doc.transcription : [];
  const words: TranscriptWord[] = [];

  for (const seg of segments) {
    const segFrom = Math.max(0, Math.round(Number(seg.offsets?.from ?? 0)));
    const segTo = Math.max(segFrom, Math.round(Number(seg.offsets?.to ?? segFrom)));
    const text = String(seg.text ?? '').trim();
    // With `-ml 1 -sow` each segment is already one word — its own text is more
    // faithful than its sub-tokens, which split punctuation and word pieces.
    // Only fall back to tokens when a segment holds several words (plain
    // segment-level output, or an older whisper build that ignored -ml).
    const isSingleWord = text !== '' && !/\s/.test(text);
    const tokens = Array.isArray(seg.tokens) ? seg.tokens : [];
    const tokenWords = tokens.filter(
      (t) => typeof t.text === 'string' && !isNonSpeech(t.text) && t.offsets?.from !== undefined,
    );
    if (!isSingleWord && tokenWords.length > 1) {
      for (const t of tokenWords) {
        const from = Math.max(0, Math.round(Number(t.offsets?.from ?? segFrom)));
        const to = Math.max(from, Math.round(Number(t.offsets?.to ?? from)));
        words.push({
          text: String(t.text).trim(),
          startMs: from,
          endMs: to,
          ...(typeof t.p === 'number' ? { confidence: t.p } : {}),
        });
      }
      continue;
    }
    if (isNonSpeech(text)) continue;
    words.push({ text, startMs: segFrom, endMs: segTo });
  }

  words.sort((a, b) => a.startMs - b.startMs);
  // Clamp non-monotonic timings (whisper occasionally emits to < from).
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.endMs < w.startMs) w.endMs = w.startMs;
    const prev = words[i - 1];
    if (prev && w.startMs < prev.startMs) w.startMs = prev.startMs;
  }

  // Word-level timing means most entries are one word with a distinct offset.
  // Two ways it can be coarser, and both must be reported: an entry holding a
  // whole phrase (segment-level output with no usable tokens), or many entries
  // sharing one timestamp.
  const distinct = new Set(words.map((w) => w.startMs)).size;
  const anyMultiWord = words.some((w) => /\s/.test(w.text.trim()));
  const coarseTiming = anyMultiWord || (words.length > 1 && distinct < Math.max(2, words.length * 0.5));

  return {
    words,
    text: joinWords(words),
    engine,
    coarseTiming,
    ...(doc.result?.language ? { language: doc.result.language } : {}),
  };
}

export interface WhisperOptions {
  binaryPath?: string;
  modelsDir: string;
  model: string;
  threads?: number;
  /** Set false to fail instead of downloading (offline CI). */
  autoDownload?: boolean;
  language?: string;
}

export function modelFileName(model: string): string {
  return model.startsWith('ggml-') ? `${model}.bin` : `ggml-${model}.bin`;
}

export function modelUrl(model: string): string {
  return `${TRANSCRIBE.MODEL_BASE_URL}/${modelFileName(model)}`;
}

/**
 * Download the model once, atomically. Concurrent callers (two sessions
 * uploaded at the same time) cooperate through a lock file rather than both
 * writing the same path.
 */
export async function ensureModel(opts: {
  modelsDir: string;
  model: string;
  autoDownload?: boolean;
  signal?: AbortSignal;
}): Promise<string> {
  const target = path.join(opts.modelsDir, modelFileName(opts.model));
  const existing = await statSize(target);
  if (existing !== null) {
    if (existing >= TRANSCRIBE.MIN_MODEL_BYTES) return target;
    log.warn('model file is implausibly small, re-downloading', { target, bytes: existing });
    await fs.rm(target, { force: true });
  }
  if (opts.autoDownload === false) {
    throw new TalkthruError(ErrorCodes.WHISPER_MISSING, `Whisper model ${opts.model} is not downloaded`, {
      hint: `Run \`talkthru doctor --fix\` or download ${modelUrl(opts.model)} to ${target}.`,
    });
  }

  await fs.mkdir(opts.modelsDir, { recursive: true, mode: 0o700 });
  const lock = `${target}.lock`;
  const acquired = await acquireLock(lock);
  if (!acquired) {
    // Another process is downloading; wait for it rather than duplicating work.
    const ready = await waitForFile(target, TRANSCRIBE.DOWNLOAD_TIMEOUT_MS);
    if (ready) return target;
    throw new TalkthruError(ErrorCodes.MODEL_DOWNLOAD_FAILED, 'Timed out waiting for another model download', {
      hint: `Delete ${lock} if no download is actually running.`,
    });
  }

  const tmp = `${target}.part`;
  try {
    log.info(`downloading whisper model ${opts.model} (one time; small.en is ~490 MB, base.en ~150 MB)`);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TRANSCRIBE.DOWNLOAD_TIMEOUT_MS);
    opts.signal?.addEventListener('abort', () => controller.abort(), { once: true });
    let res: Response;
    try {
      res = await fetch(modelUrl(opts.model), { signal: controller.signal, redirect: 'follow' });
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !res.body) {
      throw new TalkthruError(
        ErrorCodes.MODEL_DOWNLOAD_FAILED,
        `Model download failed: HTTP ${res.status} for ${modelUrl(opts.model)}`,
        { hint: 'Check the model name (base.en, small.en, medium.en) and your network.' },
      );
    }
    await fs.rm(tmp, { force: true });
    const hash = crypto.createHash('sha256');
    await pipeline(
      Readable.fromWeb(res.body as never),
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          hash.update(chunk);
          yield chunk;
        }
      },
      createWriteStream(tmp),
    );
    const size = await statSize(tmp);
    if (size === null || size < TRANSCRIBE.MIN_MODEL_BYTES) {
      await fs.rm(tmp, { force: true });
      throw new TalkthruError(ErrorCodes.MODEL_DOWNLOAD_FAILED, `Downloaded model is truncated (${size} bytes)`);
    }
    const digest = hash.digest('hex');
    const check = verifyModelDigest(opts.model, digest);
    if (!check.ok && check.expected !== null) {
      await fs.rm(tmp, { force: true });
      throw new TalkthruError(
        ErrorCodes.MODEL_DOWNLOAD_FAILED,
        `Model ${opts.model} failed checksum verification (got ${digest.slice(0, 12)}…, expected ${check.expected.slice(0, 12)}…)`,
        { hint: 'The download was corrupted or tampered with. Try again; if it persists, something is wrong upstream.' },
      );
    }
    if (check.expected === null) {
      log.warn(`no pinned checksum for model ${opts.model}; downloaded without verification`, { digest });
    }
    await fs.rename(tmp, target);
    log.info(`model ready at ${target}`);
    return target;
  } catch (e) {
    await fs.rm(tmp, { force: true });
    if (e instanceof TalkthruError) throw e;
    throw new TalkthruError(ErrorCodes.MODEL_DOWNLOAD_FAILED, `Model download failed: ${String(e)}`, { cause: e });
  } finally {
    await fs.rm(lock, { force: true });
  }
}

/**
 * Compare a downloaded model's digest against the pinned checksum.
 * Exported for tests. `expected: null` means the model is not in the pin map
 * (a custom model) — allowed, with a warning at the call site.
 */
export function verifyModelDigest(
  model: string,
  digest: string,
): { ok: boolean; expected: string | null } {
  const expected = TRANSCRIBE.MODEL_SHA256[model] ?? null;
  if (expected === null) return { ok: true, expected: null };
  return { ok: digest === expected, expected };
}

async function statSize(file: string): Promise<number | null> {
  try {
    return (await fs.stat(file)).size;
  } catch {
    return null;
  }
}

const LOCK_STALE_MS = TRANSCRIBE.DOWNLOAD_TIMEOUT_MS + 60_000;

async function acquireLock(lock: string): Promise<boolean> {
  try {
    const handle = await fs.open(lock, 'wx');
    await handle.writeFile(String(process.pid));
    await handle.close();
    return true;
  } catch {
    const stat = await fs.stat(lock).catch(() => null);
    if (stat && Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
      log.warn('removing stale model lock', { lock });
      await fs.rm(lock, { force: true });
      return acquireLock(lock);
    }
    return false;
  }
}

async function waitForFile(file: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const size = await statSize(file);
    if (size !== null && size >= TRANSCRIBE.MIN_MODEL_BYTES) return true;
    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}

export async function resolveWhisperBinary(override?: string): Promise<string> {
  if (override) return resolveBinary(path.basename(override), override);
  for (const name of WHISPER_BINARIES) {
    try {
      return await resolveBinary(name);
    } catch {
      // try next
    }
  }
  throw new TalkthruError(ErrorCodes.WHISPER_MISSING, 'whisper.cpp not found on PATH', {
    hint: WHISPER_INSTALL_HINT,
  });
}

export class WhisperCppTranscriber implements Transcriber {
  readonly name: string;
  private readonly opts: WhisperOptions;

  constructor(opts: WhisperOptions) {
    this.opts = opts;
    this.name = `whisper.cpp:${opts.model}`;
  }

  async available(): Promise<{ ok: boolean; detail: string }> {
    try {
      const bin = await resolveWhisperBinary(this.opts.binaryPath);
      const modelPath = path.join(this.opts.modelsDir, modelFileName(this.opts.model));
      const size = await statSize(modelPath);
      if (size === null) {
        return { ok: false, detail: `${bin} found, model ${this.opts.model} not downloaded yet` };
      }
      return { ok: true, detail: `${bin} · model ${this.opts.model} (${(size / 1e6).toFixed(0)} MB)` };
    } catch (e) {
      return { ok: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async transcribe(wavPath: string, signal?: AbortSignal): Promise<Transcript> {
    const bin = await resolveWhisperBinary(this.opts.binaryPath);
    const model = await ensureModel({
      modelsDir: this.opts.modelsDir,
      model: this.opts.model,
      ...(this.opts.autoDownload === undefined ? {} : { autoDownload: this.opts.autoDownload }),
      ...(signal ? { signal } : {}),
    });
    const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'talkthru-whisper-'));
    const prefix = path.join(outDir, 'out');
    try {
      await run(
        bin,
        [
          '-m', model,
          '-f', wavPath,
          // -ml 1 + -sow makes whisper emit one segment per word, which is how
          // whisper.cpp exposes word-level timing without DTW models.
          '-ml', '1',
          '-sow',
          '-oj',
          '-ojf',
          '-of', prefix,
          '-np',
          '-l', this.opts.language ?? 'en',
          ...(this.opts.threads && this.opts.threads > 0 ? ['-t', String(this.opts.threads)] : []),
        ],
        { timeoutMs: TRANSCRIBE.TIMEOUT_MS, ...(signal ? { signal } : {}) },
      );
      const raw = await fs.readFile(`${prefix}.json`, 'utf8');
      return parseWhisperJson(JSON.parse(raw), this.name);
    } catch (e) {
      if (e instanceof TalkthruError) throw e;
      throw new TalkthruError(ErrorCodes.WHISPER_FAILED, `Transcription failed: ${String(e)}`, { cause: e });
    } finally {
      await fs.rm(outDir, { recursive: true, force: true });
    }
  }
}

/** Used when audio is absent or whisper is unavailable: an honest empty result. */
export class NullTranscriber implements Transcriber {
  readonly name = 'none';
  constructor(private readonly reason = 'transcription disabled') {}
  async available(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: this.reason };
  }
  async transcribe(): Promise<Transcript> {
    return { words: [], text: '', engine: this.name, coarseTiming: false };
  }
}

export function defaultTranscriber(cfg: TalkthruConfig): Transcriber {
  return new WhisperCppTranscriber({
    ...(cfg.whisperPath ? { binaryPath: cfg.whisperPath } : {}),
    modelsDir: cfg.modelsDir,
    model: cfg.whisperModel,
    threads: TRANSCRIBE.THREADS,
  });
}
