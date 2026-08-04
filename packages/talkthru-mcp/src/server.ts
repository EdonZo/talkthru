#!/usr/bin/env node
/**
 * MCP server exposing Talkthru sessions to a coding agent.
 *
 * INVARIANT: stdout carries JSON-RPC and nothing else. Every diagnostic goes to
 * stderr (talkthru-core's logger already guarantees this). A stray console.log
 * here corrupts the protocol, and the symptom — "Claude Code can't see my
 * sessions" — points nowhere near the cause.
 */
import fs from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  MCP,
  deleteSession as removeSession,
  isValidSessionId,
  latestReadySession,
  listSessions,
  markdownPath,
  readJson,
  readStatus,
  resolveConfig,
  migrateLegacyHome,
  sessionDir,
  summarise,
  bundlePath,
  type TalkthruConfig,
  type SessionBundle,
  type SessionSummary,
} from 'talkthru';

export const SERVER_NAME = 'talkthru';
export const SERVER_VERSION = '0.1.0';

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string };

interface ToolResult {
  // The SDK's CallToolResult carries an index signature for protocol
  // extensions; ours must be structurally compatible with it.
  [key: string]: unknown;
  content: ContentBlock[];
  isError?: boolean;
}

function textResult(text: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function formatDuration(ms: number): string {
  const total = Math.round(ms / 1000);
  return total >= 60 ? `${Math.floor(total / 60)}m${String(total % 60).padStart(2, '0')}s` : `${total}s`;
}

function describeSummary(s: SessionSummary): string {
  const bits = [
    s.id,
    s.state,
    formatDuration(s.durationMs),
    `${s.frameCount} frames`,
    `${s.utteranceCount} utterances`,
  ];
  if (s.app) bits.splice(1, 0, s.app);
  const line = bits.join(' · ');
  return s.summary ? `${line}\n    "${s.summary}"` : line;
}

/**
 * Choose `max` items spread evenly across a list, always keeping the first and
 * last.
 *
 * Taking the first N instead — which this used to do — silently truncated long
 * sessions to their opening minute. On a real 107 s recording the caller got
 * frames 0-11 and nothing after, so every screen the user criticised in the
 * second half arrived as text with no picture.
 */
export function pickSpread<T>(items: T[], max: number): T[] {
  if (max <= 0) return [];
  if (items.length <= max) return items;
  if (max === 1) return [items[0]!];
  const out: T[] = [];
  const step = (items.length - 1) / (max - 1);
  for (let i = 0; i < max; i++) {
    const item = items[Math.round(i * step)];
    if (item !== undefined && !out.includes(item)) out.push(item);
  }
  return out;
}

/**
 * Attach keyframes as image blocks, within a hard budget.
 *
 * Frames that repeat an earlier screen share its file — sending the same JPEG
 * twice would burn context for nothing, so each distinct path is sent once.
 * When there are more frames than budget, they are sampled across the whole
 * session rather than taken from the front.
 */
async function imageBlocks(
  cfg: TalkthruConfig,
  id: string,
  bundle: SessionBundle,
  limit: number,
): Promise<{ blocks: ContentBlock[]; note: string | null }> {
  const dir = sessionDir(cfg, id);

  // One entry per distinct image, in timeline order.
  const seen = new Set<string>();
  const unique = bundle.keyframes.filter((kf) => {
    if (seen.has(kf.relPath)) return false;
    seen.add(kf.relPath);
    return true;
  });

  const chosen = pickSpread(unique, limit);
  const chosenSet = new Set(chosen.map((kf) => kf.index));
  const blocks: ContentBlock[] = [];
  const included: string[] = [];
  let bytes = 0;
  let droppedForBytes = 0;

  for (const kf of chosen) {
    let buf: Buffer;
    try {
      buf = await fs.readFile(path.join(dir, kf.relPath));
    } catch {
      continue;
    }
    if (bytes + buf.length > MCP.MAX_IMAGE_BYTES) {
      droppedForBytes++;
      continue;
    }
    bytes += buf.length;
    blocks.push({ type: 'image', data: buf.toString('base64'), mimeType: 'image/jpeg' });
    included.push(`f${String(kf.index).padStart(2, '0')}`);
  }

  const omitted = unique.length - chosenSet.size + droppedForBytes;
  const note =
    omitted > 0
      ? `Attached ${included.length} of ${unique.length} frames, sampled across the session: ` +
        `${included.join(', ')}. The rest are on disk in ${dir} — read a specific one if a ` +
        `section above needs it.`
      : null;
  return { blocks, note };
}

async function loadSession(
  cfg: TalkthruConfig,
  id: string,
  includeImages: boolean,
  maxImages: number,
): Promise<ToolResult> {
  if (!isValidSessionId(id)) {
    return textResult(`"${id}" is not a session id. Call list_sessions to see the available ones.`, true);
  }
  const status = await readStatus(cfg, id);
  if (!status) return textResult(`No session ${id}. Call list_sessions to see what exists.`, true);

  if (status.state === 'failed') {
    const reason = status.error ? `${status.error.code}: ${status.error.message}` : 'unknown error';
    const hint = status.error?.hint ? `\nHint: ${status.error.hint}` : '';
    return textResult(`Session ${id} failed to process — ${reason}${hint}`, true);
  }
  if (status.state !== 'ready') {
    return textResult(
      `Session ${id} is still ${status.state}${status.stage ? ` (${status.stage})` : ''}. Try again shortly.`,
    );
  }

  const markdown = await fs.readFile(markdownPath(cfg, id), 'utf8').catch(() => null);
  if (markdown === null) return textResult(`Session ${id} is marked ready but session.md is missing.`, true);

  const content: ContentBlock[] = [{ type: 'text', text: markdown }];
  if (includeImages) {
    const bundle = await readJson<SessionBundle>(bundlePath(cfg, id));
    if (bundle) {
      const { blocks, note } = await imageBlocks(cfg, id, bundle, maxImages);
      if (blocks.length > 0) {
        content.push({
          type: 'text',
          text: `\nThe ${blocks.length} keyframe image(s) below are in the same order as the sections above.`,
        });
        content.push(...blocks);
      }
      if (note) content.push({ type: 'text', text: note });
    }
  }
  return { content };
}

export function createServer(cfg: TalkthruConfig = resolveConfig()): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  server.registerTool(
    'get_latest_session',
    {
      title: 'Get the latest narrated session',
      description:
        'Return the most recent finished screen recording: the narration aligned to keyframes, ' +
        'the on-screen UI elements captured with each frame, and the frame images. ' +
        'This is the one to call when the user says "look at what I just recorded" or ' +
        'refers to feedback they gave out loud.',
      inputSchema: {
        include_images: z
          .boolean()
          .optional()
          .describe('Attach keyframe images (default true). Set false for the text timeline only.'),
      },
    },
    async ({ include_images }) => {
      const latest = await latestReadySession(cfg);
      if (!latest) {
        const pending = await listSessions(cfg, 5);
        if (pending.length > 0) {
          return textResult(
            `No finished sessions yet. Most recent: ${pending.map((s) => `${s.id} (${s.state})`).join(', ')}.`,
          );
        }
        return textResult(
          'No sessions recorded yet. Start the daemon with `talkthru serve --lan`, record one from the ' +
            'app, or import an existing video with `talkthru process <file.mp4>`.',
        );
      }
      return loadSession(cfg, latest.id, include_images !== false, MCP.MAX_IMAGES);
    },
  );

  server.registerTool(
    'list_sessions',
    {
      title: 'List narrated sessions',
      description:
        'List recent screen recordings, newest first, with duration, frame count and a one-line ' +
        'summary of what the person said.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(MCP.MAX_LIST_LIMIT)
          .optional()
          .describe(`How many to return (default ${MCP.DEFAULT_LIST_LIMIT}).`),
      },
    },
    async ({ limit }) => {
      const sessions = await listSessions(cfg, limit ?? MCP.DEFAULT_LIST_LIMIT);
      if (sessions.length === 0) {
        return textResult('No sessions yet. Record one, or run `talkthru process <file.mp4>`.');
      }
      const lines = sessions.map((s, i) => `${String(i + 1).padStart(2)}. ${describeSummary(s)}`);
      return textResult(`${sessions.length} session(s), newest first:\n\n${lines.join('\n')}`);
    },
  );

  server.registerTool(
    'get_session',
    {
      title: 'Get one narrated session',
      description:
        'Return a specific session by id: narration aligned to keyframes, UI context, and frame images.',
      inputSchema: {
        session_id: z.string().describe('Session id, e.g. 20260803-001500-a1b2c3.'),
        include_images: z.boolean().optional().describe('Attach keyframe images (default true).'),
        max_images: z
          .number()
          .int()
          .min(0)
          .max(MCP.MAX_IMAGES)
          .optional()
          .describe(`Cap the number of images (default ${MCP.MAX_IMAGES}).`),
      },
    },
    async ({ session_id, include_images, max_images }) =>
      loadSession(cfg, session_id, include_images !== false, max_images ?? MCP.MAX_IMAGES),
  );

  server.registerTool(
    'delete_session',
    {
      title: 'Delete a narrated session',
      description: 'Permanently delete a session and its frames from disk.',
      inputSchema: { session_id: z.string().describe('Session id to delete.') },
    },
    async ({ session_id }) => {
      if (!isValidSessionId(session_id)) return textResult(`"${session_id}" is not a session id.`, true);
      const summary = await summarise(cfg, session_id);
      const removed = await removeSession(cfg, session_id);
      if (!removed) return textResult(`No session ${session_id} to delete.`, true);
      return textResult(
        `Deleted ${session_id}${summary?.summary ? ` — "${summary.summary}"` : ''}.`,
      );
    },
  );

  return server;
}

async function main(): Promise<void> {
  const cfg = resolveConfig();
  await migrateLegacyHome(cfg);
  const server = createServer(cfg);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(`[talkthru-mcp] ready · sessions in ${cfg.sessionsDir}\n`);
}

// Only auto-start when executed directly, so tests can import createServer.
/**
 * Are we the process entry point, rather than being imported by a test?
 *
 * Compare real paths, not basenames. npm installs this as a bin shim called
 * `talkthru-mcp` that symlinks to `dist/server.js`, so comparing names meant
 * `npx talkthru-mcp` never matched and the server exited silently — the exact
 * command in the README did nothing at all.
 */
function isEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (!argv1) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().catch((e) => {
    process.stderr.write(`[talkthru-mcp] fatal: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}
