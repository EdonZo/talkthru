import fs from 'node:fs/promises';
import path from 'node:path';
import { KEYFRAMES, BUNDLE } from './constants.js';
import { extractFrameAt, extractProbeFrames, fitDimensions, type FfmpegTools } from './ffmpeg.js';
import { log } from './log.js';
import type { Keyframe, MediaInfo } from './types.js';

/* ------------------------------------------------------------------ *
 * Pure perceptual helpers — no I/O, exhaustively unit-tested.
 *
 * All of these operate on packed RGB probe frames (edge x edge x 3).
 * ------------------------------------------------------------------ */

/** Mean absolute difference of two equal-length buffers, 0..1. */
export function meanAbsDiff(a: Uint8Array, b: Uint8Array): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / (a.length * 255);
}

/** Rec. 601 luma plane from a packed RGB frame. */
export function toLuma(rgb: Uint8Array, edge: number): Uint8Array {
  const out = new Uint8Array(edge * edge);
  for (let i = 0; i < out.length; i++) {
    const r = rgb[i * 3] ?? 0;
    const g = rgb[i * 3 + 1] ?? 0;
    const b = rgb[i * 3 + 2] ?? 0;
    out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return out;
}

/**
 * Box-average a square single-channel buffer down to `cols`x`rows`.
 * Exported for tests; also the first half of dHash.
 */
export function boxDownsample(frame: Uint8Array, edge: number, cols: number, rows: number): number[] {
  const out = new Array<number>(cols * rows).fill(0);
  if (edge <= 0 || frame.length < edge * edge) return out;
  for (let r = 0; r < rows; r++) {
    const y0 = Math.floor((r * edge) / rows);
    const y1 = Math.max(y0 + 1, Math.floor(((r + 1) * edge) / rows));
    for (let c = 0; c < cols; c++) {
      const x0 = Math.floor((c * edge) / cols);
      const x1 = Math.max(x0 + 1, Math.floor(((c + 1) * edge) / cols));
      let sum = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          sum += frame[y * edge + x]!;
          n++;
        }
      }
      out[r * cols + c] = n > 0 ? sum / n : 0;
    }
  }
  return out;
}

/**
 * 64-bit difference hash of the luma plane. Robust to small brightness shifts
 * (dimming, cursor blink) which is exactly the near-duplicate class we collapse.
 *
 * NOTE: a dHash is structure-only. Two screens with the same layout but
 * different colours hash identically — that is why duplicate detection also
 * requires the colour signature below to match.
 */
export function dhash(luma: Uint8Array, edge: number): bigint {
  const cells = boxDownsample(luma, edge, 9, 8);
  let hash = 0n;
  let bit = 0n;
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 8; c++) {
      if (cells[r * 9 + c]! > cells[r * 9 + c + 1]!) hash |= 1n << bit;
      bit += 1n;
    }
  }
  return hash;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let count = 0;
  while (x !== 0n) {
    x &= x - 1n;
    count++;
  }
  return count;
}

/** Coarse grid of average RGB — cheap, and it sees hue where a dHash cannot. */
export function colorSignature(rgb: Uint8Array, edge: number, grid = KEYFRAMES.COLOR_SIGNATURE_EDGE): number[] {
  const out = new Array<number>(grid * grid * 3).fill(0);
  if (edge <= 0) return out;
  for (let gy = 0; gy < grid; gy++) {
    const y0 = Math.floor((gy * edge) / grid);
    const y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * edge) / grid));
    for (let gx = 0; gx < grid; gx++) {
      const x0 = Math.floor((gx * edge) / grid);
      const x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * edge) / grid));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * edge + x) * 3;
          r += rgb[i] ?? 0;
          g += rgb[i + 1] ?? 0;
          b += rgb[i + 2] ?? 0;
          n++;
        }
      }
      const cell = (gy * grid + gx) * 3;
      out[cell] = n > 0 ? r / n : 0;
      out[cell + 1] = n > 0 ? g / n : 0;
      out[cell + 2] = n > 0 ? b / n : 0;
    }
  }
  return out;
}

/** Mean per-channel distance between two colour signatures, 0..1. */
export function colorDistance(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 1;
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!);
  return sum / (a.length * 255);
}

export interface FrameSignature {
  hash: bigint;
  color: number[];
}

export function signatureOf(rgb: Uint8Array, edge: number): FrameSignature {
  return { hash: dhash(toLuma(rgb, edge), edge), color: colorSignature(rgb, edge) };
}

/**
 * "Is this the same screen?" — requires structural AND colour agreement.
 * Either test on its own produces false merges (see the fixture's red/green
 * scenes, which share a luma layout).
 */
export function isSameScreen(
  a: FrameSignature,
  b: FrameSignature,
  hammingMax: number = KEYFRAMES.DUP_HAMMING,
  colorMax: number = KEYFRAMES.DUP_COLOR_DIST,
): boolean {
  return hamming(a.hash, b.hash) <= hammingMax && colorDistance(a.color, b.color) <= colorMax;
}

export interface SelectedFrame {
  /** Index into the probe frame array. */
  probeIndex: number;
  tMs: number;
  delta: number;
  /**
   * Set when this frame shows a screen an earlier keyframe already captured
   * (the user navigated back). The frame is KEPT — narration binds to the
   * nearest preceding keyframe, so dropping it would attach the user's words
   * to the wrong screen — but it reuses the earlier image instead of encoding
   * a second copy. Value is the position in the returned array.
   */
  duplicateOf?: number;
}

export interface SelectOptions {
  fps: number;
  edge?: number;
  sceneDelta?: number;
  dupHamming?: number;
  dupColorDist?: number;
  maxFrames?: number;
  minGapSec?: number;
}

/**
 * Choose which sampled frames become keyframes.
 *
 * Contract (a future agent changing this must preserve all five):
 *  1. The first frame is always emitted (a session with video never has zero
 *     keyframes).
 *  2. Output is sorted by time ascending, with unique probe indices.
 *  3. `length <= maxFrames`, always.
 *  4. When over cap, the frames kept are the ones with the largest deltas,
 *     plus the first frame.
 *  5. Revisited screens are marked `duplicateOf`, never dropped — alignment
 *     correctness outranks image dedup.
 */
export function selectKeyframes(frames: Uint8Array[], opts: SelectOptions): SelectedFrame[] {
  if (frames.length === 0) return [];
  const fps = opts.fps > 0 ? opts.fps : KEYFRAMES.PROBE_FPS;
  const sceneDelta = opts.sceneDelta ?? KEYFRAMES.SCENE_DELTA;
  const dupHamming = opts.dupHamming ?? KEYFRAMES.DUP_HAMMING;
  const dupColor = opts.dupColorDist ?? KEYFRAMES.DUP_COLOR_DIST;
  const maxFrames = Math.max(1, opts.maxFrames ?? KEYFRAMES.MAX_FRAMES);
  const minGapSec = opts.minGapSec ?? KEYFRAMES.MIN_GAP_SEC;
  const edge = opts.edge ?? Math.round(Math.sqrt(frames[0]!.length / KEYFRAMES.PROBE_CHANNELS));

  const kept: SelectedFrame[] = [{ probeIndex: 0, tMs: 0, delta: 1 }];
  const signatures: FrameSignature[] = [signatureOf(frames[0]!, edge)];
  let reference = frames[0]!;
  let lastKeptSec = 0;

  for (let i = 1; i < frames.length; i++) {
    const frame = frames[i]!;
    const tSec = i / fps;
    const delta = meanAbsDiff(frame, reference);
    if (delta < sceneDelta) continue;

    // The screen genuinely changed: this becomes the new comparison baseline
    // whether or not we end up emitting it.
    reference = frame;
    if (tSec - lastKeptSec < minGapSec) continue;

    const sig = signatureOf(frame, edge);
    const priorIndex = signatures.findIndex((s) => isSameScreen(sig, s, dupHamming, dupColor));

    kept.push({
      probeIndex: i,
      tMs: Math.round(tSec * 1000),
      delta,
      ...(priorIndex >= 0 ? { duplicateOf: priorIndex } : {}),
    });
    signatures.push(sig);
    lastKeptSec = tSec;
  }

  if (kept.length <= maxFrames) return kept;

  // Over budget: keep the opening frame plus the biggest visual changes.
  const [first, ...rest] = kept;
  const survivors = rest
    .slice()
    .sort((a, b) => b.delta - a.delta)
    .slice(0, maxFrames - 1);
  const ordered = [first!, ...survivors].sort((a, b) => a.tMs - b.tMs);
  return remapDuplicateRefs(kept, ordered);
}

/** After trimming, `duplicateOf` positions must point into the new array. */
function remapDuplicateRefs(original: SelectedFrame[], ordered: SelectedFrame[]): SelectedFrame[] {
  const newPosByProbe = new Map<number, number>();
  ordered.forEach((f, i) => newPosByProbe.set(f.probeIndex, i));
  return ordered.map((f) => {
    if (f.duplicateOf === undefined) return f;
    const sourceProbe = original[f.duplicateOf]?.probeIndex;
    const remapped = sourceProbe === undefined ? undefined : newPosByProbe.get(sourceProbe);
    // The frame this one duplicated may itself have been trimmed away; in that
    // case this frame is no longer a duplicate of anything present.
    if (remapped === undefined || remapped >= newPosByProbe.get(f.probeIndex)!) {
      const { duplicateOf: _drop, ...rest } = f;
      return rest;
    }
    return { ...f, duplicateOf: remapped };
  });
}

/* ------------------------------------------------------------------ *
 * Orchestration — probe pass, selection, re-extraction at quality.
 * ------------------------------------------------------------------ */

export interface ExtractOptions {
  sceneDelta?: number;
  maxFrames?: number;
  maxEdgePx?: number;
  quality?: number;
  signal?: AbortSignal;
}

export interface ExtractResult {
  keyframes: Keyframe[];
  /** Non-fatal notes to surface on the session. */
  warnings: string[];
  probeFrameCount: number;
}

export async function extractKeyframes(
  tools: FfmpegTools,
  media: MediaInfo,
  sessionPath: string,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const warnings: string[] = [];
  if (!media.hasVideo) {
    return { keyframes: [], warnings: ['No video track — bundle is narration only.'], probeFrameCount: 0 };
  }

  const { frames, fps, edge } = await extractProbeFrames(tools, media.path, { signal: opts.signal });
  if (frames.length === 0) {
    return {
      keyframes: [],
      warnings: ['Video track decoded to zero frames — the recording may be corrupt.'],
      probeFrameCount: 0,
    };
  }

  const maxFrames = opts.maxFrames ?? KEYFRAMES.MAX_FRAMES;
  const selected = selectKeyframes(frames, {
    fps,
    edge,
    sceneDelta: opts.sceneDelta,
    maxFrames,
    dupHamming: KEYFRAMES.DUP_HAMMING,
    minGapSec: KEYFRAMES.MIN_GAP_SEC,
  });
  if (selected.length >= maxFrames) {
    warnings.push(`Frame budget reached (${maxFrames}); kept the largest visual changes and dropped the rest.`);
  }

  const dims = fitDimensions(media.width, media.height, opts.maxEdgePx ?? KEYFRAMES.MAX_EDGE_PX);
  const framesDir = path.join(sessionPath, BUNDLE.FRAMES_DIR);
  await fs.mkdir(framesDir, { recursive: true });

  // See KEYFRAMES.SAMPLE_OFFSET_RATIO: probe frame i represents source content
  // around i/fps + 1/(2*fps), so both the emitted image and the timestamp we
  // report must be nudged forward, or every keyframe shows the screen from
  // just before the change that selected it.
  const sampleOffsetMs = Math.round((1000 / fps) * KEYFRAMES.SAMPLE_OFFSET_RATIO);
  const lastSampleableMs = Math.max(0, media.durationMs - 1);
  const sampleTime = (tMs: number): number => Math.min(tMs + sampleOffsetMs, lastSampleableMs);

  const keyframes: Keyframe[] = [];
  /** Maps a position in `selected` to the emitted keyframe, for duplicate reuse. */
  const emitted = new Map<number, Keyframe>();

  for (let i = 0; i < selected.length; i++) {
    const sel = selected[i]!;
    const reuse = sel.duplicateOf !== undefined ? emitted.get(sel.duplicateOf) : undefined;

    if (reuse) {
      // Same screen as an earlier keyframe: point at that image, no re-encode.
      const kf: Keyframe = {
        index: keyframes.length,
        tMs: sampleTime(sel.tMs),
        relPath: reuse.relPath,
        delta: Number(sel.delta.toFixed(4)),
        width: reuse.width,
        height: reuse.height,
        bytes: 0,
        sameScreenAs: reuse.index,
      };
      keyframes.push(kf);
      emitted.set(i, kf);
      continue;
    }

    const name = `f${String(keyframes.length).padStart(2, '0')}.jpg`;
    const outPath = path.join(framesDir, name);
    const sampleMs = sampleTime(sel.tMs);
    try {
      await extractFrameAt(tools, media.path, sampleMs, outPath, {
        width: dims.width,
        height: dims.height,
        ...(opts.quality === undefined ? {} : { quality: opts.quality }),
        ...(opts.signal ? { signal: opts.signal } : {}),
      });
    } catch (e) {
      // One unreadable frame must not sink the session.
      log.warn('keyframe extraction failed, skipping', { tMs: sel.tMs, error: String(e) });
      warnings.push(`Could not extract the frame at ${(sel.tMs / 1000).toFixed(1)}s.`);
      continue;
    }

    let bytes = 0;
    try {
      bytes = (await fs.stat(outPath)).size;
    } catch {
      warnings.push(`Frame at ${(sel.tMs / 1000).toFixed(1)}s was not written.`);
      continue;
    }
    if (bytes === 0) {
      await fs.rm(outPath, { force: true });
      warnings.push(`Frame at ${(sel.tMs / 1000).toFixed(1)}s decoded empty and was dropped.`);
      continue;
    }

    const kf: Keyframe = {
      index: keyframes.length,
      tMs: sampleMs,
      relPath: `${BUNDLE.FRAMES_DIR}/${name}`,
      delta: Number(sel.delta.toFixed(4)),
      width: dims.width,
      height: dims.height,
      bytes,
    };
    keyframes.push(kf);
    emitted.set(i, kf);
  }

  if (keyframes.length === 0) warnings.push('No keyframes could be extracted from the video.');
  return { keyframes, warnings, probeFrameCount: frames.length };
}
