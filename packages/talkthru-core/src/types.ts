import type { SESSION_STATES, PIPELINE_STAGES } from './constants.js';

export type SessionState = (typeof SESSION_STATES)[number];
export type PipelineStage = (typeof PIPELINE_STAGES)[number];

/** A single word (or whisper token) with its timing, ms from session start. */
export interface TranscriptWord {
  text: string;
  startMs: number;
  endMs: number;
  /** whisper token probability, 0..1, when the backend reports one. */
  confidence?: number;
  /**
   * Index of the VAD speech region this word came from. A change in this value
   * forces an utterance break, which is more reliable than inferring the pause
   * from timestamps whisper may have compressed.
   */
  segmentIndex?: number;
}

/** Contiguous speech between pauses. */
export interface Utterance {
  index: number;
  text: string;
  startMs: number;
  endMs: number;
}

export interface Transcript {
  words: TranscriptWord[];
  /** Whole-transcript text, whitespace-normalised. */
  text: string;
  language?: string;
  /** Which backend produced this (`whisper.cpp:base.en`, `none`, `fixture`). */
  engine: string;
  /** True when only segment-level (not word-level) timings were available. */
  coarseTiming: boolean;
}

export interface Keyframe {
  index: number;
  /** Presentation time within the recording, ms. */
  tMs: number;
  /** Path relative to the session dir, e.g. `frames/f03.jpg`. */
  relPath: string;
  /** Perceptual delta vs the previously kept frame, 0..1. First frame = 1. */
  delta: number;
  width: number;
  height: number;
  /** 0 when this frame reuses an earlier image (see `sameScreenAs`). */
  bytes: number;
  /**
   * Index of an earlier keyframe showing the same screen. The frame still
   * occupies its own slot in the timeline (the user navigated back and may be
   * talking about it now) but shares that frame's image file.
   */
  sameScreenAs?: number;
  /** Set when the device flagged the frame as unable to capture some region. */
  occlusions?: string[];
}

/** One node of the captured UI tree, coordinates in points, screen space. */
export interface UiNode {
  /** Class/type name (`RCTView`, `UIButton`, `div#play.btn`). */
  type: string;
  /** Accessibility label / identifier / text content, whichever exists. */
  label?: string;
  /** Stable test id when the app provides one (`data-testid`, a11y identifier). */
  testId?: string;
  /** [x, y, width, height] in screen points. */
  rect: [number, number, number, number];
  /** Depth in the tree; 0 = window. */
  depth: number;
  /** `native` (UIKit/SwiftUI) or `dom` (bridged out of a web view). */
  origin?: 'native' | 'dom';
}

/** UI tree captured at a moment in time. */
export interface UiSnapshot {
  tMs: number;
  nodes: UiNode[];
  /** Regions the capture could not see, e.g. `system alert`, `keyboard`. */
  occlusions?: string[];
  /** Logical screen size in points, for coordinate sanity. */
  screen?: { width: number; height: number };
}

/** What the device (or a browser client) uploads alongside the media. */
export interface SessionMetadata {
  app?: string;
  appVersion?: string;
  device?: string;
  os?: string;
  /** Logical screen size in points. */
  screen?: { width: number; height: number; scale?: number };
  /** Recording start, epoch ms — used only for display. */
  startedAt?: number;
  /**
   * Offset of the audio track relative to the video track, ms. Positive means
   * audio starts later than video. Devices that start the mic after the first
   * frame must report this or narration lands on the wrong frame.
   */
  audioOffsetMs?: number;
  /** Free-form note typed by the human before uploading. */
  note?: string;
  /** SDK that produced the bundle, e.g. `TalkthruKit/0.1.0`. */
  client?: string;
  [key: string]: unknown;
}

/**
 * A network call or console line, timestamped against the recording.
 *
 * Headers and bodies are deliberately not part of this shape. Auth tokens live
 * in headers, and the promise talkthru makes is that your data stays on your
 * machine — which stops being true the moment the agent reads it and hands it
 * to a model. Method, URL, status and duration answer "which call broke"
 * without carrying a credential along with the answer.
 */
export interface TimedEvent {
  /** Milliseconds from the start of the recording. */
  tMs: number;
  kind: 'network' | 'console';
  /** network: HTTP method, uppercased. */
  method?: string;
  /** network: URL with secret-looking query values redacted. */
  url?: string;
  /** network: HTTP status. 0 means the request never completed. */
  status?: number;
  /** network: wall time of the request, ms. */
  durationMs?: number;
  /** console: `error` | `warn` | `info` | `log` | `debug`. */
  level?: string;
  /** console: the message, truncated. */
  text?: string;
}

/** One `{utterance, timestamp, keyframe, ui_context}` tuple — the core product. */
export interface TimelineEntry {
  utterance: string;
  startMs: number;
  endMs: number;
  keyframeIndex: number | null;
  keyframePath: string | null;
  uiContext: UiNode[];
  occlusions: string[];
  /** Notable network/console activity around this utterance. */
  events?: TimedEvent[];
}

export interface SessionStatus {
  id: string;
  state: SessionState;
  stage?: PipelineStage;
  createdAt: string;
  updatedAt: string;
  /** Populated when state === 'failed'. */
  error?: { code: string; message: string; hint?: string };
  /** Non-fatal problems that degraded the bundle (e.g. no audio track). */
  warnings: string[];
  source: 'ingest' | 'local';
  bytesReceived?: number;
  /** Where the watcher moved the original after successful processing. */
  archivedTo?: string;
  /**
   * Set once raw media has been reclaimed. The receipt is what lets
   * `talkthru list` say "compacted (saved 212 MB)" instead of the session
   * silently shrinking — the user should see what was traded away.
   */
  compacted?: {
    at: string;
    freedBytes: number;
    /** Names of the files that were removed, for the receipt. */
    removed: string[];
  };
}

export interface SessionSummary {
  id: string;
  state: SessionState;
  createdAt: string;
  durationMs: number;
  frameCount: number;
  utteranceCount: number;
  /** First ~90 chars of narration; the "what was this about" line. */
  summary: string;
  warnings: string[];
  app?: string;
}

/** The full machine-readable bundle written as session.json. */
export interface SessionBundle {
  id: string;
  createdAt: string;
  durationMs: number;
  metadata: SessionMetadata;
  keyframes: Keyframe[];
  timeline: TimelineEntry[];
  transcript: { text: string; engine: string; coarseTiming: boolean; language?: string };
  warnings: string[];
  /** Estimated token cost of session.md, for budgeting. */
  estimatedTokens: number;
}

export interface MediaInfo {
  path: string;
  durationMs: number;
  hasVideo: boolean;
  hasAudio: boolean;
  width: number;
  height: number;
  fps: number;
}

/** Pluggable so tests (and CI) never need whisper.cpp installed. */
export interface Transcriber {
  readonly name: string;
  /** Must resolve even for silence — an empty word list is a valid result. */
  transcribe(wavPath: string, signal?: AbortSignal): Promise<Transcript>;
  /** Cheap check used by `talkthru doctor` and by the pipeline before running. */
  available(): Promise<{ ok: boolean; detail: string }>;
}
