import fs from 'node:fs/promises';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processSession, processSessionSafe, discoverInputs } from '../src/pipeline.js';
import { ensureSessionDirs, initStatus, newSessionId, readStatus, sessionDir } from '../src/store.js';
import { NullTranscriber } from '../src/whisper.js';
import type { TalkthruConfig } from '../src/config.js';
import {
  FIXTURES,
  FIXTURE_HIERARCHY,
  FIXTURE_META,
  FIXTURE_VIDEO,
  FakeTranscriber,
  ensureFixture,
  loadFixtureTranscript,
  runCommand,
  tempHome,
} from './helpers.js';

const GOLDEN_PATH = path.join(FIXTURES, 'expected-session.md');

let cfg: TalkthruConfig;
let cleanup: () => Promise<void>;

beforeAll(async () => {
  await ensureFixture();
}, 300_000);

beforeEach(async () => {
  ({ cfg, cleanup } = await tempHome('pipeline'));
});
afterEach(async () => cleanup());

/** Create a session on disk from a set of source files. */
async function stage(files: Array<[string, string]>): Promise<string> {
  const id = newSessionId();
  const dir = await ensureSessionDirs(cfg, id);
  await initStatus(cfg, id, 'local');
  for (const [src, name] of files) {
    await fs.copyFile(src, path.join(dir, 'raw', name));
  }
  return id;
}

describe('discoverInputs', () => {
  it('recognises canonical names', async () => {
    const id = await stage([
      [FIXTURE_VIDEO, 'video.mp4'],
      [FIXTURE_META, 'meta.json'],
      [FIXTURE_HIERARCHY, 'hierarchy.json'],
    ]);
    const found = await discoverInputs(path.join(sessionDir(cfg, id), 'raw'));
    expect(found.videoPath).toMatch(/video\.mp4$/);
    expect(found.metaPath).toMatch(/meta\.json$/);
    expect(found.hierarchyPath).toMatch(/hierarchy\.json$/);
  });

  it('recognises media by extension when the name is arbitrary', async () => {
    const id = await stage([[FIXTURE_VIDEO, 'ScreenRecording_2026-08-03.mov']]);
    const found = await discoverInputs(path.join(sessionDir(cfg, id), 'raw'));
    expect(found.videoPath).toMatch(/ScreenRecording/);
  });

  it('returns nothing for an empty or missing directory', async () => {
    expect(await discoverInputs('/definitely/not/here')).toEqual({});
  });
});

describe('golden bundle', () => {
  /**
   * The whole pipeline against the committed fixture, with a fake transcriber
   * replaying real whisper output. Any change to keyframe selection, alignment,
   * or the markdown layout shows up as a diff here.
   *
   * Regenerate deliberately: `GOLDEN_ACCEPT=1 npx vitest run test/pipeline.test.ts`
   */
  it('matches fixtures/expected-session.md', async () => {
    const { words } = await loadFixtureTranscript();
    const id = await stage([
      [FIXTURE_VIDEO, 'video.mp4'],
      [FIXTURE_META, 'meta.json'],
      [FIXTURE_HIERARCHY, 'hierarchy.json'],
    ]);

    const result = await processSession(cfg, id, {
      transcriber: new FakeTranscriber(words),
      // The fake returns the whole transcript in one call, so skip VAD slicing.
      useVad: false,
    });

    // The session id is unique per run; normalise it before comparing.
    const actual = result.markdown.replace(id, '<session-id>');

    if (process.env.GOLDEN_ACCEPT === '1') {
      await fs.writeFile(GOLDEN_PATH, actual, 'utf8');
    }
    const expected = await fs.readFile(GOLDEN_PATH, 'utf8');
    expect(actual).toBe(expected);
  });

  it('extracts the scene changes the fixture was built to contain', async () => {
    const { words } = await loadFixtureTranscript();
    const id = await stage([
      [FIXTURE_VIDEO, 'video.mp4'],
      [FIXTURE_META, 'meta.json'],
      [FIXTURE_HIERARCHY, 'hierarchy.json'],
    ]);
    const { bundle } = await processSession(cfg, id, {
      transcriber: new FakeTranscriber(words),
      useVad: false,
    });

    // Six scenes, cut every 10 s. Timestamps carry the half-probe-interval
    // sampling offset (KEYFRAMES.SAMPLE_OFFSET_RATIO): the probe runs at 4 fps,
    // so a frame selected at 10.000 s actually represents content at 10.125 s.
    // Without this offset the extracted image is the screen from *before* the
    // change that selected it — which lost a whole screen on a real recording.
    expect(bundle.keyframes.map((k) => k.tMs)).toEqual([125, 10_125, 20_125, 30_125, 40_125, 50_125]);
    // Scene 4 is a pixel-for-pixel repeat of scene 0.
    expect(bundle.keyframes[4]!.sameScreenAs).toBe(0);
    expect(bundle.keyframes[4]!.relPath).toBe(bundle.keyframes[0]!.relPath);
    expect(bundle.keyframes[4]!.bytes).toBe(0);
    // ...and no other frame is a repeat.
    expect(bundle.keyframes.filter((k) => k.sameScreenAs !== undefined)).toHaveLength(1);

    // Six narration lines, one per scene, each on the right frame.
    expect(bundle.timeline).toHaveLength(6);
    expect(bundle.timeline.map((t) => t.keyframeIndex)).toEqual([0, 1, 2, 3, 4, 5]);

    // The device flagged the last scene as covered by a system alert.
    expect(bundle.timeline[5]!.occlusions).toEqual(['system alert']);

    // Frame images exist on disk at the promised paths and are real JPEGs.
    for (const kf of bundle.keyframes) {
      const buf = await fs.readFile(path.join(sessionDir(cfg, id), kf.relPath));
      expect(buf.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      expect(Math.max(kf.width, kf.height)).toBeLessThanOrEqual(1024);
    }
  });

  it('stays far inside the token budget for a 60 s session', async () => {
    const { words } = await loadFixtureTranscript();
    const id = await stage([
      [FIXTURE_VIDEO, 'video.mp4'],
      [FIXTURE_META, 'meta.json'],
      [FIXTURE_HIERARCHY, 'hierarchy.json'],
    ]);
    const { bundle } = await processSession(cfg, id, {
      transcriber: new FakeTranscriber(words),
      useVad: false,
    });
    // The brief asks for a 90 s session well under 8k tokens.
    expect(bundle.estimatedTokens).toBeLessThan(2_000);
  });

  it('writes session.json and status alongside the markdown', async () => {
    const { words } = await loadFixtureTranscript();
    const id = await stage([[FIXTURE_VIDEO, 'video.mp4'], [FIXTURE_HIERARCHY, 'hierarchy.json']]);
    await processSession(cfg, id, { transcriber: new FakeTranscriber(words), useVad: false });

    const dir = sessionDir(cfg, id);
    const bundle = JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf8')) as {
      timeline: unknown[];
      keyframes: unknown[];
    };
    expect(bundle.timeline.length).toBeGreaterThan(0);
    expect(bundle.keyframes.length).toBeGreaterThan(0);
    expect((await readStatus(cfg, id))!.state).toBe('ready');
  });
});

describe('degraded inputs', () => {
  it('produces a frame walkthrough when nobody narrated', async () => {
    const id = await stage([[FIXTURE_VIDEO, 'video.mp4'], [FIXTURE_HIERARCHY, 'hierarchy.json']]);
    const { bundle, warnings } = await processSession(cfg, id, {
      transcriber: new NullTranscriber('silent test'),
      useVad: false,
    });
    expect(bundle.keyframes.length).toBe(6);
    // One entry per frame, no text — still a useful visual walkthrough.
    expect(bundle.timeline).toHaveLength(6);
    expect(bundle.timeline.every((t) => t.utterance === '')).toBe(true);
    // The fixture's audio track is synthetic silence, so the bundle should say
    // the microphone was off rather than the vaguer "no speech recognised".
    expect(warnings.join(' ')).toMatch(/microphone was off/i);
  });

  it('handles a video with no audio track at all', async () => {
    const silent = path.join(cfg.home, 'silent.mp4');
    await runCommand('ffmpeg', [
      '-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=320x240:r=10:d=3',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-y', silent,
    ]);
    const id = await stage([[silent, 'video.mp4']]);
    const { bundle, warnings } = await processSession(cfg, id, { useVad: false });
    expect(bundle.keyframes.length).toBeGreaterThanOrEqual(1);
    expect(warnings.join(' ')).toMatch(/no audio track/i);
    expect((await readStatus(cfg, id))!.state).toBe('ready');
  });

  it('records a failure instead of throwing when the media is corrupt', async () => {
    const id = newSessionId();
    const dir = await ensureSessionDirs(cfg, id);
    await initStatus(cfg, id, 'local');
    await fs.writeFile(path.join(dir, 'raw', 'video.mp4'), 'this is not a video');

    const result = await processSessionSafe(cfg, id, { useVad: false });
    expect(result).toBeNull();
    const status = await readStatus(cfg, id);
    expect(status!.state).toBe('failed');
    expect(status!.error?.code).toBeTruthy();
  });

  it('fails cleanly when the upload contained no media', async () => {
    const id = newSessionId();
    await ensureSessionDirs(cfg, id);
    await initStatus(cfg, id, 'local');
    const result = await processSessionSafe(cfg, id, { useVad: false });
    expect(result).toBeNull();
    expect((await readStatus(cfg, id))!.error?.code).toBe('NO_MEDIA');
  });

  it('ignores a corrupt hierarchy file but keeps the session', async () => {
    const id = await stage([[FIXTURE_VIDEO, 'video.mp4']]);
    await fs.writeFile(path.join(sessionDir(cfg, id), 'raw', 'hierarchy.json'), '{ broken json');
    const { bundle, warnings } = await processSession(cfg, id, {
      transcriber: new NullTranscriber(),
      useVad: false,
    });
    expect(bundle.keyframes.length).toBe(6);
    expect(warnings.join(' ')).toMatch(/hierarchy/i);
    expect(bundle.timeline.every((t) => t.uiContext.length === 0)).toBe(true);
  });

  it('builds a session from an uploaded frame sequence', async () => {
    const id = newSessionId();
    const dir = await ensureSessionDirs(cfg, id);
    await initStatus(cfg, id, 'local');
    const framesDir = path.join(dir, 'raw', 'frames');
    await fs.mkdir(framesDir, { recursive: true });
    for (const [i, color] of ['red', 'green', 'blue'].entries()) {
      await runCommand('ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', `color=c=${color}:s=320x240`,
        '-frames:v', '1', '-y', path.join(framesDir, `${String(i).padStart(3, '0')}.jpg`),
      ]);
    }
    const { bundle } = await processSession(cfg, id, { transcriber: new NullTranscriber(), useVad: false });
    expect(bundle.keyframes.length).toBeGreaterThanOrEqual(2);
  });

  it('shifts narration by the audio offset the device reported', async () => {
    const { words } = await loadFixtureTranscript();
    const id = await stage([[FIXTURE_VIDEO, 'video.mp4'], [FIXTURE_HIERARCHY, 'hierarchy.json']]);
    await fs.writeFile(
      path.join(sessionDir(cfg, id), 'raw', 'meta.json'),
      JSON.stringify({ app: 'Offset', audioOffsetMs: 10_000 }),
    );
    const { bundle } = await processSession(cfg, id, {
      transcriber: new FakeTranscriber(words),
      useVad: false,
    });
    // Every line was really spoken 10 s later than the audio clock says, so
    // each binds one scene further along.
    expect(bundle.timeline[0]!.keyframeIndex).toBe(1);
  });
});

/**
 * Issue #13. Re-processing a session used to pick up the pipeline's own
 * audio-16k.wav instead of the narration, fail to decode it, and write the
 * resulting frames-only bundle over the good one. The transcript was the only
 * copy of what the person said, so this lost real work.
 */
describe('re-processing an existing session', () => {
  const rawOf = (id: string) => path.join(sessionDir(cfg, id), 'raw');
  const workOf = (id: string) => path.join(sessionDir(cfg, id), 'work');

  it('ignores an audio intermediate left in raw/ by an older version', async () => {
    const id = await stage([[FIXTURE_VIDEO, 'video.mp4']]);
    // Sorts ahead of 'narration.wav', which is how it won before.
    await fs.writeFile(path.join(rawOf(id), 'audio-16k.wav'), 'ours, not an upload');
    await fs.writeFile(path.join(rawOf(id), 'narration.wav'), 'the real thing');

    const found = await discoverInputs(rawOf(id));

    expect(found.audioPath).toMatch(/narration\.wav$/);
  });

  it('ignores a video intermediate left in raw/ by an older version', async () => {
    const id = await stage([]);
    await fs.writeFile(path.join(rawOf(id), 'video-from-frames.mp4'), 'ours');

    expect((await discoverInputs(rawOf(id))).videoPath).toBeUndefined();
  });

  it('keeps its own intermediates out of raw/', async () => {
    const { words } = await loadFixtureTranscript();
    const id = await stage([[FIXTURE_VIDEO, 'video.mp4']]);

    await processSession(cfg, id, { transcriber: new FakeTranscriber(words), useVad: false });

    expect(await fs.readdir(rawOf(id))).not.toContain('audio-16k.wav');
    expect(await fs.readdir(workOf(id))).toContain('audio-16k.wav');
  });

  it('re-processing a good session twice keeps the narration', async () => {
    const { words } = await loadFixtureTranscript();
    const id = await stage([[FIXTURE_VIDEO, 'video.mp4']]);
    const opts = { transcriber: new FakeTranscriber(words), useVad: false };

    const first = await processSession(cfg, id, opts);
    const second = await processSession(cfg, id, opts);

    expect(second.bundle.timeline).toHaveLength(first.bundle.timeline.length);
    expect(second.bundle.transcript.text).toBe(first.bundle.transcript.text);
  });

  it('refuses to replace a transcript with a frames-only bundle', async () => {
    const { words } = await loadFixtureTranscript();
    const id = await stage([[FIXTURE_VIDEO, 'video.mp4']]);
    await processSession(cfg, id, { transcriber: new FakeTranscriber(words), useVad: false });
    const good = await fs.readFile(path.join(sessionDir(cfg, id), 'session.md'), 'utf8');

    // Whisper missing, wrong model, bad audio — all land here.
    await expect(
      processSession(cfg, id, { transcriber: new NullTranscriber('whisper gone'), useVad: false }),
    ).rejects.toMatchObject({ code: 'WOULD_LOSE_TRANSCRIPT' });

    expect(await fs.readFile(path.join(sessionDir(cfg, id), 'session.md'), 'utf8')).toBe(good);
  });

  it('leaves the session ready after refusing, so it is still the latest', async () => {
    const { words } = await loadFixtureTranscript();
    const id = await stage([[FIXTURE_VIDEO, 'video.mp4']]);
    await processSession(cfg, id, { transcriber: new FakeTranscriber(words), useVad: false });

    const result = await processSessionSafe(cfg, id, {
      transcriber: new NullTranscriber('whisper gone'),
      useVad: false,
    });

    expect(result).toBeNull();
    expect((await readStatus(cfg, id))?.state).toBe('ready');
  });

  it('--force overwrites anyway, for the person who means it', async () => {
    const { words } = await loadFixtureTranscript();
    const id = await stage([[FIXTURE_VIDEO, 'video.mp4']]);
    await processSession(cfg, id, { transcriber: new FakeTranscriber(words), useVad: false });

    const { bundle } = await processSession(cfg, id, {
      transcriber: new NullTranscriber('deliberate'),
      useVad: false,
      force: true,
    });

    expect(bundle.transcript.text).toBe('');
  });

  it('does not block a first run, which has no bundle to lose', async () => {
    const id = await stage([[FIXTURE_VIDEO, 'video.mp4']]);

    const { bundle } = await processSession(cfg, id, {
      transcriber: new NullTranscriber('no speech'),
      useVad: false,
    });

    expect(bundle.keyframes.length).toBeGreaterThan(0);
  });
});
