import { describe, expect, it } from 'vitest';
import { parseSilenceLog, speechFromSilence } from '../src/speech.js';

/** Verbatim ffmpeg output from the 60 s fixture (six sentences, ~8 s gaps). */
const REAL_LOG = `
[Parsed_silencedetect_0 @ 0xa18c089c0] silence_start: 0
[Parsed_silencedetect_0 @ 0xa18c089c0] silence_end: 2.011813 | silence_duration: 2.011813
[Parsed_silencedetect_0 @ 0xa18c089c0] silence_start: 5.550375
[Parsed_silencedetect_0 @ 0xa18c089c0] silence_end: 12.0075 | silence_duration: 6.457125
[Parsed_silencedetect_0 @ 0xa18c089c0] silence_start: 14.338125
[Parsed_silencedetect_0 @ 0xa18c089c0] silence_end: 22.006187 | silence_duration: 7.668063
[Parsed_silencedetect_0 @ 0xa18c089c0] silence_start: 54.81525
`;

describe('parseSilenceLog', () => {
  it('pairs starts with ends', () => {
    const intervals = parseSilenceLog(REAL_LOG, 60_000);
    expect(intervals).toHaveLength(4);
    expect(intervals[0]).toEqual({ startMs: 0, endMs: 2012 });
    expect(intervals[1]).toEqual({ startMs: 5550, endMs: 12008 });
  });

  it('closes a trailing silence at the end of the file', () => {
    const intervals = parseSilenceLog(REAL_LOG, 60_000);
    expect(intervals[3]).toEqual({ startMs: 54815, endMs: 60_000 });
  });

  it('ignores unrelated ffmpeg chatter', () => {
    expect(parseSilenceLog('frame= 12 fps=0.0 q=-1.0 size=N/A time=00:00:01.00\n', 5_000)).toEqual([]);
  });

  it('drops zero-length intervals', () => {
    const log = '[x] silence_start: 3\n[x] silence_end: 3 | silence_duration: 0\n';
    expect(parseSilenceLog(log, 10_000)).toEqual([]);
  });
});

describe('speechFromSilence', () => {
  it('recovers the six speech regions of the fixture at their true times', () => {
    const silences = parseSilenceLog(REAL_LOG, 60_000);
    const speech = speechFromSilence(silences, 60_000, { padMs: 0 });
    expect(speech).toEqual([
      { startMs: 2012, endMs: 5550 },
      { startMs: 12008, endMs: 14338 },
      { startMs: 22006, endMs: 54815 },
    ]);
  });

  it('pads regions without letting them escape the recording', () => {
    const speech = speechFromSilence([{ startMs: 0, endMs: 1_000 }], 5_000, { padMs: 200 });
    expect(speech[0]!.startMs).toBe(800);
    expect(speech[0]!.endMs).toBe(5_000);
  });

  it('returns nothing when the whole file is silent', () => {
    expect(speechFromSilence([{ startMs: 0, endMs: 60_000 }], 60_000)).toEqual([]);
  });

  it('returns the whole file when no silence was detected', () => {
    expect(speechFromSilence([], 30_000, { padMs: 0 })).toEqual([{ startMs: 0, endMs: 30_000 }]);
  });

  it('discards blips shorter than the minimum speech length', () => {
    const silences = [
      { startMs: 0, endMs: 1_000 },
      { startMs: 1_050, endMs: 5_000 },
    ];
    // The 50 ms window between the two silences is a click, not speech.
    expect(speechFromSilence(silences, 5_000, { padMs: 0, minSpeechMs: 220 })).toEqual([]);
  });
});
