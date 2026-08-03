import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { VAD } from './constants.js';
import { run, type FfmpegTools } from './ffmpeg.js';
import { log } from './log.js';
import { joinWords } from './whisper.js';
import type { Transcriber, Transcript, TranscriptWord } from './types.js';

export interface SpeechSegment {
  startMs: number;
  endMs: number;
}

export interface SilenceInterval {
  startMs: number;
  endMs: number;
}

/**
 * Parse `silencedetect` output. ffmpeg writes lines like:
 *   [silencedetect @ 0x..] silence_start: 5.550375
 *   [silencedetect @ 0x..] silence_end: 12.0075 | silence_duration: 6.457125
 *
 * A trailing `silence_start` with no matching end means the file ends in
 * silence; we close it at `durationMs`.
 */
export function parseSilenceLog(stderr: string, durationMs: number): SilenceInterval[] {
  const intervals: SilenceInterval[] = [];
  let open: number | null = null;
  for (const line of stderr.split('\n')) {
    const start = /silence_start:\s*(-?[\d.]+)/.exec(line);
    if (start?.[1] !== undefined) {
      open = Math.max(0, Math.round(Number(start[1]) * 1000));
      continue;
    }
    const end = /silence_end:\s*(-?[\d.]+)/.exec(line);
    if (end?.[1] !== undefined) {
      const endMs = Math.max(0, Math.round(Number(end[1]) * 1000));
      intervals.push({ startMs: open ?? 0, endMs });
      open = null;
    }
  }
  if (open !== null) intervals.push({ startMs: open, endMs: Math.max(open, durationMs) });
  return intervals.filter((i) => i.endMs > i.startMs).sort((a, b) => a.startMs - b.startMs);
}

/** Invert silence into speech regions, pad them, and drop the noise blips. */
export function speechFromSilence(
  silences: SilenceInterval[],
  durationMs: number,
  opts: { padMs?: number; minSpeechMs?: number } = {},
): SpeechSegment[] {
  const pad = opts.padMs ?? VAD.PAD_MS;
  const minSpeech = opts.minSpeechMs ?? VAD.MIN_SPEECH_MS;
  const regions: SpeechSegment[] = [];
  let cursor = 0;
  for (const silence of silences) {
    if (silence.startMs > cursor) regions.push({ startMs: cursor, endMs: Math.min(silence.startMs, durationMs) });
    cursor = Math.max(cursor, silence.endMs);
  }
  if (cursor < durationMs) regions.push({ startMs: cursor, endMs: durationMs });

  return regions
    .map((r) => ({
      startMs: Math.max(0, r.startMs - pad),
      endMs: Math.min(durationMs, r.endMs + pad),
    }))
    .filter((r) => r.endMs - r.startMs >= minSpeech);
}

export async function detectSpeechSegments(
  tools: FfmpegTools,
  wavPath: string,
  durationMs: number,
  opts: { noiseDb?: number; minSilenceSec?: number; signal?: AbortSignal } = {},
): Promise<SpeechSegment[]> {
  const noise = opts.noiseDb ?? VAD.NOISE_DB;
  const minSilence = opts.minSilenceSec ?? VAD.MIN_SILENCE_SEC;
  const res = await run(
    tools.ffmpeg,
    [
      '-v', 'info',
      '-nostdin',
      '-i', wavPath,
      '-af', `silencedetect=noise=${noise}dB:d=${minSilence}`,
      '-f', 'null',
      '-',
    ],
    { ...(opts.signal ? { signal: opts.signal } : {}) },
  );
  const silences = parseSilenceLog(res.stderr, durationMs);
  const segments = speechFromSilence(silences, durationMs);
  log.debug('vad', { silences: silences.length, segments: segments.length });
  return segments;
}

async function sliceAudio(
  tools: FfmpegTools,
  wavPath: string,
  segment: SpeechSegment,
  outPath: string,
  signal?: AbortSignal,
): Promise<void> {
  await run(
    tools.ffmpeg,
    [
      '-v', 'error',
      '-nostdin',
      '-ss', (segment.startMs / 1000).toFixed(3),
      '-t', ((segment.endMs - segment.startMs) / 1000).toFixed(3),
      '-i', wavPath,
      '-c', 'copy',
      '-y',
      outPath,
    ],
    { ...(signal ? { signal } : {}) },
  );
}

export interface SegmentedTranscribeOptions {
  signal?: AbortSignal;
  noiseDb?: number;
  minSilenceSec?: number;
  /** Set false to transcribe the whole file in one pass (diagnostics). */
  useVad?: boolean;
}

/**
 * Transcribe a WAV by speech region.
 *
 * Each region is transcribed independently and its word timestamps are shifted
 * back into recording time. Because regions are separated by real silence,
 * words carry a `segmentIndex` that forces an utterance break at the boundary —
 * we never have to infer the pause from timings whisper may have compressed.
 *
 * Falls back to a single whole-file pass when VAD finds nothing usable, so a
 * recording with constant background noise still transcribes.
 */
export async function transcribeSegmented(
  tools: FfmpegTools,
  transcriber: Transcriber,
  wavPath: string,
  durationMs: number,
  opts: SegmentedTranscribeOptions = {},
): Promise<Transcript> {
  const whole = async (): Promise<Transcript> => transcriber.transcribe(wavPath, opts.signal);

  if (opts.useVad === false) return whole();

  let segments: SpeechSegment[];
  try {
    segments = await detectSpeechSegments(tools, wavPath, durationMs, {
      ...(opts.noiseDb === undefined ? {} : { noiseDb: opts.noiseDb }),
      ...(opts.minSilenceSec === undefined ? {} : { minSilenceSec: opts.minSilenceSec }),
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  } catch (e) {
    log.warn('silence detection failed; transcribing the whole file', { error: String(e) });
    return whole();
  }

  if (segments.length === 0) {
    // Either pure silence, or audio with no detectable gaps. One whole-file
    // pass distinguishes the two honestly.
    return whole();
  }
  if (segments.length === 1 && segments[0]!.endMs - segments[0]!.startMs >= durationMs * 0.95) {
    return whole();
  }
  if (segments.length > VAD.MAX_SEGMENTS) {
    log.warn('too many speech regions; transcribing the whole file', { count: segments.length });
    return whole();
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'talkthru-vad-'));
  const words: TranscriptWord[] = [];
  let engine = transcriber.name;
  let coarse = false;
  let language: string | undefined;

  try {
    for (const [i, segment] of segments.entries()) {
      const slicePath = path.join(tmpDir, `seg${String(i).padStart(3, '0')}.wav`);
      try {
        await sliceAudio(tools, wavPath, segment, slicePath, opts.signal);
      } catch (e) {
        log.warn('could not slice speech region; skipping', { segment, error: String(e) });
        continue;
      }
      let part: Transcript;
      try {
        part = await transcriber.transcribe(slicePath, opts.signal);
      } catch (e) {
        // One bad region must not lose the other five.
        log.warn('region transcription failed; skipping', { segment, error: String(e) });
        continue;
      }
      engine = part.engine;
      coarse = coarse || part.coarseTiming;
      language = language ?? part.language;
      for (const w of part.words) {
        words.push({
          ...w,
          startMs: segment.startMs + w.startMs,
          endMs: segment.startMs + w.endMs,
          segmentIndex: i,
        });
      }
      await fs.rm(slicePath, { force: true });
    }
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }

  words.sort((a, b) => a.startMs - b.startMs);
  return {
    words,
    text: joinWords(words),
    engine,
    coarseTiming: coarse,
    ...(language ? { language } : {}),
  };
}
