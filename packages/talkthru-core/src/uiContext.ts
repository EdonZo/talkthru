import { UI_CONTEXT } from './constants.js';
import type { UiNode, UiSnapshot } from './types.js';

/**
 * The device hierarchy file is written by a client we do not control (and a
 * future browser client will write its own). Parse defensively: anything
 * malformed is dropped, never thrown, because a bad hierarchy must not cost
 * the user their recording.
 */
export function normaliseSnapshots(raw: unknown): UiSnapshot[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray((raw as { snapshots?: unknown }).snapshots)
      ? ((raw as { snapshots: unknown[] }).snapshots)
      : [];
  const out: UiSnapshot[] = [];
  for (const item of list) {
    if (!isRecord(item)) continue;
    const tMs = toFiniteNumber(item.tMs ?? item.t ?? item.timestampMs);
    if (tMs === null) continue;
    const nodes = normaliseNodes(item.nodes ?? item.elements ?? []);
    const occlusions = toStringArray(item.occlusions ?? item.occluded);
    const screen = isRecord(item.screen)
      ? {
          width: toFiniteNumber(item.screen.width) ?? 0,
          height: toFiniteNumber(item.screen.height) ?? 0,
        }
      : undefined;
    out.push({
      tMs: Math.max(0, Math.round(tMs)),
      nodes,
      ...(occlusions.length ? { occlusions } : {}),
      ...(screen ? { screen } : {}),
    });
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

function normaliseNodes(raw: unknown): UiNode[] {
  if (!Array.isArray(raw)) return [];
  const out: UiNode[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const type = toShortString(item.type ?? item.className ?? item.tag ?? item.role);
    if (!type) continue;
    const rect = toRect(item.rect ?? item.frame ?? item.bounds);
    if (!rect) continue;
    const label = toShortString(item.label ?? item.text ?? item.accessibilityLabel ?? item.title);
    const testId = toShortString(item.testId ?? item.identifier ?? item.accessibilityIdentifier ?? item.id);
    const depth = toFiniteNumber(item.depth) ?? 0;
    const origin = item.origin === 'dom' ? 'dom' : item.origin === 'native' ? 'native' : undefined;
    out.push({
      type,
      ...(label ? { label } : {}),
      ...(testId ? { testId } : {}),
      rect,
      depth: Math.max(0, Math.round(depth)),
      ...(origin ? { origin } : {}),
    });
  }
  return out;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function toShortString(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const clean = v.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > UI_CONTEXT.MAX_LABEL_CHARS ? `${clean.slice(0, UI_CONTEXT.MAX_LABEL_CHARS - 1)}…` : clean;
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return typeof v === 'string' && v.trim() ? [v.trim()] : [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

function toRect(v: unknown): [number, number, number, number] | null {
  if (Array.isArray(v) && v.length >= 4) {
    const nums = v.slice(0, 4).map(toFiniteNumber);
    if (nums.every((n): n is number => n !== null)) return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
    return null;
  }
  if (isRecord(v)) {
    const x = toFiniteNumber(v.x);
    const y = toFiniteNumber(v.y);
    const w = toFiniteNumber(v.width ?? v.w);
    const h = toFiniteNumber(v.height ?? v.h);
    if (x !== null && y !== null && w !== null && h !== null) return [x, y, w, h];
  }
  return null;
}

/** The snapshot closest in time to `tMs`, or null if none is close enough. */
export function snapshotForTime(
  snapshots: UiSnapshot[],
  tMs: number,
  maxSkewMs = UI_CONTEXT.MAX_SNAPSHOT_SKEW_MS,
): UiSnapshot | null {
  if (snapshots.length === 0) return null;
  let best: UiSnapshot | null = null;
  let bestSkew = Number.POSITIVE_INFINITY;
  for (const snap of snapshots) {
    const skew = Math.abs(snap.tMs - tMs);
    if (skew < bestSkew) {
      best = snap;
      bestSkew = skew;
    }
  }
  return bestSkew <= maxSkewMs ? best : null;
}

/**
 * Rank and trim the hierarchy down to what is worth spending tokens on.
 *
 * Priority: nodes with a stable test id, then labelled nodes, then larger
 * ones, then shallower ones. Container views with no label and no id are the
 * first thing to go — they are pure noise to a reader trying to find a symbol.
 */
export function summariseNodes(nodes: UiNode[], max = UI_CONTEXT.MAX_NODES_PER_FRAME): UiNode[] {
  const meaningful = nodes.filter((n) => {
    const [, , w, h] = n.rect;
    if (w < UI_CONTEXT.MIN_NODE_EDGE_PX || h < UI_CONTEXT.MIN_NODE_EDGE_PX) return false;
    return Boolean(n.testId || n.label) || isInteractiveType(n.type);
  });
  const scored = meaningful.map((n) => ({ n, score: scoreNode(n) }));
  scored.sort((a, b) => b.score - a.score);
  const picked = scored.slice(0, Math.max(0, max)).map((s) => s.n);
  // Present in reading order (top to bottom, then left to right).
  return picked.sort((a, b) => a.rect[1] - b.rect[1] || a.rect[0] - b.rect[0]);
}

const INTERACTIVE = /button|link|input|switch|slider|textfield|tab|cell|menuitem|checkbox|select|a$/i;

function isInteractiveType(type: string): boolean {
  return INTERACTIVE.test(type);
}

function scoreNode(n: UiNode): number {
  const [, , w, h] = n.rect;
  const area = Math.max(0, w) * Math.max(0, h);
  let score = Math.log10(area + 10);
  if (n.testId) score += 4;
  if (n.label) score += 2;
  if (isInteractiveType(n.type)) score += 2;
  score -= n.depth * 0.15;
  return score;
}

/** Compact one node into a session.md line fragment. */
export function formatNode(n: UiNode): string {
  const [x, y, w, h] = n.rect.map((v) => Math.round(v)) as [number, number, number, number];
  const id = n.testId ? `#${n.testId}` : '';
  const label = n.label ? ` "${n.label}"` : '';
  return `${n.type}${id}${label} @${x},${y} ${w}x${h}`;
}
