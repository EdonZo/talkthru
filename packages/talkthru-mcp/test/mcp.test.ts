import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = path.resolve(HERE, '..', 'dist', 'server.js');

/** Smallest bytes that still start with the JPEG magic number. */
const FAKE_JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0xff, 0xd9]);

const READY_ID = '20260803-001500-a1b2c3';
const FAILED_ID = '20260803-001600-b2c3d4';
const PENDING_ID = '20260803-001700-c3d4e5';

const SESSION_MD = `# Talkthru session ${READY_ID}
AstroShort 1.4.0 · iPhone · 42s · 2 frames · 2 utterances

## 00:00 · f00 — \`frames/f00.jpg\`
ui: header#app-header "AstroShort" @40,60 400x90
- [00:02] "the spacing at the top is wrong"

## 00:12 · f01 — \`frames/f01.jpg\`
- [00:13] "and this button should be blue"
`;

let home: string;
let client: Client;
let transport: StdioClientTransport;

async function writeSession(
  id: string,
  state: string,
  extras: { markdown?: string; error?: unknown; frames?: string[] } = {},
): Promise<void> {
  const dir = path.join(home, 'sessions', id);
  await fs.mkdir(path.join(dir, 'frames'), { recursive: true });
  await fs.writeFile(
    path.join(dir, 'status.json'),
    JSON.stringify({
      id,
      state,
      createdAt: '2026-08-03T00:15:00.000Z',
      updatedAt: '2026-08-03T00:15:30.000Z',
      warnings: [],
      source: 'ingest',
      ...(extras.error ? { error: extras.error } : {}),
    }),
  );
  if (extras.markdown) await fs.writeFile(path.join(dir, 'session.md'), extras.markdown);
  const frames = extras.frames ?? [];
  for (const name of frames) await fs.writeFile(path.join(dir, 'frames', name), FAKE_JPEG);
  if (frames.length > 0) {
    await fs.writeFile(
      path.join(dir, 'session.json'),
      JSON.stringify({
        id,
        createdAt: '2026-08-03T00:15:00.000Z',
        durationMs: 42_000,
        metadata: { app: 'AstroShort' },
        keyframes: frames.map((name, i) => ({
          index: i,
          tMs: i * 12_000,
          relPath: `frames/${name}`,
          delta: 0.4,
          width: 480,
          height: 854,
          bytes: FAKE_JPEG.length,
        })),
        timeline: [],
        transcript: { text: '', engine: 'test', coarseTiming: false },
        warnings: [],
        estimatedTokens: 120,
      }),
    );
  }
}

function textOf(result: unknown): string {
  const content = (result as { content: Array<{ type: string; text?: string }> }).content;
  return content
    .filter((c) => c.type === 'text')
    .map((c) => c.text ?? '')
    .join('\n');
}

function imagesOf(result: unknown): Array<{ data: string; mimeType: string }> {
  const content = (result as { content: Array<{ type: string; data?: string; mimeType?: string }> }).content;
  return content
    .filter((c) => c.type === 'image')
    .map((c) => ({ data: c.data ?? '', mimeType: c.mimeType ?? '' }));
}

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'talkthru-mcp-test-'));
  await fs.mkdir(path.join(home, 'sessions'), { recursive: true });
});

afterEach(async () => {
  await transport?.close().catch(() => undefined);
  await fs.rm(home, { recursive: true, force: true });
});

async function connect(): Promise<Client> {
  transport = new StdioClientTransport({
    command: process.execPath,
    args: [SERVER_ENTRY],
    env: { ...process.env, TALKTHRU_HOME: home, TALKTHRU_LOG: 'silent' } as Record<string, string>,
  });
  client = new Client({ name: 'talkthru-test-client', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('MCP handshake', () => {
  /**
   * REGRESSION: every other test here runs `node dist/server.js`, which is not
   * how anyone actually starts this. npm installs a bin shim named
   * `talkthru-mcp` that symlinks to it, and the entry-point check used to
   * compare basenames — so `npx talkthru-mcp` exited silently with no output
   * while the whole suite stayed green.
   */
  it('starts when invoked through a bin shim, not just as server.js', async () => {
    const shimDir = await fs.mkdtemp(path.join(os.tmpdir(), 'talkthru-shim-'));
    const shim = path.join(shimDir, 'talkthru-mcp');
    await fs.symlink(SERVER_ENTRY, shim);
    try {
      transport = new StdioClientTransport({
        command: process.execPath,
        args: [shim],
        env: { ...process.env, TALKTHRU_HOME: home, TALKTHRU_LOG: 'silent' } as Record<string, string>,
      });
      client = new Client({ name: 'shim-test', version: '1.0.0' });
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
    } finally {
      await fs.rm(shimDir, { recursive: true, force: true });
    }
  });

  it('completes initialize and advertises the four tools', async () => {
    const c = await connect();
    const { tools } = await c.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'delete_session',
      'get_latest_session',
      'get_session',
      'list_sessions',
    ]);
    // Descriptions matter: they are how the agent decides to call these.
    const latest = tools.find((t) => t.name === 'get_latest_session')!;
    expect(latest.description).toBeTruthy();
    expect(latest.inputSchema).toBeTruthy();
  });
});

describe('list_sessions', () => {
  it('says something useful when there is nothing yet', async () => {
    const c = await connect();
    const res = await c.callTool({ name: 'list_sessions', arguments: {} });
    expect(textOf(res)).toMatch(/no sessions/i);
  });

  it('lists sessions newest first', async () => {
    await writeSession(READY_ID, 'ready', { markdown: SESSION_MD, frames: ['f00.jpg'] });
    await writeSession(PENDING_ID, 'processing');
    const c = await connect();
    const text = textOf(await c.callTool({ name: 'list_sessions', arguments: {} }));
    const readyAt = text.indexOf(READY_ID);
    const pendingAt = text.indexOf(PENDING_ID);
    expect(pendingAt).toBeGreaterThanOrEqual(0);
    expect(pendingAt).toBeLessThan(readyAt);
  });

  it('honours the limit', async () => {
    await writeSession(READY_ID, 'ready', { markdown: SESSION_MD });
    await writeSession(PENDING_ID, 'ready', { markdown: SESSION_MD });
    const c = await connect();
    const text = textOf(await c.callTool({ name: 'list_sessions', arguments: { limit: 1 } }));
    expect(text).toContain('1 session(s)');
  });

  it('rejects an out-of-range limit', async () => {
    const c = await connect();
    const res = await c.callTool({ name: 'list_sessions', arguments: { limit: 9_999 } });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});

describe('get_latest_session', () => {
  it('returns the markdown and the keyframe images', async () => {
    await writeSession(READY_ID, 'ready', { markdown: SESSION_MD, frames: ['f00.jpg', 'f01.jpg'] });
    const c = await connect();
    const res = await c.callTool({ name: 'get_latest_session', arguments: {} });

    expect(textOf(res)).toContain('the spacing at the top is wrong');
    const images = imagesOf(res);
    expect(images).toHaveLength(2);
    expect(images[0]!.mimeType).toBe('image/jpeg');
    expect(Buffer.from(images[0]!.data, 'base64')).toEqual(FAKE_JPEG);
  });

  it('can return text only', async () => {
    await writeSession(READY_ID, 'ready', { markdown: SESSION_MD, frames: ['f00.jpg'] });
    const c = await connect();
    const res = await c.callTool({ name: 'get_latest_session', arguments: { include_images: false } });
    expect(imagesOf(res)).toHaveLength(0);
    expect(textOf(res)).toContain('Talkthru session');
  });

  it('sends a shared image only once when a screen repeats', async () => {
    // Two keyframes pointing at the same file — the "navigated back" case.
    const dir = path.join(home, 'sessions', READY_ID);
    await writeSession(READY_ID, 'ready', { markdown: SESSION_MD, frames: ['f00.jpg'] });
    const bundle = JSON.parse(await fs.readFile(path.join(dir, 'session.json'), 'utf8'));
    bundle.keyframes.push({
      index: 1,
      tMs: 30_000,
      relPath: 'frames/f00.jpg',
      delta: 0.3,
      width: 480,
      height: 854,
      bytes: 0,
      sameScreenAs: 0,
    });
    await fs.writeFile(path.join(dir, 'session.json'), JSON.stringify(bundle));

    const c = await connect();
    const res = await c.callTool({ name: 'get_latest_session', arguments: {} });
    expect(imagesOf(res)).toHaveLength(1);
  });

  it('skips sessions that are not ready and explains why', async () => {
    await writeSession(PENDING_ID, 'processing');
    const c = await connect();
    const text = textOf(await c.callTool({ name: 'get_latest_session', arguments: {} }));
    expect(text).toMatch(/no finished sessions/i);
    expect(text).toContain(PENDING_ID);
  });

  it('tells the user how to record one when there is nothing at all', async () => {
    const c = await connect();
    const text = textOf(await c.callTool({ name: 'get_latest_session', arguments: {} }));
    expect(text).toMatch(/talkthru serve|talkthru process/);
  });
});

describe('get_session', () => {
  it('fetches a session by id', async () => {
    await writeSession(READY_ID, 'ready', { markdown: SESSION_MD, frames: ['f00.jpg'] });
    const c = await connect();
    const res = await c.callTool({ name: 'get_session', arguments: { session_id: READY_ID } });
    expect(textOf(res)).toContain('and this button should be blue');
  });

  it('caps images when asked', async () => {
    await writeSession(READY_ID, 'ready', { markdown: SESSION_MD, frames: ['f00.jpg', 'f01.jpg'] });
    const c = await connect();
    const res = await c.callTool({
      name: 'get_session',
      arguments: { session_id: READY_ID, max_images: 1 },
    });
    expect(imagesOf(res)).toHaveLength(1);
    expect(textOf(res)).toMatch(/Attached 1 of 2 frames/i);
  });

  it('reports a malformed id as an error rather than touching the filesystem', async () => {
    const c = await connect();
    const res = await c.callTool({ name: 'get_session', arguments: { session_id: '../../etc/passwd' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toMatch(/not a session id/i);
  });

  it('surfaces the failure reason for a failed session', async () => {
    await writeSession(FAILED_ID, 'failed', {
      error: { code: 'BAD_MEDIA', message: 'truncated upload', hint: 'record again' },
    });
    const c = await connect();
    const res = await c.callTool({ name: 'get_session', arguments: { session_id: FAILED_ID } });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(textOf(res)).toContain('BAD_MEDIA');
    expect(textOf(res)).toContain('record again');
  });

  it('reports an unknown session', async () => {
    const c = await connect();
    const res = await c.callTool({ name: 'get_session', arguments: { session_id: '20200101-000000-zzzzzz' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});

describe('delete_session', () => {
  it('removes the session directory', async () => {
    await writeSession(READY_ID, 'ready', { markdown: SESSION_MD, frames: ['f00.jpg'] });
    const c = await connect();
    const res = await c.callTool({ name: 'delete_session', arguments: { session_id: READY_ID } });
    expect(textOf(res)).toContain('Deleted');
    await expect(fs.access(path.join(home, 'sessions', READY_ID))).rejects.toThrow();
  });

  it('errors on a session that does not exist', async () => {
    const c = await connect();
    const res = await c.callTool({ name: 'delete_session', arguments: { session_id: '20200101-000000-zzzzzz' } });
    expect((res as { isError?: boolean }).isError).toBe(true);
  });
});
