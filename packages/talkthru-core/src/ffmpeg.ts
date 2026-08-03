import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { KEYFRAMES, TRANSCRIBE } from './constants.js';
import { TalkthruError, ErrorCodes } from './errors.js';
import { log } from './log.js';
import type { MediaInfo } from './types.js';

const FFMPEG_INSTALL_HINT =
  'Install it with `brew install ffmpeg` (macOS) or `apt install ffmpeg` (Linux), ' +
  'or point TALKTHRU_FFMPEG / TALKTHRU_FFPROBE at the binaries.';

/** Places Homebrew/MacPorts put ffmpeg when PATH is not inherited (launchd, MCP stdio). */
const FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin'];

export interface RunResult {
  code: number;
  stdout: Buffer;
  stderr: string;
}

export interface RunOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Collect stdout as binary (rawvideo pipes). Off by default to save memory. */
  captureStdout?: boolean;
  maxStdoutBytes?: number;
}

const DEFAULT_TIMEOUT_MS = 10 * 60_000;
const MAX_STDOUT_BYTES = 1024 * 1024 * 1024; // 1 GiB ceiling on piped raw video.

/**
 * Spawn a binary and await completion. Never uses a shell, so filenames with
 * spaces/quotes are safe. Rejects with TalkthruError on non-zero exit.
 */
export async function run(bin: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxStdout = opts.maxStdoutBytes ?? MAX_STDOUT_BYTES;
  return new Promise<RunResult>((resolve, reject) => {
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      reject(new TalkthruError(ErrorCodes.FFMPEG_MISSING, `Failed to spawn ${bin}`, { cause: e }));
      return;
    }
    const chunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderr = '';
    let settled = false;
    let overflow = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(() =>
        reject(
          new TalkthruError(ErrorCodes.FFMPEG_FAILED, `${path.basename(bin)} timed out after ${timeoutMs}ms`, {
            hint: 'Raise the timeout or shorten the recording.',
          }),
        ),
      );
    }, timeoutMs);

    const onAbort = () => {
      child.kill('SIGKILL');
      finish(() => reject(new TalkthruError(ErrorCodes.FFMPEG_FAILED, `${path.basename(bin)} aborted`)));
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (d: Buffer) => {
      if (!opts.captureStdout) return;
      stdoutBytes += d.length;
      if (stdoutBytes > maxStdout) {
        overflow = true;
        child.kill('SIGKILL');
        return;
      }
      chunks.push(d);
    });
    child.stderr?.on('data', (d: Buffer) => {
      // ffmpeg is chatty; keep only the tail so an error message stays readable.
      stderr = (stderr + d.toString('utf8')).slice(-8000);
    });

    child.on('error', (e: NodeJS.ErrnoException) => {
      finish(() => {
        if (e.code === 'ENOENT') {
          reject(
            new TalkthruError(ErrorCodes.FFMPEG_MISSING, `${path.basename(bin)} not found`, {
              hint: FFMPEG_INSTALL_HINT,
              cause: e,
            }),
          );
        } else {
          reject(new TalkthruError(ErrorCodes.FFMPEG_FAILED, `${path.basename(bin)} failed: ${e.message}`, { cause: e }));
        }
      });
    });

    child.on('close', (code) => {
      finish(() => {
        if (overflow) {
          reject(
            new TalkthruError(ErrorCodes.FFMPEG_FAILED, `${path.basename(bin)} produced more than ${maxStdout} bytes`),
          );
          return;
        }
        if (code !== 0) {
          reject(
            new TalkthruError(
              ErrorCodes.FFMPEG_FAILED,
              `${path.basename(bin)} exited ${code}: ${stderr.trim().split('\n').slice(-4).join(' | ')}`,
            ),
          );
          return;
        }
        resolve({ code: code ?? 0, stdout: Buffer.concat(chunks), stderr });
      });
    });
  });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve a binary: explicit override → PATH → known install dirs.
 * The PATH fallback matters because MCP servers are launched by GUI apps that
 * do not inherit a login shell PATH.
 */
export async function resolveBinary(name: string, override?: string): Promise<string> {
  if (override) {
    if (await fileExists(override)) return override;
    throw new TalkthruError(ErrorCodes.FFMPEG_MISSING, `Configured ${name} not found at ${override}`, {
      hint: FFMPEG_INSTALL_HINT,
    });
  }
  // `which` is not portable enough; probe PATH ourselves.
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  for (const dir of [...pathDirs, ...FALLBACK_DIRS]) {
    const candidate = path.join(dir, name);
    if (await fileExists(candidate)) return candidate;
  }
  throw new TalkthruError(ErrorCodes.FFMPEG_MISSING, `${name} not found on PATH`, { hint: FFMPEG_INSTALL_HINT });
}

export interface FfmpegTools {
  ffmpeg: string;
  ffprobe: string;
}

export async function resolveFfmpeg(cfg: { ffmpegPath?: string; ffprobePath?: string }): Promise<FfmpegTools> {
  const [ffmpeg, ffprobe] = await Promise.all([
    resolveBinary('ffmpeg', cfg.ffmpegPath),
    resolveBinary('ffprobe', cfg.ffprobePath),
  ]);
  return { ffmpeg, ffprobe };
}

interface FfprobeStream {
  codec_type?: string;
  width?: number;
  height?: number;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  duration?: string;
}

function parseRational(value: string | undefined): number {
  if (!value) return 0;
  const [a, b] = value.split('/');
  const num = Number(a);
  const den = b === undefined ? 1 : Number(b);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

/** Inspect a media file. Throws BAD_MEDIA for anything ffprobe cannot read. */
export async function probeMedia(tools: FfmpegTools, file: string): Promise<MediaInfo> {
  let res: RunResult;
  try {
    res = await run(
      tools.ffprobe,
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file],
      { captureStdout: true, timeoutMs: 60_000 },
    );
  } catch (e) {
    throw new TalkthruError(ErrorCodes.BAD_MEDIA, `Cannot read media: ${path.basename(file)}`, {
      hint: 'The upload may be truncated or in an unsupported container.',
      cause: e,
    });
  }
  let parsed: { streams?: FfprobeStream[]; format?: { duration?: string } };
  try {
    parsed = JSON.parse(res.stdout.toString('utf8'));
  } catch (e) {
    throw new TalkthruError(ErrorCodes.FFPROBE_FAILED, 'ffprobe returned unparseable JSON', { cause: e });
  }
  const streams = parsed.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video');
  const audio = streams.find((s) => s.codec_type === 'audio');
  const durationSec = Number(parsed.format?.duration ?? video?.duration ?? audio?.duration ?? 0);
  const fps = parseRational(video?.avg_frame_rate) || parseRational(video?.r_frame_rate) || 0;

  if (!video && !audio) {
    throw new TalkthruError(ErrorCodes.BAD_MEDIA, `No audio or video streams in ${path.basename(file)}`);
  }
  return {
    path: file,
    durationMs: Number.isFinite(durationSec) ? Math.round(durationSec * 1000) : 0,
    hasVideo: Boolean(video),
    hasAudio: Boolean(audio),
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    fps,
  };
}

/**
 * Decode the whole video to a low-res grayscale sequence for perceptual
 * diffing. Returns one Buffer per sampled frame, each edge*edge bytes.
 *
 * Deliberately a single ffmpeg pass piped to stdout: no temp files, and the
 * data volume is tiny (32x32 = 1 KiB per sample, 4 samples/sec).
 */
export async function extractProbeFrames(
  tools: FfmpegTools,
  file: string,
  opts: { fps?: number; edge?: number; signal?: AbortSignal } = {},
): Promise<{ frames: Buffer[]; fps: number; edge: number }> {
  const fps = opts.fps ?? KEYFRAMES.PROBE_FPS;
  const edge = opts.edge ?? KEYFRAMES.PROBE_EDGE_PX;
  const res = await run(
    tools.ffmpeg,
    [
      '-v', 'error',
      '-nostdin',
      '-i', file,
      '-an',
      '-sn',
      '-vf', `fps=${fps},scale=${edge}:${edge}:flags=area,format=rgb24`,
      '-f', 'rawvideo',
      '-pix_fmt', 'rgb24',
      '-',
    ],
    { captureStdout: true, signal: opts.signal },
  );
  const frameBytes = edge * edge * KEYFRAMES.PROBE_CHANNELS;
  const frames: Buffer[] = [];
  for (let off = 0; off + frameBytes <= res.stdout.length; off += frameBytes) {
    frames.push(res.stdout.subarray(off, off + frameBytes));
  }
  const remainder = res.stdout.length % frameBytes;
  if (remainder !== 0) log.debug('probe pass produced a partial trailing frame', { remainder });
  return { frames, fps, edge };
}

/** Fit (w,h) inside a square of `maxEdge` without upscaling; even dimensions. */
export function fitDimensions(width: number, height: number, maxEdge: number): { width: number; height: number } {
  if (width <= 0 || height <= 0) return { width: maxEdge, height: maxEdge };
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(width * scale), height: even(height * scale) };
}

/** Extract one JPEG at `tMs`. Uses input seeking (fast) with accurate seek. */
export async function extractFrameAt(
  tools: FfmpegTools,
  file: string,
  tMs: number,
  outPath: string,
  opts: { width: number; height: number; quality?: number; signal?: AbortSignal },
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await run(
    tools.ffmpeg,
    [
      '-v', 'error',
      '-nostdin',
      '-ss', (Math.max(0, tMs) / 1000).toFixed(3),
      '-i', file,
      '-frames:v', '1',
      '-vf', `scale=${opts.width}:${opts.height}:flags=lanczos`,
      '-q:v', String(opts.quality ?? KEYFRAMES.JPEG_QUALITY),
      '-y',
      outPath,
    ],
    { signal: opts.signal, timeoutMs: 120_000 },
  );
}

/** Transcode any audio-bearing file to the 16 kHz mono WAV whisper.cpp wants. */
export async function extractAudioWav(
  tools: FfmpegTools,
  file: string,
  outPath: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await run(
    tools.ffmpeg,
    [
      '-v', 'error',
      '-nostdin',
      '-i', file,
      '-vn',
      '-ac', String(TRANSCRIBE.CHANNELS),
      '-ar', String(TRANSCRIBE.SAMPLE_RATE),
      '-c:a', 'pcm_s16le',
      '-y',
      outPath,
    ],
    { signal: opts.signal },
  );
}

/**
 * Build a video from a directory of numbered stills (frame-sequence uploads).
 * Lets the rest of the pipeline treat every session as "a video".
 */
export async function framesToVideo(
  tools: FfmpegTools,
  pattern: string,
  outPath: string,
  fps: number,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await run(
    tools.ffmpeg,
    [
      '-v', 'error',
      '-nostdin',
      '-framerate', String(fps),
      '-pattern_type', 'glob',
      '-i', pattern,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-y',
      outPath,
    ],
    { signal: opts.signal },
  );
}

export async function ffmpegVersion(tools: FfmpegTools): Promise<string> {
  const res = await run(tools.ffmpeg, ['-version'], { captureStdout: true, timeoutMs: 15_000 });
  return res.stdout.toString('utf8').split('\n')[0] ?? 'unknown';
}
