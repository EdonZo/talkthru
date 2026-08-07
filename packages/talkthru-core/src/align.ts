import { ALIGN } from './constants.js';
import { summariseNodes, snapshotForTime } from './uiContext.js';
import { eventsForWindow } from './events.js';
import type { Keyframe, TimedEvent, TimelineEntry, TranscriptWord, UiSnapshot, Utterance } from './types.js';

/**
 * Split a word stream into utterances at natural pauses.
 *
 * Contract: output covers every input word exactly once, in order, and no
 * utterance is longer than `maxMs` unless it contains a single word.
 */
export function segmentUtterances(
  words: TranscriptWord[],
  pauseMs: number = ALIGN.UTTERANCE_PAUSE_MS,
  maxMs: number = ALIGN.MAX_UTTERANCE_MS,
): Utterance[] {
  const groups: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];

  for (const word of words) {
    if (current.length === 0) {
      current.push(word);
      continue;
    }
    const prev = current[current.length - 1]!;
    const gap = word.startMs - prev.endMs;
    const span = word.endMs - current[0]!.startMs;
    // A VAD region change is authoritative: real silence separated these words.
    const newRegion =
      word.segmentIndex !== undefined && prev.segmentIndex !== undefined && word.segmentIndex !== prev.segmentIndex;
    if (newRegion || gap >= pauseMs || span > maxMs) {
      groups.push(current);
      current = [word];
    } else {
      current.push(word);
    }
  }
  if (current.length > 0) groups.push(current);

  const out: Utterance[] = [];
  for (const group of groups) {
    const text = joinUtteranceText(group);
    if (text.length < ALIGN.MIN_UTTERANCE_CHARS) continue;
    out.push({
      index: out.length,
      text,
      startMs: group[0]!.startMs,
      endMs: group[group.length - 1]!.endMs,
    });
  }
  return out;
}

function joinUtteranceText(words: TranscriptWord[]): string {
  return words
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+([,.!?;:'’])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The keyframe that was on screen when an utterance began.
 *
 * Speech trails action: a person taps, sees the result, then says "that's
 * wrong". We therefore look back by SPEECH_LAG_MS so the utterance binds to the
 * frame that provoked it rather than to whatever appeared mid-sentence.
 */
export function keyframeForTime(keyframes: Keyframe[], tMs: number, lagMs: number = ALIGN.SPEECH_LAG_MS): Keyframe | null {
  if (keyframes.length === 0) return null;
  const target = Math.max(0, tMs - lagMs);
  let chosen: Keyframe | null = null;
  for (const kf of keyframes) {
    if (kf.tMs <= target) chosen = kf;
    else break;
  }
  // Speech before the first keyframe still belongs to the opening screen.
  return chosen ?? keyframes[0]!;
}

export interface AlignOptions {
  /** Audio-vs-video skew, ms. Positive = audio started after video. */
  audioOffsetMs?: number;
  lagMs?: number;
  /** Network/console activity to attach, if the client captured any. */
  events?: TimedEvent[];
}

export function buildTimeline(
  utterances: Utterance[],
  keyframes: Keyframe[],
  snapshots: UiSnapshot[] = [],
  opts: AlignOptions = {},
): TimelineEntry[] {
  const offset = opts.audioOffsetMs ?? 0;
  const events = opts.events ?? [];
  return utterances.map((u) => {
    const videoStart = Math.max(0, u.startMs + offset);
    const kf = keyframeForTime(keyframes, videoStart, opts.lagMs);
    const snapshot = kf ? snapshotForTime(snapshots, kf.tMs) : snapshotForTime(snapshots, videoStart);
    const occlusions = [...(kf?.occlusions ?? []), ...(snapshot?.occlusions ?? [])];
    return {
      utterance: u.text,
      startMs: u.startMs,
      endMs: u.endMs,
      keyframeIndex: kf ? kf.index : null,
      keyframePath: kf ? kf.relPath : null,
      uiContext: snapshot ? summariseNodes(snapshot.nodes) : [],
      occlusions: [...new Set(occlusions)],
      ...attachEvents(events, videoStart, Math.max(0, u.endMs + offset)),
    };
  });
}

/**
 * Only set `events` when there is something to say. An empty array on every
 * entry would show up in session.json for the overwhelming majority of sessions
 * that capture no events at all.
 */
function attachEvents(events: TimedEvent[], startMs: number, endMs: number): { events?: TimedEvent[] } {
  if (events.length === 0) return {};
  const picked = eventsForWindow(events, startMs, endMs);
  return picked.length > 0 ? { events: picked } : {};
}

/**
 * When there is no narration at all we still want a useful bundle: emit one
 * entry per keyframe so the agent gets an ordered visual walkthrough.
 */
export function timelineFromFramesOnly(
  keyframes: Keyframe[],
  snapshots: UiSnapshot[] = [],
  events: TimedEvent[] = [],
): TimelineEntry[] {
  return keyframes.map((kf, i) => {
    const snapshot = snapshotForTime(snapshots, kf.tMs);
    // With no narration the frame itself is the unit, so the window runs from
    // this frame to the next rather than around a sentence.
    const nextMs = keyframes[i + 1]?.tMs ?? kf.tMs;
    return {
      utterance: '',
      startMs: kf.tMs,
      endMs: kf.tMs,
      keyframeIndex: kf.index,
      keyframePath: kf.relPath,
      uiContext: snapshot ? summariseNodes(snapshot.nodes) : [],
      occlusions: [...new Set([...(kf.occlusions ?? []), ...(snapshot?.occlusions ?? [])])],
      ...attachEvents(events, kf.tMs, Math.max(kf.tMs, nextMs)),
    };
  });
}
