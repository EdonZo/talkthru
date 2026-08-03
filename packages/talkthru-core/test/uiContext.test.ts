import { describe, expect, it } from 'vitest';
import { formatNode, normaliseSnapshots, snapshotForTime, summariseNodes } from '../src/uiContext.js';
import type { UiNode } from '../src/types.js';

describe('normaliseSnapshots', () => {
  it('accepts the canonical TalkthruKit shape', () => {
    const snaps = normaliseSnapshots({
      version: 1,
      snapshots: [
        {
          tMs: 1_000,
          screen: { width: 390, height: 844 },
          nodes: [{ type: 'button', testId: 'play', label: 'Play', rect: [10, 20, 44, 44], depth: 3 }],
        },
      ],
    });
    expect(snaps).toHaveLength(1);
    expect(snaps[0]!.nodes[0]).toMatchObject({ type: 'button', testId: 'play', rect: [10, 20, 44, 44] });
    expect(snaps[0]!.screen).toEqual({ width: 390, height: 844 });
  });

  it('accepts a bare array and alternative field names', () => {
    const snaps = normaliseSnapshots([
      {
        t: 500,
        elements: [
          { tag: 'div', accessibilityLabel: 'Card', frame: { x: 1, y: 2, width: 3, height: 4 }, identifier: 'card' },
        ],
      },
    ]);
    expect(snaps[0]!.tMs).toBe(500);
    expect(snaps[0]!.nodes[0]).toMatchObject({ type: 'div', label: 'Card', testId: 'card', rect: [1, 2, 3, 4] });
  });

  it('sorts snapshots by time', () => {
    const snaps = normaliseSnapshots([{ tMs: 900, nodes: [] }, { tMs: 100, nodes: [] }]);
    expect(snaps.map((s) => s.tMs)).toEqual([100, 900]);
  });

  it('drops malformed entries instead of throwing', () => {
    const snaps = normaliseSnapshots([
      null,
      'nope',
      { nodes: [] }, // no timestamp
      { tMs: 'abc', nodes: [] },
      { tMs: 10, nodes: [{ type: 'x' }] }, // node without a rect
      { tMs: 20, nodes: 'not-an-array' },
    ]);
    expect(snaps.map((s) => s.tMs)).toEqual([10, 20]);
    expect(snaps[0]!.nodes).toEqual([]);
  });

  it('returns an empty list for junk input', () => {
    for (const junk of [null, undefined, 42, 'x', {}]) expect(normaliseSnapshots(junk)).toEqual([]);
  });

  it('records occlusions from either field name', () => {
    expect(normaliseSnapshots([{ tMs: 0, nodes: [], occlusions: ['system alert'] }])[0]!.occlusions).toEqual([
      'system alert',
    ]);
    expect(normaliseSnapshots([{ tMs: 0, nodes: [], occluded: 'keyboard' }])[0]!.occlusions).toEqual(['keyboard']);
  });

  it('truncates absurd labels', () => {
    const snaps = normaliseSnapshots([{ tMs: 0, nodes: [{ type: 'p', label: 'x'.repeat(500), rect: [0, 0, 10, 10] }] }]);
    expect(snaps[0]!.nodes[0]!.label!.length).toBeLessThanOrEqual(48);
  });
});

describe('snapshotForTime', () => {
  const snaps = normaliseSnapshots([
    { tMs: 0, nodes: [] },
    { tMs: 10_000, nodes: [] },
  ]);

  it('returns the nearest snapshot within the skew window', () => {
    expect(snapshotForTime(snaps, 10_200)!.tMs).toBe(10_000);
    expect(snapshotForTime(snaps, 300)!.tMs).toBe(0);
  });

  it('returns null when nothing is close enough', () => {
    expect(snapshotForTime(snaps, 5_000)).toBeNull();
  });

  it('returns null when there are no snapshots', () => {
    expect(snapshotForTime([], 0)).toBeNull();
  });
});

describe('summariseNodes', () => {
  const nodes: UiNode[] = [
    { type: 'UIView', rect: [0, 0, 390, 844], depth: 1 }, // unlabelled container: noise
    { type: 'button', testId: 'play', label: 'Play', rect: [10, 400, 60, 60], depth: 4 },
    { type: 'header', label: 'AstroShort', rect: [0, 40, 390, 80], depth: 3 },
    { type: 'div', rect: [0, 0, 2, 2], depth: 5, testId: 'tiny' }, // sub-pixel: noise
    { type: 'span', label: 'Mars', rect: [20, 200, 100, 30], depth: 6 },
  ];

  it('drops unlabelled containers and sub-threshold nodes', () => {
    const out = summariseNodes(nodes);
    expect(out.map((n) => n.type)).not.toContain('UIView');
    expect(out.find((n) => n.testId === 'tiny')).toBeUndefined();
  });

  it('returns nodes in reading order, top to bottom', () => {
    const out = summariseNodes(nodes);
    const ys = out.map((n) => n.rect[1]);
    expect([...ys].sort((a, b) => a - b)).toEqual(ys);
  });

  it('prefers nodes with a stable test id when trimming', () => {
    const out = summariseNodes(nodes, 1);
    expect(out).toHaveLength(1);
    expect(out[0]!.testId).toBe('play');
  });

  it('returns nothing when asked for nothing', () => {
    expect(summariseNodes(nodes, 0)).toEqual([]);
  });
});

describe('formatNode', () => {
  it('renders the compact session.md form', () => {
    expect(
      formatNode({ type: 'button', testId: 'play', label: 'Play', rect: [10.4, 20.6, 44, 44], depth: 2 }),
    ).toBe('button#play "Play" @10,21 44x44');
  });

  it('omits missing parts', () => {
    expect(formatNode({ type: 'div', rect: [0, 0, 10, 10], depth: 1 })).toBe('div @0,0 10x10');
  });
});
