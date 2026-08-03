import { describe, expect, it } from 'vitest';
import { isNonSpeech, joinWords, modelFileName, modelUrl, parseWhisperJson } from '../src/whisper.js';

describe('isNonSpeech', () => {
  it('rejects whisper silence annotations', () => {
    for (const t of ['[BLANK_AUDIO]', '(silence)', '[ Silence ]', '[MUSIC]', '(inaudible)', '[_BEG_]']) {
      expect(isNonSpeech(t), t).toBe(true);
    }
  });

  it('rejects empty and punctuation-only tokens', () => {
    for (const t of ['', '   ', '.', '  ,  ', '--']) expect(isNonSpeech(t), JSON.stringify(t)).toBe(true);
  });

  it('accepts real narration', () => {
    for (const t of ['spacing', 'the', 'wrong.', '42', 'ünïcode']) expect(isNonSpeech(t), t).toBe(false);
  });
});

describe('parseWhisperJson', () => {
  /** Shape verified against whisper-cli 1.x run with `-ml 1 -sow -oj -ojf`. */
  const wordPerSegment = {
    result: { language: 'en' },
    transcription: [
      {
        offsets: { from: 0, to: 10 },
        text: '',
        tokens: [{ text: '[_BEG_]', offsets: { from: 0, to: 0 }, p: 0.99 }],
      },
      { offsets: { from: 10, to: 280 }, text: ' the', tokens: [{ text: ' the', offsets: { from: 10, to: 280 } }] },
      {
        offsets: { from: 280, to: 940 },
        text: ' spacing',
        tokens: [{ text: ' spacing', offsets: { from: 280, to: 940 } }],
      },
      {
        offsets: { from: 3470, to: 3560 },
        text: ' wrong.',
        // Multi-token segment: whisper split the word from its punctuation.
        tokens: [
          { text: ' wrong', offsets: { from: 3470, to: 3540 } },
          { text: '.', offsets: { from: 3540, to: 3560 } },
          { text: '[_TT_]', offsets: { from: 3560, to: 3560 } },
        ],
      },
    ],
  };

  it('reads one word per segment and drops the annotations', () => {
    const t = parseWhisperJson(wordPerSegment, 'test');
    expect(t.words.map((w) => w.text)).toEqual(['the', 'spacing', 'wrong.']);
    expect(t.language).toBe('en');
    expect(t.engine).toBe('test');
  });

  it('prefers the segment text over its sub-tokens for a single word', () => {
    // "wrong." must not be shredded into "wrong" + "." — the segment is already
    // one word because of `-ml 1 -sow`.
    const t = parseWhisperJson(wordPerSegment, 'test');
    expect(t.words.at(-1)).toMatchObject({ text: 'wrong.', startMs: 3470, endMs: 3560 });
  });

  it('falls back to tokens when a segment holds several words', () => {
    const segmentLevel = {
      transcription: [
        {
          offsets: { from: 0, to: 2_000 },
          text: ' the spacing is wrong',
          tokens: [
            { text: ' the', offsets: { from: 0, to: 300 } },
            { text: ' spacing', offsets: { from: 300, to: 900 } },
            { text: ' is', offsets: { from: 900, to: 1_200 } },
            { text: ' wrong', offsets: { from: 1_200, to: 2_000 } },
          ],
        },
      ],
    };
    const t = parseWhisperJson(segmentLevel, 'test');
    expect(t.words.map((w) => w.text)).toEqual(['the', 'spacing', 'is', 'wrong']);
  });

  it('marks coarse timing when every word shares a timestamp', () => {
    const coarse = {
      transcription: [
        { offsets: { from: 0, to: 4_000 }, text: ' one two three four five six', tokens: [] },
      ],
    };
    const t = parseWhisperJson(coarse, 'test');
    expect(t.coarseTiming).toBe(true);
  });

  it('clamps a segment whose end precedes its start', () => {
    const broken = { transcription: [{ offsets: { from: 900, to: 100 }, text: ' oops', tokens: [] }] };
    const t = parseWhisperJson(broken, 'test');
    expect(t.words[0]!.endMs).toBeGreaterThanOrEqual(t.words[0]!.startMs);
  });

  it('returns an empty transcript for junk instead of throwing', () => {
    for (const junk of [null, undefined, {}, { transcription: 'nope' }, []]) {
      const t = parseWhisperJson(junk, 'test');
      expect(t.words).toEqual([]);
      expect(t.text).toBe('');
    }
  });

  it('sorts words by start time', () => {
    const unsorted = {
      transcription: [
        { offsets: { from: 500, to: 600 }, text: ' second', tokens: [] },
        { offsets: { from: 0, to: 100 }, text: ' first', tokens: [] },
      ],
    };
    expect(parseWhisperJson(unsorted, 'test').words.map((w) => w.text)).toEqual(['first', 'second']);
  });
});

describe('joinWords', () => {
  it('normalises spacing around punctuation', () => {
    const text = joinWords([
      { text: 'this', startMs: 0, endMs: 1 },
      { text: 'is', startMs: 1, endMs: 2 },
      { text: 'wrong', startMs: 2, endMs: 3 },
      { text: '.', startMs: 3, endMs: 4 },
    ]);
    expect(text).toBe('this is wrong.');
  });
});

describe('model naming', () => {
  it('builds the ggml file name and URL', () => {
    expect(modelFileName('base.en')).toBe('ggml-base.en.bin');
    expect(modelFileName('ggml-small.en')).toBe('ggml-small.en.bin');
    expect(modelUrl('base.en')).toMatch(/ggml-base\.en\.bin$/);
  });
});
