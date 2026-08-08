import { describe, expect, it } from 'vitest';
import { formatNode, normaliseSnapshots, snapshotForTime, summariseNodes } from '../src/uiContext.js';
import { renderMarkdown } from '../src/render.js';
import { UI_CONTEXT } from '../src/constants.js';
import type { UiNode } from '../src/types.js';

/**
 * The published contract for docs/hierarchy.md.
 *
 * Third parties write hierarchy files against that document, so every promise it
 * makes needs a test holding it in place. If you change behaviour here, change
 * the doc in the same commit — a silently-wrong spec is worse than none, because
 * someone builds a client against it.
 */

const node = (over: Partial<UiNode> = {}): UiNode => ({
  type: 'button',
  rect: [0, 0, 40, 40],
  depth: 1,
  ...over,
});

describe('doc: shape', () => {
  it('parses the canonical example verbatim', () => {
    const snaps = normaliseSnapshots({
      version: 1,
      snapshots: [
        {
          tMs: 1200,
          screen: { width: 390, height: 844 },
          occlusions: ['keyboard'],
          nodes: [
            {
              type: 'button',
              testId: 'checkout-submit',
              label: 'Place order',
              rect: [24, 680, 342, 48],
              depth: 4,
              origin: 'native',
            },
          ],
        },
      ],
    });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      tMs: 1200,
      screen: { width: 390, height: 844 },
      occlusions: ['keyboard'],
    });
    expect(snaps[0]!.nodes[0]).toEqual({
      type: 'button',
      testId: 'checkout-submit',
      label: 'Place order',
      rect: [24, 680, 342, 48],
      depth: 4,
      origin: 'native',
    });
  });

  it('accepts a bare array of snapshots', () => {
    expect(normaliseSnapshots([{ tMs: 1200, nodes: [] }])).toHaveLength(1);
  });

  it('defaults depth to 0 when omitted', () => {
    const snaps = normaliseSnapshots([{ tMs: 0, nodes: [{ type: 'div', rect: [0, 0, 10, 10] }] }]);
    expect(snaps[0]!.nodes[0]!.depth).toBe(0);
  });

  it('treats type and rect as the only required node fields', () => {
    const snaps = normaliseSnapshots([{ tMs: 0, nodes: [{ type: 'div', rect: [0, 0, 10, 10] }] }]);
    expect(snaps[0]!.nodes).toHaveLength(1);
  });
});

describe('doc: field aliases', () => {
  it.each([
    ['t', { t: 500 }],
    ['timestampMs', { timestampMs: 500 }],
  ])('accepts %s as the timestamp', (_name, extra) => {
    const snaps = normaliseSnapshots([{ ...extra, nodes: [] }]);
    expect(snaps[0]!.tMs).toBe(500);
  });

  it('accepts elements as the node list', () => {
    const snaps = normaliseSnapshots([{ tMs: 0, elements: [{ type: 'div', rect: [0, 0, 10, 10] }] }]);
    expect(snaps[0]!.nodes).toHaveLength(1);
  });

  it.each([['className'], ['tag'], ['role']])('accepts %s as the node type', (key) => {
    const snaps = normaliseSnapshots([{ tMs: 0, nodes: [{ [key]: 'widget', rect: [0, 0, 10, 10] }] }]);
    expect(snaps[0]!.nodes[0]!.type).toBe('widget');
  });

  it.each([['text'], ['accessibilityLabel'], ['title']])('accepts %s as the label', (key) => {
    const snaps = normaliseSnapshots([
      { tMs: 0, nodes: [{ type: 'div', rect: [0, 0, 10, 10], [key]: 'Hello' }] },
    ]);
    expect(snaps[0]!.nodes[0]!.label).toBe('Hello');
  });

  it.each([['identifier'], ['accessibilityIdentifier'], ['id']])('accepts %s as the test id', (key) => {
    const snaps = normaliseSnapshots([
      { tMs: 0, nodes: [{ type: 'div', rect: [0, 0, 10, 10], [key]: 'buy' }] },
    ]);
    expect(snaps[0]!.nodes[0]!.testId).toBe('buy');
  });

  it.each([['frame'], ['bounds']])('accepts %s as the rect', (key) => {
    const snaps = normaliseSnapshots([
      { tMs: 0, nodes: [{ type: 'div', [key]: { x: 1, y: 2, width: 3, height: 4 } }] },
    ]);
    expect(snaps[0]!.nodes[0]!.rect).toEqual([1, 2, 3, 4]);
  });

  it('accepts occluded as occlusions', () => {
    const snaps = normaliseSnapshots([{ tMs: 0, nodes: [], occluded: ['keyboard'] }]);
    expect(snaps[0]!.occlusions).toEqual(['keyboard']);
  });

  it('reads the exact DOM-client example from the doc', () => {
    const snaps = normaliseSnapshots([
      {
        tMs: 0,
        nodes: [
          {
            tag: 'button',
            id: 'buy',
            text: 'Buy now',
            bounds: { x: 24, y: 680, width: 342, height: 48 },
          },
        ],
      },
    ]);
    expect(snaps[0]!.nodes[0]).toMatchObject({
      type: 'button',
      testId: 'buy',
      label: 'Buy now',
      rect: [24, 680, 342, 48],
    });
  });
});

describe('doc: rect forms', () => {
  it('accepts an [x, y, w, h] array', () => {
    const snaps = normaliseSnapshots([{ tMs: 0, nodes: [{ type: 'a', rect: [1, 2, 3, 4] }] }]);
    expect(snaps[0]!.nodes[0]!.rect).toEqual([1, 2, 3, 4]);
  });

  it('accepts {x, y, width, height}', () => {
    const snaps = normaliseSnapshots([
      { tMs: 0, nodes: [{ type: 'a', rect: { x: 1, y: 2, width: 3, height: 4 } }] },
    ]);
    expect(snaps[0]!.nodes[0]!.rect).toEqual([1, 2, 3, 4]);
  });

  it('accepts the {w, h} short spelling', () => {
    const snaps = normaliseSnapshots([{ tMs: 0, nodes: [{ type: 'a', rect: { x: 1, y: 2, w: 3, h: 4 } }] }]);
    expect(snaps[0]!.nodes[0]!.rect).toEqual([1, 2, 3, 4]);
  });

  it('parses numbers that arrive as strings', () => {
    const snaps = normaliseSnapshots([{ tMs: '500', nodes: [{ type: 'a', rect: ['1', '2', '3', '4'] }] }]);
    expect(snaps[0]!.tMs).toBe(500);
    expect(snaps[0]!.nodes[0]!.rect).toEqual([1, 2, 3, 4]);
  });
});

describe('doc: failure behaviour', () => {
  it('never throws on malformed input', () => {
    for (const bad of [null, undefined, 42, 'string', {}, [], [null], [{}], { snapshots: 'no' }]) {
      expect(() => normaliseSnapshots(bad)).not.toThrow();
    }
  });

  it('drops snapshots with no numeric timestamp', () => {
    const snaps = normaliseSnapshots([{ nodes: [] }, { tMs: 'abc', nodes: [] }, { tMs: 10, nodes: [] }]);
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.tMs).toBe(10);
  });

  it('drops nodes missing a type', () => {
    const snaps = normaliseSnapshots([{ tMs: 0, nodes: [{ rect: [0, 0, 10, 10] }] }]);
    expect(snaps[0]!.nodes).toHaveLength(0);
  });

  it('drops nodes missing a usable rect', () => {
    const snaps = normaliseSnapshots([
      { tMs: 0, nodes: [{ type: 'div' }, { type: 'div', rect: [1, 2] }, { type: 'div', rect: 'nope' }] },
    ]);
    expect(snaps[0]!.nodes).toHaveLength(0);
  });

  it('keeps good nodes alongside bad ones', () => {
    const snaps = normaliseSnapshots([
      { tMs: 0, nodes: [{ type: 'div' }, { type: 'button', rect: [0, 0, 10, 10] }] },
    ]);
    expect(snaps[0]!.nodes).toHaveLength(1);
    expect(snaps[0]!.nodes[0]!.type).toBe('button');
  });

  it('ignores unknown fields instead of rejecting the node', () => {
    const snaps = normaliseSnapshots([
      { tMs: 0, custom: 'x', nodes: [{ type: 'div', rect: [0, 0, 10, 10], whatever: true }] },
    ]);
    expect(snaps[0]!.nodes).toHaveLength(1);
    expect(snaps[0]!.nodes[0]).not.toHaveProperty('whatever');
  });

  it('sorts out-of-order snapshots by time', () => {
    const snaps = normaliseSnapshots([{ tMs: 900, nodes: [] }, { tMs: 100, nodes: [] }]);
    expect(snaps.map((s) => s.tMs)).toEqual([100, 900]);
  });

  it('clamps a negative timestamp to zero rather than dropping the snapshot', () => {
    const snaps = normaliseSnapshots([{ tMs: -50, nodes: [] }]);
    expect(snaps[0]!.tMs).toBe(0);
  });
});

describe('doc: matching within 750ms', () => {
  const snaps = normaliseSnapshots([{ tMs: 1000, nodes: [] }, { tMs: 5000, nodes: [] }]);

  it('documents the skew the code actually uses', () => {
    expect(UI_CONTEXT.MAX_SNAPSHOT_SKEW_MS).toBe(750);
  });

  it('takes the closest snapshot', () => {
    expect(snapshotForTime(snaps, 1100)!.tMs).toBe(1000);
    expect(snapshotForTime(snaps, 4900)!.tMs).toBe(5000);
  });

  it('accepts a snapshot exactly at the limit', () => {
    expect(snapshotForTime(snaps, 1750)).not.toBeNull();
  });

  it('rejects one past the limit', () => {
    expect(snapshotForTime(snaps, 1751)).toBeNull();
  });

  it('returns null when there are no snapshots at all', () => {
    expect(snapshotForTime([], 0)).toBeNull();
  });
});

describe('doc: trimming and ranking', () => {
  it('documents the per-frame cap the code actually uses', () => {
    expect(UI_CONTEXT.MAX_NODES_PER_FRAME).toBe(12);
  });

  it('caps nodes at the documented maximum', () => {
    const many = Array.from({ length: 40 }, (_, i) =>
      node({ testId: `id-${i}`, rect: [0, i * 20, 100, 18] }),
    );
    expect(summariseNodes(many)).toHaveLength(UI_CONTEXT.MAX_NODES_PER_FRAME);
  });

  it('ranks a testId above a bare label', () => {
    const withId = node({ testId: 'buy', rect: [0, 0, 40, 40] });
    const withLabel = node({ label: 'Buy', rect: [0, 10, 40, 40] });
    expect(summariseNodes([withLabel, withId], 1)).toEqual([withId]);
  });

  it('keeps an interactive node with neither id nor label', () => {
    expect(summariseNodes([node({ type: 'button', label: undefined })])).toHaveLength(1);
  });

  it('drops an unlabelled container with no id', () => {
    expect(summariseNodes([node({ type: 'UIView' })])).toHaveLength(0);
  });

  it('drops nodes under the minimum edge', () => {
    expect(UI_CONTEXT.MIN_NODE_EDGE_PX).toBe(8);
    expect(summariseNodes([node({ testId: 'tiny', rect: [0, 0, 4, 40] })])).toHaveLength(0);
    expect(summariseNodes([node({ testId: 'tiny', rect: [0, 0, 40, 4] })])).toHaveLength(0);
  });

  it('prefers the shallower of two otherwise equal nodes', () => {
    const shallow = node({ testId: 'a', depth: 1, rect: [0, 0, 40, 40] });
    const deep = node({ testId: 'b', depth: 9, rect: [0, 10, 40, 40] });
    expect(summariseNodes([deep, shallow], 1)).toEqual([shallow]);
  });

  it('returns survivors in reading order, not score order', () => {
    const bottom = node({ testId: 'bottom', rect: [0, 500, 40, 40] });
    const top = node({ testId: 'top', rect: [0, 10, 40, 40] });
    expect(summariseNodes([bottom, top]).map((n) => n.testId)).toEqual(['top', 'bottom']);
  });

  it('breaks a reading-order tie left to right', () => {
    const right = node({ testId: 'right', rect: [200, 10, 40, 40] });
    const left = node({ testId: 'left', rect: [10, 10, 40, 40] });
    expect(summariseNodes([right, left]).map((n) => n.testId)).toEqual(['left', 'right']);
  });

  it('handles an empty node list', () => {
    expect(summariseNodes([])).toEqual([]);
  });
});

describe('doc: label truncation', () => {
  it('documents the limit the code actually uses', () => {
    expect(UI_CONTEXT.MAX_LABEL_CHARS).toBe(48);
  });

  it('truncates a long label', () => {
    const long = 'x'.repeat(200);
    const snaps = normaliseSnapshots([{ tMs: 0, nodes: [{ type: 'div', rect: [0, 0, 10, 10], label: long }] }]);
    expect(snaps[0]!.nodes[0]!.label!.length).toBeLessThanOrEqual(UI_CONTEXT.MAX_LABEL_CHARS);
  });

  it('leaves a short label alone', () => {
    const snaps = normaliseSnapshots([
      { tMs: 0, nodes: [{ type: 'div', rect: [0, 0, 10, 10], label: 'Place order' }] },
    ]);
    expect(snaps[0]!.nodes[0]!.label).toBe('Place order');
  });

  it('collapses whitespace so a wrapped label stays one line', () => {
    const snaps = normaliseSnapshots([
      { tMs: 0, nodes: [{ type: 'div', rect: [0, 0, 10, 10], label: '  Place\n\t order  ' }] },
    ]);
    expect(snaps[0]!.nodes[0]!.label).toBe('Place order');
  });

  it('treats a whitespace-only label as absent', () => {
    const snaps = normaliseSnapshots([{ tMs: 0, nodes: [{ type: 'div', rect: [0, 0, 10, 10], label: '   ' }] }]);
    expect(snaps[0]!.nodes[0]!.label).toBeUndefined();
  });
});

describe('doc: session.md rendering', () => {
  it('renders the line shown in the doc', () => {
    expect(
      formatNode({ type: 'button', testId: 'checkout-submit', label: 'Place order', rect: [24, 680, 342, 48], depth: 4 }),
    ).toBe('button#checkout-submit "Place order" @24,680 342x48');
  });

  it('puts the ui: line above the narration, pipe-separated', () => {
    // The exact block quoted in docs/hierarchy.md and the READMEs. If this
    // changes, those samples are wrong and a reader building a client is misled.
    const submit: UiNode = {
      type: 'button',
      testId: 'checkout-submit',
      label: 'Place order',
      rect: [24, 680, 342, 48],
      depth: 4,
    };
    const promo: UiNode = {
      type: 'input',
      testId: 'promo-code',
      label: 'Promo code',
      rect: [24, 600, 342, 44],
      depth: 4,
    };
    const md = renderMarkdown({
      id: 'test',
      durationMs: 40_000,
      metadata: {},
      keyframes: [{ index: 11, tMs: 34_000, relPath: 'frames/f11.jpg' } as never],
      timeline: [
        {
          utterance: 'this button is too small, I keep missing it',
          startMs: 39_000,
          endMs: 41_000,
          keyframeIndex: 11,
          keyframePath: 'frames/f11.jpg',
          uiContext: [promo, submit],
          occlusions: [],
        },
      ],
      warnings: [],
      transcriptEngine: 'fixture',
      coarseTiming: false,
    });

    expect(md).toContain('## 00:34 · f11 — `frames/f11.jpg`');
    expect(md).toContain(
      'ui: input#promo-code "Promo code" @24,600 342x44 | button#checkout-submit "Place order" @24,680 342x48',
    );
    // Order matters: the elements are context for the sentence that follows.
    const uiAt = md.indexOf('ui: input#promo-code');
    const saidAt = md.indexOf('- [00:39]');
    expect(uiAt).toBeGreaterThan(-1);
    expect(saidAt).toBeGreaterThan(uiAt);
  });

  it('omits the ui: line entirely when there is no hierarchy', () => {
    const md = renderMarkdown({
      id: 'test',
      durationMs: 1000,
      metadata: {},
      keyframes: [{ index: 1, tMs: 0, relPath: 'frames/f01.jpg' } as never],
      timeline: [
        {
          utterance: 'hello',
          startMs: 0,
          endMs: 500,
          keyframeIndex: 1,
          keyframePath: 'frames/f01.jpg',
          uiContext: [],
          occlusions: [],
        },
      ],
      warnings: [],
      transcriptEngine: 'fixture',
      coarseTiming: false,
    });
    expect(md).not.toMatch(/^ui: /m);
  });

  it('omits the id and label when absent', () => {
    expect(formatNode({ type: 'div', rect: [0, 0, 10, 10], depth: 0 })).toBe('div @0,0 10x10');
  });

  it('rounds fractional coordinates', () => {
    expect(formatNode({ type: 'div', rect: [1.4, 2.6, 3.5, 4.4], depth: 0 })).toBe('div @1,3 4x4');
  });
});
