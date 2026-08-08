import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import path from 'node:path';
import { resolveConfig } from '../src/config.js';
import { INGEST, KEYFRAMES, TRANSCRIBE, ALIGN } from '../src/constants.js';

/**
 * resolveConfig reads process.env at call time, so every test here restores the
 * environment afterwards — a leaked TALKTHRU_* would silently steer the rest of
 * the suite (and did, before this file existed).
 */
const TALKTHRU_KEYS = [
  'TALKTHRU_HOME',
  'TALKTHRU_PORT',
  'TALKTHRU_BIND',
  'TALKTHRU_FFMPEG',
  'TALKTHRU_FFPROBE',
  'TALKTHRU_WHISPER',
  'TALKTHRU_MODEL',
  'TALKTHRU_MODELS_DIR',
  'TALKTHRU_SCENE_DELTA',
  'TALKTHRU_MAX_FRAMES',
  'TALKTHRU_PAUSE_MS',
] as const;

let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of TALKTHRU_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of TALKTHRU_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('resolveConfig defaults', () => {
  it('falls back to the constants when no env and no overrides', () => {
    const cfg = resolveConfig();
    expect(cfg.port).toBe(INGEST.PORT);
    expect(cfg.bind).toBe(INGEST.BIND_LOOPBACK);
    expect(cfg.whisperModel).toBe(TRANSCRIBE.DEFAULT_MODEL);
    expect(cfg.sceneDelta).toBe(KEYFRAMES.SCENE_DELTA);
    expect(cfg.maxFrames).toBe(KEYFRAMES.MAX_FRAMES);
    expect(cfg.pauseMs).toBe(ALIGN.UTTERANCE_PAUSE_MS);
  });

  it('leaves binary paths undefined so they resolve from PATH', () => {
    const cfg = resolveConfig();
    expect(cfg.ffmpegPath).toBeUndefined();
    expect(cfg.ffprobePath).toBeUndefined();
    expect(cfg.whisperPath).toBeUndefined();
  });
});

describe('resolveConfig derived paths', () => {
  it('hangs sessions, models and token off an overridden home', () => {
    const home = path.join(path.sep, 'tmp', 'tt-home');
    const cfg = resolveConfig({ home });
    expect(cfg.home).toBe(home);
    expect(cfg.sessionsDir).toBe(path.join(home, 'sessions'));
    expect(cfg.modelsDir).toBe(path.join(home, 'models'));
    expect(cfg.tokenFile).toBe(path.join(home, 'token'));
  });

  it('lets an explicit derived path win over the home it would follow', () => {
    const home = path.join(path.sep, 'tmp', 'tt-home');
    const sessionsDir = path.join(path.sep, 'elsewhere', 'sessions');
    const cfg = resolveConfig({ home, sessionsDir });
    expect(cfg.sessionsDir).toBe(sessionsDir);
    // The paths that were not overridden still follow home.
    expect(cfg.modelsDir).toBe(path.join(home, 'models'));
  });

  it('reads home from TALKTHRU_HOME when no override is given', () => {
    const home = path.join(path.sep, 'tmp', 'from-env');
    process.env.TALKTHRU_HOME = home;
    const cfg = resolveConfig();
    expect(cfg.home).toBe(home);
    expect(cfg.sessionsDir).toBe(path.join(home, 'sessions'));
  });

  it('prefers an explicit home over TALKTHRU_HOME', () => {
    process.env.TALKTHRU_HOME = path.join(path.sep, 'tmp', 'from-env');
    const home = path.join(path.sep, 'tmp', 'explicit');
    expect(resolveConfig({ home }).home).toBe(home);
  });
});

describe('resolveConfig models dir sharing', () => {
  it('points an isolated home at the shared model cache', () => {
    const shared = path.join(path.sep, 'tmp', 'shared-models');
    process.env.TALKTHRU_MODELS_DIR = shared;
    const cfg = resolveConfig({ home: path.join(path.sep, 'tmp', 'isolated') });
    expect(cfg.modelsDir).toBe(shared);
  });

  it('still lets an explicit modelsDir override win', () => {
    process.env.TALKTHRU_MODELS_DIR = path.join(path.sep, 'tmp', 'shared-models');
    const modelsDir = path.join(path.sep, 'tmp', 'explicit-models');
    const cfg = resolveConfig({ home: path.join(path.sep, 'tmp', 'isolated'), modelsDir });
    expect(cfg.modelsDir).toBe(modelsDir);
  });
});

describe('resolveConfig numeric env parsing', () => {
  it('reads numbers out of the environment', () => {
    process.env.TALKTHRU_PORT = '9999';
    process.env.TALKTHRU_MAX_FRAMES = '7';
    const cfg = resolveConfig();
    expect(cfg.port).toBe(9999);
    expect(cfg.maxFrames).toBe(7);
  });

  it('falls back when the value is not a number', () => {
    process.env.TALKTHRU_PORT = 'not-a-port';
    expect(resolveConfig().port).toBe(INGEST.PORT);
  });

  it('falls back on empty and whitespace-only values', () => {
    process.env.TALKTHRU_PORT = '';
    expect(resolveConfig().port).toBe(INGEST.PORT);
    process.env.TALKTHRU_PORT = '   ';
    expect(resolveConfig().port).toBe(INGEST.PORT);
  });

  it('accepts zero, which a "falsy means unset" bug would discard', () => {
    process.env.TALKTHRU_PORT = '0';
    expect(resolveConfig().port).toBe(0);
  });

  it('accepts a float scene delta', () => {
    process.env.TALKTHRU_SCENE_DELTA = '0.25';
    expect(resolveConfig().sceneDelta).toBe(0.25);
  });

  it('rejects Infinity and NaN in favour of the default', () => {
    process.env.TALKTHRU_MAX_FRAMES = 'Infinity';
    expect(resolveConfig().maxFrames).toBe(KEYFRAMES.MAX_FRAMES);
    process.env.TALKTHRU_MAX_FRAMES = 'NaN';
    expect(resolveConfig().maxFrames).toBe(KEYFRAMES.MAX_FRAMES);
  });
});

describe('resolveConfig purity', () => {
  it('does not mutate the overrides object it was handed', () => {
    const overrides = { home: path.join(path.sep, 'tmp', 'tt') };
    const before = { ...overrides };
    resolveConfig(overrides);
    expect(overrides).toEqual(before);
  });

  it('returns an independent object on each call', () => {
    const a = resolveConfig({ home: path.join(path.sep, 'tmp', 'a') });
    const b = resolveConfig({ home: path.join(path.sep, 'tmp', 'b') });
    expect(a).not.toBe(b);
    expect(a.sessionsDir).not.toBe(b.sessionsDir);
  });
});
