import { describe, expect, it } from 'vitest';
import { buildTimeline, keyframeForTime, segmentUtterances, timelineFromFramesOnly } from '../src/align.js';
import type { Keyframe, TranscriptWord, UiSnapshot } from '../src/types.js';

function words(spec: Array<[string, number, number, number?]>): TranscriptWord[] {
  return spec.map(([text, startMs, endMs, segmentIndex]) => ({
    text,
    startMs,
    endMs,
    ...(segmentIndex === undefined ? {} : { segmentIndex }),
  }));
}

function keyframe(index: number, tMs: number): Keyframe {
  return { index, tMs, relPath: `frames/f0${index}.jpg`, delta: 0.5, width: 100, height: 200, bytes: 1000 };
}

describe('segmentUtterances', () => {
  it('returns nothing for no words', () => {
    expect(segmentUtterances([])).toEqual([]);
  });

  it('keeps words inside one utterance when the gaps are short', () => {
    const u = segmentUtterances(words([['the', 0, 200], ['spacing', 250, 600], ['is', 650, 800]]), 600);
    expect(u).toHaveLength(1);
    expect(u[0]!.text).toBe('the spacing is');
    expect(u[0]!.startMs).toBe(0);
    expect(u[0]!.endMs).toBe(800);
  });

  it('splits when silence reaches the pause threshold', () => {
    const u = segmentUtterances(words([['first', 0, 500], ['second', 1200, 1500]]), 600);
    expect(u.map((x) => x.text)).toEqual(['first', 'second']);
  });

  it('does not split just below the threshold', () => {
    const u = segmentUtterances(words([['first', 0, 500], ['second', 1090, 1300]]), 600);
    expect(u).toHaveLength(1);
  });

  it('splits on a VAD region change even when the timestamps look continuous', () => {
    // whisper compressed the silence: the timestamps suggest no gap, but the
    // words came from two different speech regions. The region wins.
    const u = segmentUtterances(words([['end', 0, 500, 0], ['start', 520, 900, 1]]), 600);
    expect(u.map((x) => x.text)).toEqual(['end', 'start']);
  });

  it('splits an utterance that runs past the maximum length', () => {
    const long = Array.from({ length: 60 }, (_, i): [string, number, number] => [`w${i}`, i * 500, i * 500 + 400]);
    const u = segmentUtterances(words(long), 600, 5_000);
    expect(u.length).toBeGreaterThan(1);
    for (const utt of u) expect(utt.endMs - utt.startMs).toBeLessThanOrEqual(6_000);
  });

  it('tidies spacing before punctuation', () => {
    const u = segmentUtterances(words([['this', 0, 100], ['is', 110, 200], ['wrong', 210, 300], ['.', 310, 320]]), 600);
    expect(u[0]!.text).toBe('this is wrong.');
  });

  it('covers every word exactly once', () => {
    const input = words([
      ['a', 0, 100, 0],
      ['b', 110, 200, 0],
      ['c', 2000, 2100, 1],
      ['d', 2110, 2200, 1],
    ]);
    const joined = segmentUtterances(input, 600).flatMap((u) => u.text.split(' '));
    expect(joined).toEqual(['a', 'b', 'c', 'd']);
  });

  it('numbers utterances consecutively from zero', () => {
    const u = segmentUtterances(words([['a', 0, 10], ['b', 1000, 1010], ['c', 2000, 2010]]), 600);
    expect(u.map((x) => x.index)).toEqual([0, 1, 2]);
  });
});

describe('keyframeForTime', () => {
  const frames = [keyframe(0, 0), keyframe(1, 10_000), keyframe(2, 20_000)];

  it('returns null when there are no frames', () => {
    expect(keyframeForTime([], 5_000)).toBeNull();
  });

  it('picks the frame that was on screen', () => {
    expect(keyframeForTime(frames, 15_000)!.index).toBe(1);
    expect(keyframeForTime(frames, 25_000)!.index).toBe(2);
  });

  it('binds speech before the first frame to the opening frame', () => {
    expect(keyframeForTime(frames, 0)!.index).toBe(0);
  });

  it('looks back so speech that trails an action binds to the frame that caused it', () => {
    // Speaking at 10.1 s about something that changed at 10 s: without the lag
    // allowance this would still be frame 1, but just after a cut the user is
    // usually still reacting to the previous screen.
    expect(keyframeForTime(frames, 10_100, 250)!.index).toBe(0);
    expect(keyframeForTime(frames, 10_400, 250)!.index).toBe(1);
  });
});

describe('buildTimeline', () => {
  const frames = [keyframe(0, 0), keyframe(1, 10_000)];
  const snapshots: UiSnapshot[] = [
    {
      tMs: 0,
      nodes: [{ type: 'button', testId: 'play', label: 'Play', rect: [10, 10, 60, 60], depth: 2 }],
    },
    {
      tMs: 10_000,
      nodes: [{ type: 'div', testId: 'card', label: 'Mars', rect: [10, 100, 200, 200], depth: 2 }],
      occlusions: ['keyboard'],
    },
  ];

  it('attaches the UI context of the bound frame', () => {
    const utterances = segmentUtterances(words([['hello', 12_000, 12_500]]), 600);
    const timeline = buildTimeline(utterances, frames, snapshots);
    expect(timeline).toHaveLength(1);
    expect(timeline[0]!.keyframeIndex).toBe(1);
    expect(timeline[0]!.uiContext[0]!.testId).toBe('card');
    expect(timeline[0]!.occlusions).toEqual(['keyboard']);
  });

  it('shifts narration by the reported audio offset', () => {
    const utterances = segmentUtterances(words([['late', 2_000, 2_500]]), 600);
    // Audio started 9 s after video, so this was really spoken at 11 s.
    const timeline = buildTimeline(utterances, frames, snapshots, { audioOffsetMs: 9_000 });
    expect(timeline[0]!.keyframeIndex).toBe(1);
  });

  it('yields a null keyframe when the session has no frames', () => {
    const utterances = segmentUtterances(words([['audio only', 0, 100]]), 600);
    const timeline = buildTimeline(utterances, [], []);
    expect(timeline[0]!.keyframeIndex).toBeNull();
    expect(timeline[0]!.keyframePath).toBeNull();
  });

  it('preserves utterance text and timing verbatim', () => {
    const utterances = segmentUtterances(words([['the', 5_000, 5_200], ['top', 5_250, 5_500]]), 600);
    const timeline = buildTimeline(utterances, frames, []);
    expect(timeline[0]!.utterance).toBe('the top');
    expect(timeline[0]!.startMs).toBe(5_000);
    expect(timeline[0]!.endMs).toBe(5_500);
  });
});

describe('timelineFromFramesOnly', () => {
  it('produces one silent entry per frame so a wordless session is still useful', () => {
    const frames = [keyframe(0, 0), keyframe(1, 4_000)];
    const timeline = timelineFromFramesOnly(frames, []);
    expect(timeline).toHaveLength(2);
    expect(timeline.every((t) => t.utterance === '')).toBe(true);
    expect(timeline.map((t) => t.keyframeIndex)).toEqual([0, 1]);
  });
});
