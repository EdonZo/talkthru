import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { KEYFRAMES, TRANSCRIBE } from './constants.js';
import { TalkthruError, ErrorCodes } from './errors.js';
import { log } from './log.js';
import type { MediaInfo } from './types.js';

const FFMPEG_INSTALL_HINT =
  'Install it with `brew install ffmpeg` (macOS), `apt install ffmpeg` (Linux) ' +
  'or `winget install ffmpeg` (Windows), ' +
  'or point TALKTHRU_FFMPEG / TALKTHRU_FFPROBE at the binaries.';

/**
 * Where to look when PATH does not have it.
 *
 * This exists because GUI-launched processes do not inherit a login shell PATH:
 * an MCP server started by Claude Desktop, or a launchd job, sees a PATH that
 * frequently lacks /opt/homebrew/bin entirely.
 */
export function fallbackDirs(platform: NodeJS.Platform = process.platform): string[] {
  if (platform === 'win32') {
    const dirs: string[] = [];
    const push = (base: string | undefined, ...rest: string[]) => {
      if (base) dirs.push(path.join(base, ...rest));
    };
    // Chocolatey and Scoop are how ffmpeg actually arrives on Windows; winget
    // drops shims under LocalAppData.
    push(process.env.ChocolateyInstall, 'bin');
    push(process.env.ALLUSERSPROFILE, 'chocolatey', 'bin');
    push(process.env.USERPROFILE, 'scoop', 'shims');
    push(process.env.SCOOP, 'shims');
    push(process.env.LOCALAPPDATA, 'Microsoft', 'WindowsApps');
    push(process.env.ProgramFiles, 'ffmpeg', 'bin');
    push(process.env['ProgramFiles(x86)'], 'ffmpeg', 'bin');
    return dirs;
  }
  return ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin'];
}

/**
 * Filenames to try for a bare binary name.
 *
 * On Windows `ffmpeg` is a file called `ffmpeg.exe`, so probing the bare name
 * finds nothing and the tool reports ffmpeg as missing on a machine where it is
 * installed and working. PATHEXT is the authority on which suffixes count.
 */
export function binaryCandidates(name: string, platform: NodeJS.Platform = process.platform): string[] {
  if (platform !== 'win32') return [name];
  if (path.extname(name) !== '') return [name];
  const exts = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((e) => e.trim())
    .filter(Boolean);
  // The bare name last: a extensionless shim is unusual but not impossible.
  return [...exts.map((e) => `${name}${e.toLowerCase()}`), name];
}

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
export async function resolveBinary(
  name: string,
  override?: string,
  opts: { platform?: NodeJS.Platform } = {},
): Promise<string> {
  const platform = opts.platform ?? process.platform;
  if (override) {
    if (await fileExists(override)) return override;
    throw new TalkthruError(ErrorCodes.FFMPEG_MISSING, `Configured ${name} not found at ${override}`, {
      hint: FFMPEG_INSTALL_HINT,
    });
  }
  // `which` is not portable enough; probe PATH ourselves.
  const pathDirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const names = binaryCandidates(name, platform);
  for (const dir of [...pathDirs, ...fallbackDirs(platform)]) {
    for (const candidateName of names) {
      const candidate = path.join(dir, candidateName);
      if (await fileExists(candidate)) return candidate;
    }
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

/**
 * A timeout that scales with the media instead of a flat ceiling.
 *
 * The flat 10-minute default is generous for a phone clip and marginal for a
 * long 4K recording on an old machine: decoding is roughly proportional to
 * duration, so give every job 3x the media's own length, floored at the
 * default. Measured: a 10-min 4K file probes in ~40 s on Apple silicon, so 3x
 * duration only ever matters on hardware an order of magnitude slower.
 */
export function durationScaledTimeout(durationMs: number | undefined, floorMs = DEFAULT_TIMEOUT_MS): number {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) return floorMs;
  return Math.max(floorMs, Math.round(durationMs * 3));
}

export async function extractProbeFrames(
  tools: FfmpegTools,
  file: string,
  opts: { fps?: number; edge?: number; signal?: AbortSignal; timeoutMs?: number } = {},
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
    { captureStdout: true, signal: opts.signal, timeoutMs: opts.timeoutMs },
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
  opts: { signal?: AbortSignal; normalise?: boolean; timeoutMs?: number } = {},
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
      // Lift a faint recording to a normal speaking level. Without this a
      // phone on a stand transcribes as silence.
      ...(opts.normalise
        ? ['-af', `loudnorm=I=${TRANSCRIBE.LOUDNORM_TARGET_LUFS}:TP=-1.5:LRA=11`]
        : []),
      '-c:a', 'pcm_s16le',
      '-y',
      outPath,
    ],
    { signal: opts.signal, timeoutMs: opts.timeoutMs },
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

  // Windows ffmpeg builds are compiled without glob support — "Pattern type
  // 'glob' was selected but globbing is not supported by this libavformat
  // build" — so every frame-sequence upload failed there. Expanding the pattern
  // in Node and handing ffmpeg an explicit list behaves the same on all three
  // platforms, and takes shell quoting out of the picture at the same time.
  const dir = path.dirname(pattern);
  const ext = path.extname(pattern).toLowerCase();
  const names = (await fs.readdir(dir)).filter((n) => path.extname(n).toLowerCase() === ext).sort();
  if (names.length === 0) {
    throw new TalkthruError(ErrorCodes.NO_MEDIA, `No ${ext} frames to assemble in ${dir}`);
  }

  // concat demuxer: absolute paths need -safe 0, ffmpeg takes forward slashes
  // on Windows too, and a quote inside a name has to be closed and reopened.
  const entry = (name: string) =>
    `file '${path.join(dir, name).replace(/\\/g, '/').replace(/'/g, "'\\''")}'`;
  const seconds = (1 / fps).toFixed(6);
  const listPath = `${outPath}.concat.txt`;
  // The final entry's duration is ignored by the demuxer, so the last frame is
  // repeated — without it that frame lasts no time and drops out of the video.
  const lines = names.map((n) => `${entry(n)}\nduration ${seconds}`);
  await fs.writeFile(listPath, `${lines.join('\n')}\n${entry(names[names.length - 1]!)}\n`, 'utf8');

  try {
    await run(
      tools.ffmpeg,
      [
        '-v', 'error',
        '-nostdin',
        '-f', 'concat',
        '-safe', '0',
        '-i', listPath,
        '-r', String(fps),
        '-c:v', 'libx264',
        '-pix_fmt', 'yuv420p',
        '-y',
        outPath,
      ],
      { signal: opts.signal },
    );
  } finally {
    await fs.rm(listPath, { force: true });
  }
}

/**
 * Mean volume of a track in dBFS, or null if ffmpeg did not report one.
 * Used to tell "the microphone was off" apart from "nobody spoke".
 */
export async function meanVolumeDb(
  tools: FfmpegTools,
  file: string,
  opts: { signal?: AbortSignal } = {},
): Promise<number | null> {
  try {
    const res = await run(
      tools.ffmpeg,
      ['-nostdin', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'],
      { ...(opts.signal ? { signal: opts.signal } : {}), timeoutMs: 120_000 },
    );
    const match = /mean_volume:\s*(-?[\d.]+) dB/.exec(res.stderr);
    return match?.[1] !== undefined ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

export async function ffmpegVersion(tools: FfmpegTools): Promise<string> {
  const res = await run(tools.ffmpeg, ['-version'], { captureStdout: true, timeoutMs: 15_000 });
  return res.stdout.toString('utf8').split('\n')[0] ?? 'unknown';
}
