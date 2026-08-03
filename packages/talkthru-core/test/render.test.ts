import { describe, expect, it } from 'vitest';
import { estimateTokens, formatTimestamp, renderMarkdown, renderWithinBudget, type RenderInput } from '../src/render.js';
import type { Keyframe, TimelineEntry } from '../src/types.js';

type RenderInputForTest = RenderInput;

function keyframe(index: number, tMs: number, extra: Partial<Keyframe> = {}): Keyframe {
  return {
    index,
    tMs,
    relPath: `frames/f${String(index).padStart(2, '0')}.jpg`,
    delta: 0.4,
    width: 480,
    height: 854,
    bytes: 20_000,
    ...extra,
  };
}

function entry(utterance: string, startMs: number, keyframeIndex: number | null): TimelineEntry {
  return {
    utterance,
    startMs,
    endMs: startMs + 1_000,
    keyframeIndex,
    keyframePath: keyframeIndex === null ? null : `frames/f${String(keyframeIndex).padStart(2, '0')}.jpg`,
    uiContext: [],
    occlusions: [],
  };
}

function input(overrides: Partial<RenderInputForTest> = {}): RenderInputForTest {
  return {
    id: '20260803-000000-abcdef',
    durationMs: 60_000,
    metadata: { app: 'AstroShort', appVersion: '1.4.0', device: 'iPhone', os: 'iOS 26' },
    keyframes: [keyframe(0, 0), keyframe(1, 10_000)],
    timeline: [entry('the spacing is wrong', 2_000, 0), entry('now it opened', 12_000, 1)],
    warnings: [],
    transcriptEngine: 'whisper.cpp:base.en',
    coarseTiming: false,
    ...overrides,
  };
}

describe('formatTimestamp', () => {
  it('formats mm:ss', () => {
    expect(formatTimestamp(0)).toBe('00:00');
    expect(formatTimestamp(9_400)).toBe('00:09');
    expect(formatTimestamp(65_000)).toBe('01:05');
    expect(formatTimestamp(3_600_000)).toBe('60:00');
  });

  it('never renders a negative time', () => {
    expect(formatTimestamp(-500)).toBe('00:00');
  });
});

describe('renderMarkdown', () => {
  it('puts the session id, app and counts in the header', () => {
    const md = renderMarkdown(input());
    expect(md).toContain('# Talkthru session 20260803-000000-abcdef');
    expect(md).toContain('AstroShort 1.4.0');
    expect(md).toContain('2 frames');
    expect(md).toContain('2 utterances');
  });

  it('groups several utterances under one frame heading', () => {
    const md = renderMarkdown(
      input({ timeline: [entry('first thing', 1_000, 0), entry('second thing', 3_000, 0)] }),
    );
    const headings = md.split('\n').filter((l) => l.startsWith('## '));
    expect(headings).toHaveLength(2); // f00 (with both lines) and the silent f01
    expect(md).toContain('- [00:01] "first thing"');
    expect(md).toContain('- [00:03] "second thing"');
  });

  it('marks a revisited screen and reuses the earlier image path', () => {
    const md = renderMarkdown(
      input({
        keyframes: [keyframe(0, 0), keyframe(1, 10_000, { relPath: 'frames/f00.jpg', sameScreenAs: 0, bytes: 0 })],
        timeline: [entry('back here again', 11_000, 1)],
      }),
    );
    expect(md).toContain('back on the f00 screen');
    expect(md).toContain('`frames/f00.jpg`');
  });

  it('states what could not be seen instead of presenting a blank region', () => {
    const withOcclusion = { ...entry('why is it empty', 1_000, 0), occlusions: ['system alert'] };
    const md = renderMarkdown(input({ timeline: [withOcclusion] }));
    expect(md).toContain('occluded: system alert');
  });

  it('warns when timing is only sentence-level', () => {
    expect(renderMarkdown(input({ coarseTiming: true }))).toContain('Timing is sentence-level');
    expect(renderMarkdown(input({ coarseTiming: false }))).not.toContain('Timing is sentence-level');
  });

  it('lists warnings at the end', () => {
    const md = renderMarkdown(input({ warnings: ['No audio track — nobody narrated this session.'] }));
    expect(md).toContain('## Warnings');
    expect(md).toContain('No audio track');
  });

  it('says so plainly when nothing was recovered', () => {
    const md = renderMarkdown(input({ keyframes: [], timeline: [], durationMs: 0 }));
    expect(md).toContain('No narration and no frames');
  });

  it('renders utterances that have no frame', () => {
    const md = renderMarkdown(input({ keyframes: [], timeline: [entry('audio only session', 500, null)] }));
    expect(md).toContain('(no frame)');
    expect(md).toContain('audio only session');
  });

  it('ends with exactly one newline and no triple blank lines', () => {
    const md = renderMarkdown(input());
    expect(md.endsWith('\n')).toBe(true);
    expect(md).not.toMatch(/\n{3}/);
  });
});

describe('renderWithinBudget', () => {
  const heavyUi = Array.from({ length: 40 }, (_, i) => ({
    type: 'button',
    testId: `control-${i}`,
    label: `A fairly long control label number ${i}`,
    rect: [i, i * 2, 120, 44] as [number, number, number, number],
    depth: 4,
  }));

  it('leaves a small session untouched', () => {
    const result = renderWithinBudget(input());
    expect(result.trimmed).toBe(false);
    expect(result.estimatedTokens).toBeGreaterThan(0);
  });

  it('trims UI context to fit the budget but never drops narration', () => {
    const timeline = Array.from({ length: 20 }, (_, i) => ({
      ...entry(`utterance number ${i} about the layout`, i * 1_000, 0),
      uiContext: heavyUi,
    }));
    const result = renderWithinBudget(input({ timeline }), 2_000);
    expect(result.trimmed).toBe(true);
    for (let i = 0; i < 20; i++) {
      expect(result.markdown).toContain(`utterance number ${i} about the layout`);
    }
  });

  it('reports a token estimate consistent with the text length', () => {
    const result = renderWithinBudget(input());
    expect(result.estimatedTokens).toBe(estimateTokens(result.markdown));
  });
});
