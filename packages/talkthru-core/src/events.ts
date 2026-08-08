import { EVENTS } from './constants.js';
import type { TimedEvent } from './types.js';

/**
 * Network calls and console lines, aligned to the recording the same way
 * narration is.
 *
 * Written by a client we do not control, so parse defensively exactly as the UI
 * hierarchy does: anything malformed is dropped, never thrown. A broken sidecar
 * must not cost the user their recording.
 */

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function toFiniteNumber(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
}

function toText(v: unknown, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const clean = v.replace(/\s+/g, ' ').trim();
  if (!clean) return undefined;
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/**
 * Replace secret-looking query values, and drop any user:pass in the authority.
 *
 * A URL is the one field here that routinely smuggles a credential —
 * `?access_token=…` is everywhere. The parameter *names* are kept because they
 * are diagnostic; only the values go.
 *
 * Falls back to a conservative string scrub when the URL will not parse, which
 * covers relative paths and the malformed URLs real clients emit.
 */
export function redactUrl(raw: string): string {
  const scrubQueryString = (qs: string): string =>
    qs
      .split('&')
      .map((pair) => {
        const eq = pair.indexOf('=');
        if (eq === -1) return pair;
        const key = pair.slice(0, eq);
        return EVENTS.SECRET_PARAM.test(key) ? `${key}=${EVENTS.REDACTED}` : pair;
      })
      .join('&');

  try {
    const u = new URL(raw);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    for (const key of [...u.searchParams.keys()]) {
      if (EVENTS.SECRET_PARAM.test(key)) u.searchParams.set(key, EVENTS.REDACTED);
    }
    // Fragments carry tokens in OAuth implicit flows.
    if (u.hash && EVENTS.SECRET_PARAM.test(u.hash)) u.hash = `#${EVENTS.REDACTED}`;
    return u.toString();
  } catch {
    const q = raw.indexOf('?');
    if (q === -1) return raw;
    return `${raw.slice(0, q)}?${scrubQueryString(raw.slice(q + 1))}`;
  }
}

/** Normalise one raw entry, or null if it carries nothing usable. */
function normaliseEvent(item: unknown): TimedEvent | null {
  if (!isRecord(item)) return null;
  const tMs = toFiniteNumber(item.tMs ?? item.t ?? item.timestampMs ?? item.time);
  if (tMs === null) return null;

  const rawKind = typeof item.kind === 'string' ? item.kind : typeof item.type === 'string' ? item.type : '';
  const url = toText(item.url ?? item.uri ?? item.request, EVENTS.MAX_URL_CHARS);
  const level = toText(item.level ?? item.severity, 16)?.toLowerCase();
  const text = toText(item.text ?? item.message ?? item.msg, EVENTS.MAX_TEXT_CHARS);

  // Trust an explicit kind; otherwise infer from which fields showed up. A
  // client that emits {url, status} clearly means a request.
  const kind: TimedEvent['kind'] =
    /network|xhr|fetch|request|http/i.test(rawKind) || (rawKind === '' && url !== undefined)
      ? 'network'
      : /console|log/i.test(rawKind) || (rawKind === '' && text !== undefined)
        ? 'console'
        : url !== undefined
          ? 'network'
          : 'console';

  const base = { tMs: Math.max(0, Math.round(tMs)), kind } as TimedEvent;

  if (kind === 'network') {
    if (url === undefined) return null; // a request with no URL says nothing
    const method = toText(item.method ?? item.verb, 12)?.toUpperCase();
    const status = toFiniteNumber(item.status ?? item.statusCode ?? item.responseCode);
    const durationMs = toFiniteNumber(item.durationMs ?? item.duration ?? item.elapsedMs);
    return {
      ...base,
      url: redactUrl(url),
      ...(method ? { method } : {}),
      ...(status !== null ? { status: Math.round(status) } : {}),
      ...(durationMs !== null && durationMs >= 0 ? { durationMs: Math.round(durationMs) } : {}),
    };
  }

  if (text === undefined) return null; // a console line with no message says nothing
  return { ...base, text, ...(level ? { level } : {}) };
}

/**
 * Parse a whole events sidecar. Accepts `{events: [...]}`, `{entries: [...]}`
 * or a bare array, matching the latitude the hierarchy parser gives clients.
 */
export function normaliseEvents(raw: unknown): TimedEvent[] {
  const list = Array.isArray(raw)
    ? raw
    : isRecord(raw) && Array.isArray(raw.events)
      ? raw.events
      : isRecord(raw) && Array.isArray(raw.entries)
        ? raw.entries
        : [];
  const out: TimedEvent[] = [];
  for (const item of list) {
    const ev = normaliseEvent(item);
    if (ev) out.push(ev);
  }
  return out.sort((a, b) => a.tMs - b.tMs);
}

/**
 * Is this worth spending the agent's context on by default?
 *
 * A failed request or an error line is evidence. A 200 on a polling endpoint is
 * not, and there are hundreds of those. Everything is still on disk either way.
 */
export function isNotable(ev: TimedEvent): boolean {
  if (ev.kind === 'network') {
    if (ev.status === undefined) return false;
    return ev.status === 0 || ev.status >= EVENTS.NOTABLE_STATUS_MIN;
  }
  return ev.level !== undefined && EVENTS.NOTABLE_LEVELS.includes(ev.level);
}

export interface EventWindowOptions {
  /** Include everything in the window, not just notable events. */
  includeAll?: boolean;
  /** Max events returned. */
  max?: number;
  /** How far before `startMs` to look. */
  lookbehindMs?: number;
}

/**
 * The events belonging to an utterance spanning [startMs, endMs].
 *
 * The window reaches backwards because the causal order is always the same: the
 * thing goes wrong, and then you say something about it.
 */
export function eventsForWindow(
  events: TimedEvent[],
  startMs: number,
  endMs: number,
  opts: EventWindowOptions = {},
): TimedEvent[] {
  if (events.length === 0) return [];
  const lookbehind = opts.lookbehindMs ?? EVENTS.LOOKBEHIND_MS;
  const max = opts.max ?? EVENTS.MAX_PER_ENTRY;
  if (max <= 0) return [];
  const from = Math.max(0, startMs - lookbehind);
  const to = Math.max(from, endMs);

  const inWindow = events.filter((e) => e.tMs >= from && e.tMs <= to);
  const eligible = opts.includeAll ? inWindow : inWindow.filter(isNotable);
  if (eligible.length <= max) return eligible;

  // Over budget: keep the ones closest to what was said. Truncating the tail
  // would drop the event that fired *while* the user was complaining.
  const mid = (startMs + endMs) / 2;
  return [...eligible]
    .sort((a, b) => Math.abs(a.tMs - mid) - Math.abs(b.tMs - mid))
    .slice(0, max)
    .sort((a, b) => a.tMs - b.tMs);
}

/** One-line rendering for session.md. */
export function formatEvent(ev: TimedEvent): string {
  if (ev.kind === 'network') {
    const method = ev.method ?? 'GET';
    const status = ev.status === undefined ? '' : ev.status === 0 ? ' failed' : ` ${ev.status}`;
    const dur = ev.durationMs === undefined ? '' : ` ${ev.durationMs}ms`;
    return `${method} ${ev.url ?? ''}${status}${dur}`.trim();
  }
  const level = ev.level ? `${ev.level}: ` : '';
  return `${level}${ev.text ?? ''}`.trim();
}

/**
 * A short tally for the session header, so the agent knows a quiet timeline is
 * quiet because nothing broke — not because nothing was captured.
 */
export function summariseEvents(events: TimedEvent[]): string | null {
  if (events.length === 0) return null;
  const net = events.filter((e) => e.kind === 'network');
  const failed = net.filter((e) => e.status !== undefined && (e.status === 0 || e.status >= EVENTS.NOTABLE_STATUS_MIN));
  const console_ = events.filter((e) => e.kind === 'console');
  const errors = console_.filter((e) => e.level !== undefined && EVENTS.NOTABLE_LEVELS.includes(e.level));

  const parts: string[] = [];
  if (net.length > 0) {
    parts.push(`${net.length} request${net.length === 1 ? '' : 's'} (${failed.length} failed)`);
  }
  if (console_.length > 0) {
    parts.push(`${console_.length} console line${console_.length === 1 ? '' : 's'} (${errors.length} error/warn)`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}
