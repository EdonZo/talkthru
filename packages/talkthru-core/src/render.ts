import { BUNDLE, UI_CONTEXT } from './constants.js';
import { formatNode } from './uiContext.js';
import { formatEvent, summariseEvents } from './events.js';
import type { Keyframe, SessionMetadata, TimedEvent, TimelineEntry, UiNode } from './types.js';

export function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / BUNDLE.CHARS_PER_TOKEN);
}

export interface RenderInput {
  id: string;
  durationMs: number;
  metadata: SessionMetadata;
  keyframes: Keyframe[];
  timeline: TimelineEntry[];
  warnings: string[];
  transcriptEngine: string;
  coarseTiming: boolean;
  /**
   * Every event captured, not just the notable ones attached to the timeline.
   * The header tally is drawn from this so a clean run reads as "nothing broke"
   * rather than "nothing was recorded". Optional: sessions predating event
   * capture, and every client that never writes an events.json, omit it.
   */
  capturedEvents?: TimedEvent[];
}

interface RenderOptions {
  /** Max UI nodes printed per frame. Reduced automatically to hit the budget. */
  maxNodes?: number;
  /** Include frames that carry no narration. */
  includeSilentFrames?: boolean;
}

/**
 * Render the agent-facing bundle.
 *
 * Grouped by keyframe rather than by utterance: several sentences usually
 * describe the same screen, and repeating the UI context per sentence is the
 * single biggest token sink in this file. session.json keeps the flat
 * per-utterance tuples for programmatic consumers.
 */
export function renderMarkdown(input: RenderInput, opts: RenderOptions = {}): string {
  const maxNodes = opts.maxNodes ?? UI_CONTEXT.MAX_NODES_PER_FRAME;
  const includeSilent = opts.includeSilentFrames ?? true;
  const lines: string[] = [];

  lines.push(`# Talkthru session ${input.id}`);
  lines.push(describeSession(input));
  lines.push('');
  // The `net:` sentence only appears when there is something to explain, so a
  // session that captured no events renders byte-identically to before event
  // support existed.
  const hasEvents = (input.capturedEvents?.length ?? 0) > 0;
  lines.push(
    'Frames are JPEGs beside this file. `ui:` lines list on-screen elements ' +
      '(`Type#testId "label" @x,y WxH`, screen points) captured with the frame.' +
      (hasEvents ? ' `net:` lines are network calls and console output from around that moment.' : ''),
  );
  if (input.coarseTiming) {
    lines.push('Timing is sentence-level, not word-level: narration may lag its frame by a second.');
  }
  lines.push('');

  const groups = groupByKeyframe(input.timeline, input.keyframes);
  const spoken = groups.filter((g) => g.entries.some((e) => e.utterance.trim() !== ''));
  const shown = includeSilent ? groups : spoken;

  if (shown.length === 0) {
    lines.push('_No narration and no frames were recovered from this session._');
  }

  for (const group of shown) {
    const kf = group.keyframe;
    const repeat =
      kf?.sameScreenAs !== undefined ? ` (back on the f${String(kf.sameScreenAs).padStart(2, '0')} screen)` : '';
    const heading = kf
      ? `## ${formatTimestamp(kf.tMs)} · f${String(kf.index).padStart(2, '0')} — \`${kf.relPath}\`${repeat}`
      : `## ${formatTimestamp(group.entries[0]?.startMs ?? 0)} · (no frame)`;
    lines.push(heading);

    const occlusions = [...new Set(group.entries.flatMap((e) => e.occlusions))];
    if (occlusions.length > 0) {
      lines.push(`occluded: ${occlusions.join(', ')} — not visible in this frame`);
    }

    const ui = pickNodes(group.entries, maxNodes);
    if (ui.length > 0) {
      lines.push(`ui: ${ui.map(formatNode).join(' | ')}`);
    }

    for (const ev of pickEvents(group.entries)) {
      lines.push(`net: ${formatEvent(ev)}`);
    }

    for (const entry of group.entries) {
      const text = entry.utterance.trim();
      if (text === '') continue;
      lines.push(`- [${formatTimestamp(entry.startMs)}] "${text}"`);
    }
    lines.push('');
  }

  if (input.warnings.length > 0) {
    lines.push('## Warnings');
    for (const w of input.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()}\n`;
}

function describeSession(input: RenderInput): string {
  const meta = input.metadata ?? {};
  const bits: string[] = [];
  const app = [meta.app, meta.appVersion].filter(Boolean).join(' ');
  if (app) bits.push(app);
  const device = [meta.device, meta.os].filter(Boolean).join(' / ');
  if (device) bits.push(device);
  bits.push(`${(input.durationMs / 1000).toFixed(0)}s`);
  bits.push(`${input.keyframes.length} frames`);
  const utterances = input.timeline.filter((e) => e.utterance.trim() !== '').length;
  bits.push(`${utterances} utterances`);
  // Say what was captured even when nothing notable surfaced below, so a quiet
  // timeline reads as "nothing broke" rather than "nothing was recorded".
  const events = summariseEvents(input.capturedEvents ?? []);
  if (events) bits.push(events);
  if (meta.note) bits.push(`note: ${String(meta.note).slice(0, 120)}`);
  return bits.join(' · ');
}

interface FrameGroup {
  keyframe: Keyframe | null;
  entries: TimelineEntry[];
}

/** One section per keyframe, in time order, including frames nobody narrated. */
export function groupByKeyframe(timeline: TimelineEntry[], keyframes: Keyframe[]): FrameGroup[] {
  const byIndex = new Map<number, FrameGroup>();
  for (const kf of keyframes) byIndex.set(kf.index, { keyframe: kf, entries: [] });

  const orphans: TimelineEntry[] = [];
  for (const entry of timeline) {
    if (entry.keyframeIndex === null) {
      orphans.push(entry);
      continue;
    }
    const group = byIndex.get(entry.keyframeIndex);
    if (group) group.entries.push(entry);
    else orphans.push(entry);
  }

  const groups = [...byIndex.values()].sort((a, b) => (a.keyframe?.tMs ?? 0) - (b.keyframe?.tMs ?? 0));
  if (orphans.length > 0) groups.unshift({ keyframe: null, entries: orphans });
  return groups;
}

function pickNodes(entries: TimelineEntry[], max: number): UiNode[] {
  if (max <= 0) return [];
  const seen = new Set<string>();
  const out: UiNode[] = [];
  for (const entry of entries) {
    for (const node of entry.uiContext) {
      const key = `${node.type}|${node.testId ?? ''}|${node.label ?? ''}|${node.rect.join(',')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(node);
      if (out.length >= max) return out;
    }
  }
  return out;
}

/**
 * Events for a frame group, deduped. Entries in a group overlap in time, so the
 * same failed request is routinely attached to several of them.
 */
function pickEvents(entries: TimelineEntry[]): TimedEvent[] {
  const seen = new Set<string>();
  const out: TimedEvent[] = [];
  for (const entry of entries) {
    for (const ev of entry.events ?? []) {
      const key = `${ev.tMs}|${ev.kind}|${ev.url ?? ''}|${ev.text ?? ''}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(ev);
    }
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

/**
 * Render, then shrink until the bundle fits the soft budget. Narration is never
 * dropped — only UI context, which is the expendable part.
 */
export function renderWithinBudget(
  input: RenderInput,
  targetChars = BUNDLE.TARGET_CHARS,
): { markdown: string; estimatedTokens: number; trimmed: boolean } {
  const ladder = [UI_CONTEXT.MAX_NODES_PER_FRAME, 8, 5, 3, 1, 0];
  let markdown = renderMarkdown(input, { maxNodes: ladder[0]! });
  let trimmed = false;
  for (let i = 1; i < ladder.length && markdown.length > targetChars; i++) {
    markdown = renderMarkdown(input, { maxNodes: ladder[i]! });
    trimmed = true;
  }
  if (markdown.length > targetChars) {
    markdown = renderMarkdown(input, { maxNodes: 0, includeSilentFrames: false });
    trimmed = true;
  }
  return { markdown, estimatedTokens: estimateTokens(markdown), trimmed };
}
