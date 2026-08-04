import fs from 'node:fs/promises';
import path from 'node:path';
import { BUNDLE, KEYFRAMES, TRANSCRIBE } from './constants.js';
import { TalkthruError, ErrorCodes, toTalkthruError } from './errors.js';
import { extractAudioWav, framesToVideo, meanVolumeDb, probeMedia, resolveFfmpeg, type FfmpegTools } from './ffmpeg.js';
import { extractKeyframes } from './keyframes.js';
import { buildTimeline, segmentUtterances, timelineFromFramesOnly } from './align.js';
import { normaliseSnapshots } from './uiContext.js';
import { renderWithinBudget } from './render.js';
import { defaultTranscriber, NullTranscriber } from './whisper.js';
import { transcribeSegmented } from './speech.js';
import { bundlePath, markdownPath, patchStatus, readJson, sessionDir, writeJsonAtomic, writeTextAtomic } from './store.js';
import { log } from './log.js';
import type { TalkthruConfig } from './config.js';
import type {
  Keyframe,
  MediaInfo,
  SessionBundle,
  SessionMetadata,
  Transcriber,
  Transcript,
  UiSnapshot,
} from './types.js';

const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.webm', '.mkv', '.avi']);
const AUDIO_EXT = new Set(['.wav', '.m4a', '.aac', '.mp3', '.caf', '.ogg', '.flac']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png']);

export interface DiscoveredInputs {
  videoPath?: string;
  audioPath?: string;
  metaPath?: string;
  hierarchyPath?: string;
  /** Directory of numbered stills, when the client uploaded a frame sequence. */
  frameSequenceDir?: string;
  frameSequenceExt?: string;
}

/**
 * Work out what was uploaded. Clients are encouraged to use canonical names
 * (video.mp4 / audio.wav / meta.json / hierarchy.json) but we accept anything
 * recognisable by extension so a hand-rolled curl upload also works.
 */
export async function discoverInputs(rawDir: string): Promise<DiscoveredInputs> {
  const found: DiscoveredInputs = {};
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(rawDir, { withFileTypes: true });
  } catch {
    return found;
  }
  const images: string[] = [];
  for (const entry of entries) {
    const full = path.join(rawDir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'frames') {
        const sub = await fs.readdir(full).catch(() => []);
        const imgs = sub.filter((n) => IMAGE_EXT.has(path.extname(n).toLowerCase())).sort();
        if (imgs.length > 0) {
          found.frameSequenceDir = full;
          found.frameSequenceExt = path.extname(imgs[0]!).toLowerCase();
        }
      }
      continue;
    }
    const ext = path.extname(entry.name).toLowerCase();
    const base = path.basename(entry.name, ext).toLowerCase();
    if (base === 'meta' && ext === '.json') found.metaPath = full;
    else if (base === 'hierarchy' && ext === '.json') found.hierarchyPath = full;
    else if (VIDEO_EXT.has(ext) && !found.videoPath) found.videoPath = full;
    else if (AUDIO_EXT.has(ext) && !found.audioPath) found.audioPath = full;
    else if (IMAGE_EXT.has(ext)) images.push(full);
  }
  // Loose images at the raw root also count as a frame sequence.
  if (!found.frameSequenceDir && !found.videoPath && images.length > 0) {
    found.frameSequenceDir = rawDir;
    found.frameSequenceExt = path.extname(images[0]!).toLowerCase();
  }
  return found;
}

export interface ProcessOptions {
  transcriber?: Transcriber;
  signal?: AbortSignal;
  /** Skip transcription entirely (used by tests and `--no-audio`). */
  noAudio?: boolean;
  /** Set false to transcribe in one whole-file pass instead of per speech region. */
  useVad?: boolean;
}

export interface ProcessResult {
  bundle: SessionBundle;
  markdown: string;
  warnings: string[];
}

/**
 * Turn an uploaded session directory into `session.md` + `session.json`.
 *
 * Failure policy: any single stage may fail without failing the session. A
 * bundle with frames but no narration (or narration but no frames) is still
 * useful; only "no readable media at all" is fatal.
 */
export async function processSession(
  cfg: TalkthruConfig,
  id: string,
  opts: ProcessOptions = {},
): Promise<ProcessResult> {
  const dir = sessionDir(cfg, id);
  const rawDir = path.join(dir, BUNDLE.RAW_DIR);
  const warnings: string[] = [];

  await patchStatus(cfg, id, { state: 'processing', stage: 'probe' });

  const tools = await resolveFfmpeg(cfg);
  const inputs = await discoverInputs(rawDir);
  const metadata = await loadMetadata(inputs.metaPath);
  const snapshots = await loadSnapshots(inputs.hierarchyPath, warnings);

  // A frame sequence becomes a video so the rest of the pipeline is uniform.
  let videoPath = inputs.videoPath;
  if (!videoPath && inputs.frameSequenceDir && inputs.frameSequenceExt) {
    const fps = typeof metadata.captureFps === 'number' && metadata.captureFps > 0 ? metadata.captureFps : 2;
    const built = path.join(rawDir, 'video-from-frames.mp4');
    try {
      await framesToVideo(
        tools,
        path.join(inputs.frameSequenceDir, `*${inputs.frameSequenceExt}`),
        built,
        fps,
        opts.signal ? { signal: opts.signal } : {},
      );
      videoPath = built;
    } catch (e) {
      warnings.push('Could not assemble the uploaded frame sequence into a video.');
      log.warn('framesToVideo failed', { error: String(e) });
    }
  }

  if (!videoPath && !inputs.audioPath) {
    throw new TalkthruError(ErrorCodes.NO_MEDIA, 'Session contains no video, frames, or audio', {
      hint: `Expected files under ${rawDir}. See docs/INGEST_PROTOCOL.md for the upload contract.`,
    });
  }

  let media: MediaInfo | null = null;
  if (videoPath) {
    try {
      media = await probeMedia(tools, videoPath);
    } catch (e) {
      warnings.push('The uploaded video could not be read; falling back to audio only.');
      log.warn('probe failed for video', { error: String(e) });
      media = null;
    }
  }

  let audioInfo: MediaInfo | null = null;
  if (inputs.audioPath) {
    try {
      audioInfo = await probeMedia(tools, inputs.audioPath);
    } catch (e) {
      warnings.push('The uploaded audio track could not be read.');
      log.warn('probe failed for audio', { error: String(e) });
    }
  }

  if (!media && !audioInfo) {
    throw new TalkthruError(ErrorCodes.BAD_MEDIA, 'Neither the video nor the audio could be decoded', {
      hint: 'The upload is probably truncated. Re-record and upload again.',
    });
  }

  const durationMs = Math.max(media?.durationMs ?? 0, audioInfo?.durationMs ?? 0);

  /* -------------------------------- audio -------------------------------- */
  await patchStatus(cfg, id, { stage: 'audio' });
  let wavPath: string | null = null;
  let silentAudio = false;
  if (!opts.noAudio) {
    const audioSource = audioInfo?.path ?? (media?.hasAudio ? media.path : null);
    if (!audioSource) {
      warnings.push('No audio track — nobody narrated this session, or the mic was not captured.');
    } else {
      const target = path.join(rawDir, 'audio-16k.wav');
      try {
        await extractAudioWav(tools, audioSource, target, opts.signal ? { signal: opts.signal } : {});
        wavPath = target;

        // "Has an audio track" is not "has your voice". iOS always writes one;
        // with the mic off it holds app audio, which for a quiet app is
        // silence. Say so plainly rather than reporting "no speech found".
        const meanDb = await meanVolumeDb(tools, target, opts.signal ? { signal: opts.signal } : {});
        if (meanDb !== null && meanDb < TRANSCRIBE.SILENCE_MEAN_DB) {
          silentAudio = true;
          warnings.push(
            `The audio track is silent (${meanDb.toFixed(0)} dB) — the microphone was off. ` +
              'In Control Centre, press and hold the Screen Recording button and switch the ' +
              'Microphone on, then record again.',
          );
        } else if (meanDb !== null && meanDb < TRANSCRIBE.QUIET_MEAN_DB) {
          // Faint but real — a phone on a stand across the room. Left alone,
          // the silence detector's absolute threshold treats nearly all of it
          // as silence: an 85-second recording of continuous speech yielded
          // three 0.3s fragments and an empty transcript. Normalising first
          // lifts it to a normal speaking level and the whole thing comes back.
          log.info(`audio is quiet (${meanDb.toFixed(0)} dB); normalising before transcription`);
          await extractAudioWav(tools, audioSource, target, {
            ...(opts.signal ? { signal: opts.signal } : {}),
            normalise: true,
          });
          warnings.push(
            `The recording was quiet (${meanDb.toFixed(0)} dB) so it was amplified before ` +
              'transcription. Holding the phone closer will improve accuracy.',
          );
        }
      } catch (e) {
        warnings.push('Could not decode the audio track; the bundle has frames only.');
        log.warn('audio extraction failed', { error: String(e) });
      }
    }
  }

  /* ------------------------------ keyframes ------------------------------ */
  await patchStatus(cfg, id, { stage: 'keyframes' });
  let keyframes: Keyframe[] = [];
  if (media) {
    try {
      const result = await extractKeyframes(tools, media, dir, {
        sceneDelta: cfg.sceneDelta,
        maxFrames: cfg.maxFrames,
        maxEdgePx: KEYFRAMES.MAX_EDGE_PX,
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
      keyframes = result.keyframes;
      warnings.push(...result.warnings);
    } catch (e) {
      warnings.push('Keyframe extraction failed; the bundle has narration only.');
      log.warn('keyframe extraction failed', { error: String(e) });
    }
  }
  applyOcclusions(keyframes, snapshots);

  /* ----------------------------- transcription ---------------------------- */
  await patchStatus(cfg, id, { stage: 'transcribe' });
  let transcript: Transcript = { words: [], text: '', engine: 'none', coarseTiming: false };
  if (wavPath) {
    const transcriber = opts.transcriber ?? defaultTranscriber(cfg);
    try {
      transcript = await transcribeSegmented(tools, transcriber, wavPath, durationMs, {
        ...(opts.signal ? { signal: opts.signal } : {}),
        ...(opts.useVad === undefined ? {} : { useVad: opts.useVad }),
      });
      if (transcript.words.length === 0 && !silentAudio) {
        warnings.push('Audio was captured but no speech was recognised.');
      }
    } catch (e) {
      const err = toTalkthruError(e);
      warnings.push(
        err.code === ErrorCodes.WHISPER_MISSING
          ? 'whisper.cpp is not installed, so the narration was not transcribed. Run `talkthru doctor`.'
          : `Transcription failed (${err.code}); the bundle has frames only.`,
      );
      log.warn('transcription failed', { error: err.message });
      transcript = await new NullTranscriber('transcription failed').transcribe();
    }
  }

  /* -------------------------------- align -------------------------------- */
  await patchStatus(cfg, id, { stage: 'align' });
  const utterances = segmentUtterances(transcript.words, cfg.pauseMs);
  const audioOffsetMs = typeof metadata.audioOffsetMs === 'number' ? metadata.audioOffsetMs : 0;
  const timeline =
    utterances.length > 0
      ? buildTimeline(utterances, keyframes, snapshots, { audioOffsetMs })
      : timelineFromFramesOnly(keyframes, snapshots);

  /* -------------------------------- render ------------------------------- */
  await patchStatus(cfg, id, { stage: 'render' });
  const status = await patchStatus(cfg, id, {});
  const rendered = renderWithinBudget({
    id,
    durationMs,
    metadata,
    keyframes,
    timeline,
    warnings,
    transcriptEngine: transcript.engine,
    coarseTiming: transcript.coarseTiming,
  });
  if (rendered.trimmed) {
    warnings.push('UI context was trimmed to keep session.md within its token budget.');
  }

  const bundle: SessionBundle = {
    id,
    createdAt: status.createdAt,
    durationMs,
    metadata,
    keyframes,
    timeline,
    transcript: {
      text: transcript.text,
      engine: transcript.engine,
      coarseTiming: transcript.coarseTiming,
      ...(transcript.language ? { language: transcript.language } : {}),
    },
    warnings,
    estimatedTokens: rendered.estimatedTokens,
  };

  await writeJsonAtomic(bundlePath(cfg, id), bundle);
  await writeTextAtomic(markdownPath(cfg, id), rendered.markdown);
  await patchStatus(cfg, id, { state: 'ready', warnings });

  return { bundle, markdown: rendered.markdown, warnings };
}

/** Run the pipeline and record failure on the session instead of throwing. */
export async function processSessionSafe(
  cfg: TalkthruConfig,
  id: string,
  opts: ProcessOptions = {},
): Promise<ProcessResult | null> {
  try {
    return await processSession(cfg, id, opts);
  } catch (e) {
    const err = toTalkthruError(e);
    log.error(`session ${id} failed`, err.toJSON());
    await patchStatus(cfg, id, { state: 'failed', error: err.toJSON() }).catch(() => undefined);
    return null;
  }
}

async function loadMetadata(file: string | undefined): Promise<SessionMetadata> {
  if (!file) return {};
  const parsed = await readJson<SessionMetadata>(file);
  return parsed && typeof parsed === 'object' ? parsed : {};
}

async function loadSnapshots(file: string | undefined, warnings: string[]): Promise<UiSnapshot[]> {
  if (!file) return [];
  const parsed = await readJson<unknown>(file);
  if (parsed === null) {
    warnings.push('The UI hierarchy file could not be parsed and was ignored.');
    return [];
  }
  const snapshots = normaliseSnapshots(parsed);
  if (snapshots.length === 0) warnings.push('The UI hierarchy file contained no usable snapshots.');
  return snapshots;
}

/**
 * Carry device-reported occlusions onto the frames they affect, so the bundle
 * says "[occluded: system alert]" instead of presenting a blank region as real.
 */
function applyOcclusions(keyframes: Keyframe[], snapshots: UiSnapshot[]): void {
  if (snapshots.length === 0) return;
  for (const kf of keyframes) {
    let best: UiSnapshot | null = null;
    let bestSkew = Number.POSITIVE_INFINITY;
    for (const snap of snapshots) {
      const skew = Math.abs(snap.tMs - kf.tMs);
      if (skew < bestSkew) {
        best = snap;
        bestSkew = skew;
      }
    }
    if (best?.occlusions?.length && bestSkew <= 1000) kf.occlusions = [...best.occlusions];
  }
}
