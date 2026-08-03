/**
 * INVARIANT: this library never writes to stdout. talkthru-mcp speaks JSON-RPC
 * over stdout; a stray console.log there corrupts the protocol and the failure
 * looks like "Claude Code can't see my sessions" with no error anywhere.
 * All logging goes to stderr.
 */

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, silent: 99 };

let current: LogLevel = (process.env.TALKTHRU_LOG as LogLevel) ?? 'info';

export function setLogLevel(level: LogLevel): void {
  current = level;
}

export function getLogLevel(): LogLevel {
  return current;
}

function emit(level: Exclude<LogLevel, 'silent'>, msg: string, extra?: unknown): void {
  if (ORDER[level] < ORDER[current]) return;
  const prefix = `[talkthru:${level}]`;
  if (extra === undefined) process.stderr.write(`${prefix} ${msg}\n`);
  else process.stderr.write(`${prefix} ${msg} ${safeJson(extra)}\n`);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
};
