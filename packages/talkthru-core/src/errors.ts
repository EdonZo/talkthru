/**
 * One error type, always carrying a machine code and — where a human can fix
 * it — an actionable hint. The daemon never dies on a TalkthruError; it records
 * it on the session and keeps serving.
 */
export class TalkthruError extends Error {
  readonly code: string;
  readonly hint?: string;
  override readonly cause?: unknown;

  constructor(code: string, message: string, opts: { hint?: string; cause?: unknown } = {}) {
    super(message);
    this.name = 'TalkthruError';
    this.code = code;
    this.hint = opts.hint;
    this.cause = opts.cause;
  }

  toJSON(): { code: string; message: string; hint?: string } {
    return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) };
  }
}

export const ErrorCodes = {
  FFMPEG_MISSING: 'FFMPEG_MISSING',
  FFPROBE_FAILED: 'FFPROBE_FAILED',
  FFMPEG_FAILED: 'FFMPEG_FAILED',
  WHISPER_MISSING: 'WHISPER_MISSING',
  WHISPER_FAILED: 'WHISPER_FAILED',
  MODEL_DOWNLOAD_FAILED: 'MODEL_DOWNLOAD_FAILED',
  NO_MEDIA: 'NO_MEDIA',
  BAD_MEDIA: 'BAD_MEDIA',
  BAD_SESSION_ID: 'BAD_SESSION_ID',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  SESSION_NOT_READY: 'SESSION_NOT_READY',
  UPLOAD_TOO_LARGE: 'UPLOAD_TOO_LARGE',
  UNAUTHORIZED: 'UNAUTHORIZED',
  BAD_REQUEST: 'BAD_REQUEST',
  PORT_IN_USE: 'PORT_IN_USE',
  /** Re-processing would replace a bundle that has narration with one that has none. */
  WOULD_LOSE_TRANSCRIPT: 'WOULD_LOSE_TRANSCRIPT',
  IO_FAILED: 'IO_FAILED',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export function isTalkthruError(e: unknown): e is TalkthruError {
  return e instanceof TalkthruError;
}

/** Normalise anything thrown into a TalkthruError so callers have one shape. */
export function toTalkthruError(e: unknown, fallbackCode: string = ErrorCodes.IO_FAILED): TalkthruError {
  if (isTalkthruError(e)) return e;
  const message = e instanceof Error ? e.message : String(e);
  return new TalkthruError(fallbackCode, message, { cause: e });
}
