import { describe, expect, it } from 'vitest';
import {
  boxDownsample,
  colorDistance,
  colorSignature,
  dhash,
  hamming,
  isSameScreen,
  meanAbsDiff,
  selectKeyframes,
  signatureOf,
  toLuma,
} from '../src/keyframes.js';
import { frameWithBox, solidFrame } from './helpers.js';

const EDGE = 32;
const BLUE: [number, number, number] = [30, 58, 138];
const RED: [number, number, number] = [127, 29, 29];
const GREEN: [number, number, number] = [20, 83, 45];
const WHITE: [number, number, number] = [255, 255, 255];

describe('meanAbsDiff', () => {
  it('is zero for identical frames', () => {
    const a = solidFrame(EDGE, 10, 20, 30);
    expect(meanAbsDiff(a, solidFrame(EDGE, 10, 20, 30))).toBe(0);
  });

  it('is one for black against white', () => {
    expect(meanAbsDiff(solidFrame(EDGE, 0, 0, 0), solidFrame(EDGE, 255, 255, 255))).toBe(1);
  });

  it('scales with the magnitude of the change', () => {
    const half = meanAbsDiff(solidFrame(EDGE, 0, 0, 0), solidFrame(EDGE, 128, 128, 128));
    expect(half).toBeCloseTo(128 / 255, 5);
  });

  it('returns 0 rather than throwing on mismatched lengths', () => {
    expect(meanAbsDiff(solidFrame(8, 1, 1, 1), solidFrame(16, 1, 1, 1))).toBe(0);
    expect(meanAbsDiff(new Uint8Array(0), new Uint8Array(0))).toBe(0);
  });
});

describe('toLuma', () => {
  it('collapses RGB to one channel of the right size', () => {
    const luma = toLuma(solidFrame(EDGE, 255, 255, 255), EDGE);
    expect(luma.length).toBe(EDGE * EDGE);
    expect(luma[0]).toBe(255);
  });

  it('weights green most, per Rec. 601', () => {
    const r = toLuma(solidFrame(2, 255, 0, 0), 2)[0]!;
    const g = toLuma(solidFrame(2, 0, 255, 0), 2)[0]!;
    const b = toLuma(solidFrame(2, 0, 0, 255), 2)[0]!;
    expect(g).toBeGreaterThan(r);
    expect(r).toBeGreaterThan(b);
  });
});

describe('boxDownsample', () => {
  it('averages a uniform plane to the same value', () => {
    const plane = new Uint8Array(EDGE * EDGE).fill(100);
    const cells = boxDownsample(plane, EDGE, 4, 4);
    expect(cells).toHaveLength(16);
    for (const c of cells) expect(c).toBeCloseTo(100, 5);
  });

  it('returns zeros when the buffer is too small to be a square', () => {
    expect(boxDownsample(new Uint8Array(4), EDGE, 2, 2)).toEqual([0, 0, 0, 0]);
  });
});

describe('dhash / hamming', () => {
  it('gives an identical hash for an identical frame', () => {
    const f = frameWithBox(EDGE, BLUE, { x: 2, y: 2, w: 12, h: 8, color: WHITE });
    expect(dhash(toLuma(f, EDGE), EDGE)).toBe(dhash(toLuma(f, EDGE), EDGE));
  });

  it('differs when the layout moves', () => {
    const a = frameWithBox(EDGE, BLUE, { x: 2, y: 2, w: 12, h: 8, color: WHITE });
    const b = frameWithBox(EDGE, BLUE, { x: 18, y: 20, w: 12, h: 8, color: WHITE });
    expect(hamming(dhash(toLuma(a, EDGE), EDGE), dhash(toLuma(b, EDGE), EDGE))).toBeGreaterThan(3);
  });

  it('reports hamming 0 for equal hashes and is symmetric', () => {
    expect(hamming(0b1011n, 0b1011n)).toBe(0);
    expect(hamming(0b1000n, 0b0001n)).toBe(2);
    expect(hamming(0b0001n, 0b1000n)).toBe(2);
  });
});

describe('colour signature', () => {
  it('is zero distance from itself and large across hues', () => {
    const red = colorSignature(solidFrame(EDGE, 200, 20, 20), EDGE);
    const green = colorSignature(solidFrame(EDGE, 20, 200, 20), EDGE);
    expect(colorDistance(red, red)).toBe(0);
    expect(colorDistance(red, green)).toBeGreaterThan(0.3);
  });

  it('returns 1 for incomparable signatures', () => {
    expect(colorDistance([], [1, 2, 3])).toBe(1);
  });
});

describe('isSameScreen', () => {
  /**
   * REGRESSION (see DECISIONS.md D6): these three frames have an identical luma
   * layout — same box in the same place — but completely different colours. A
   * grayscale-only dHash reported them as the same screen and the pipeline threw
   * away two real scene changes.
   */
  it('does not merge same-layout screens that differ only in colour', () => {
    const box = { x: 4, y: 4, w: 20, h: 10, color: WHITE };
    const blue = signatureOf(frameWithBox(EDGE, BLUE, box), EDGE);
    const red = signatureOf(frameWithBox(EDGE, RED, box), EDGE);
    const green = signatureOf(frameWithBox(EDGE, GREEN, box), EDGE);

    expect(isSameScreen(blue, red)).toBe(false);
    expect(isSameScreen(blue, green)).toBe(false);
    expect(isSameScreen(red, green)).toBe(false);
  });

  it('still merges a genuinely identical screen', () => {
    const box = { x: 4, y: 4, w: 20, h: 10, color: WHITE };
    const a = signatureOf(frameWithBox(EDGE, BLUE, box), EDGE);
    const b = signatureOf(frameWithBox(EDGE, BLUE, box), EDGE);
    expect(isSameScreen(a, b)).toBe(true);
  });
});

describe('selectKeyframes', () => {
  const fps = 4;

  it('returns nothing for no frames', () => {
    expect(selectKeyframes([], { fps })).toEqual([]);
  });

  it('always emits the first frame, even for a static recording', () => {
    const frames = Array.from({ length: 40 }, () => solidFrame(EDGE, 30, 30, 30));
    const sel = selectKeyframes(frames, { fps, edge: EDGE });
    expect(sel).toHaveLength(1);
    expect(sel[0]).toMatchObject({ probeIndex: 0, tMs: 0 });
  });

  it('emits a frame per scene change and ignores sub-threshold noise', () => {
    const frames: Uint8Array[] = [];
    const push = (f: Uint8Array, n: number) => {
      for (let i = 0; i < n; i++) frames.push(f);
    };
    push(solidFrame(EDGE, 30, 58, 138), 20); // 5 s
    push(solidFrame(EDGE, 127, 29, 29), 20);
    push(solidFrame(EDGE, 234, 179, 8), 20);
    const sel = selectKeyframes(frames, { fps, edge: EDGE });
    expect(sel.map((s) => s.tMs)).toEqual([0, 5000, 10000]);
  });

  it('marks a revisited screen instead of dropping it', () => {
    const frames: Uint8Array[] = [];
    const push = (f: Uint8Array, n: number) => {
      for (let i = 0; i < n; i++) frames.push(f);
    };
    const home = solidFrame(EDGE, 30, 58, 138);
    push(home, 8);
    push(solidFrame(EDGE, 234, 179, 8), 8);
    push(home, 8); // navigated back

    const sel = selectKeyframes(frames, { fps, edge: EDGE });
    expect(sel).toHaveLength(3);
    // The repeat keeps its own slot in time...
    expect(sel[2]!.tMs).toBe(4000);
    // ...but points at the earlier identical frame.
    expect(sel[2]!.duplicateOf).toBe(0);
    expect(sel[0]!.duplicateOf).toBeUndefined();
    expect(sel[1]!.duplicateOf).toBeUndefined();
  });

  it('never exceeds maxFrames and keeps the largest changes', () => {
    // 30 distinct scenes, each a step change in colour.
    const frames: Uint8Array[] = [];
    for (let s = 0; s < 30; s++) {
      const shade = solidFrame(EDGE, (s * 37) % 256, (s * 91) % 256, (s * 53) % 256);
      for (let i = 0; i < 4; i++) frames.push(shade);
    }
    const sel = selectKeyframes(frames, { fps, edge: EDGE, maxFrames: 8 });
    expect(sel.length).toBeLessThanOrEqual(8);
    expect(sel[0]!.tMs).toBe(0);
    // Sorted ascending, unique.
    const times = sel.map((s) => s.tMs);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(new Set(times).size).toBe(times.length);
  });

  it('honours the minimum gap between emitted frames', () => {
    const frames: Uint8Array[] = [];
    // Alternate hard between two very different colours every sample (4 Hz).
    for (let i = 0; i < 40; i++) {
      frames.push(i % 2 === 0 ? solidFrame(EDGE, 0, 0, 0) : solidFrame(EDGE, 255, 255, 255));
    }
    const sel = selectKeyframes(frames, { fps, edge: EDGE, minGapSec: 1 });
    for (let i = 1; i < sel.length; i++) {
      expect(sel[i]!.tMs - sel[i - 1]!.tMs).toBeGreaterThanOrEqual(1000);
    }
  });

  it('keeps duplicateOf pointing backwards after trimming to the cap', () => {
    const frames: Uint8Array[] = [];
    for (let s = 0; s < 12; s++) {
      // Every 3rd scene repeats scene 0 exactly.
      const shade = s % 3 === 0 ? solidFrame(EDGE, 10, 10, 10) : solidFrame(EDGE, (s * 61) % 256, 200, 40);
      for (let i = 0; i < 4; i++) frames.push(shade);
    }
    const sel = selectKeyframes(frames, { fps, edge: EDGE, maxFrames: 5 });
    sel.forEach((f, i) => {
      if (f.duplicateOf !== undefined) {
        expect(f.duplicateOf).toBeLessThan(i);
        expect(sel[f.duplicateOf]).toBeDefined();
      }
    });
  });
});
