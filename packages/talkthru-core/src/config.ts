import os from 'node:os';
import path from 'node:path';
import { INGEST, KEYFRAMES, TRANSCRIBE, ALIGN } from './constants.js';

export interface TalkthruConfig {
  /** Root of all runtime state. Everything the tool writes lives under here. */
  home: string;
  sessionsDir: string;
  modelsDir: string;
  tokenFile: string;
  port: number;
  bind: string;
  /** Explicit binary overrides; undefined means "resolve from PATH". */
  ffmpegPath?: string;
  ffprobePath?: string;
  whisperPath?: string;
  whisperModel: string;
  /** Tunables that are worth changing without a rebuild. */
  sceneDelta: number;
  maxFrames: number;
  pauseMs: number;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Resolve config from env + overrides. Pure: no filesystem access, so tests can
 * point `home` at a temp dir freely.
 */
export function resolveConfig(overrides: Partial<TalkthruConfig> = {}): TalkthruConfig {
  const home = overrides.home ?? process.env.TALKTHRU_HOME ?? path.join(os.homedir(), '.talkthru');
  const base: TalkthruConfig = {
    home,
    sessionsDir: path.join(home, 'sessions'),
    modelsDir: path.join(home, 'models'),
    tokenFile: path.join(home, 'token'),
    port: envNumber('TALKTHRU_PORT', INGEST.PORT),
    bind: process.env.TALKTHRU_BIND ?? INGEST.BIND_LOOPBACK,
    ffmpegPath: process.env.TALKTHRU_FFMPEG,
    ffprobePath: process.env.TALKTHRU_FFPROBE,
    whisperPath: process.env.TALKTHRU_WHISPER,
    whisperModel: process.env.TALKTHRU_MODEL ?? TRANSCRIBE.DEFAULT_MODEL,
    sceneDelta: envNumber('TALKTHRU_SCENE_DELTA', KEYFRAMES.SCENE_DELTA),
    maxFrames: envNumber('TALKTHRU_MAX_FRAMES', KEYFRAMES.MAX_FRAMES),
    pauseMs: envNumber('TALKTHRU_PAUSE_MS', ALIGN.UTTERANCE_PAUSE_MS),
  };
  const merged = { ...base, ...overrides };
  // Derived paths must follow an overridden home unless explicitly set.
  if (overrides.home && !overrides.sessionsDir) merged.sessionsDir = path.join(overrides.home, 'sessions');
  if (overrides.home && !overrides.modelsDir) merged.modelsDir = path.join(overrides.home, 'models');
  if (overrides.home && !overrides.tokenFile) merged.tokenFile = path.join(overrides.home, 'token');

  // Models are a large, immutable, shared cache — half a gigabyte for small.en.
  // TALKTHRU_MODELS_DIR lets an isolated TALKTHRU_HOME (a test, a scratch run)
  // reuse the download instead of fetching it again. An explicit modelsDir
  // override still wins.
  if (!overrides.modelsDir && process.env.TALKTHRU_MODELS_DIR) {
    merged.modelsDir = process.env.TALKTHRU_MODELS_DIR;
  }
  return merged;
}
