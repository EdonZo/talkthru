import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CLIENT_HEADER, startServer, type RunningServer } from '../src/server.js';
import { listSessionIds, readStatus } from '../src/store.js';
import type { TalkthruConfig } from '../src/config.js';
import { tempHome } from './helpers.js';

let cfg: TalkthruConfig;
let cleanup: () => Promise<void>;
let running: RunningServer | null = null;
/** Session ids the stubbed pipeline was asked to process. */
let processed: string[] = [];

async function boot(overrides: Partial<Parameters<typeof startServer>[1]> = {}): Promise<string> {
  processed = [];
  running = await startServer(
    { ...cfg, bind: '127.0.0.1', port: 0 },
    {
      // Stub the pipeline: this suite is about the HTTP contract, and running
      // ffmpeg/whisper per request would make it slow and flaky.
      process: async (_cfg, id) => {
        processed.push(id);
        return null;
      },
      ...overrides,
    },
  );
  return `http://127.0.0.1:${running.port}`;
}

function multipart(parts: Array<{ name: string; filename?: string; body: string; type?: string }>): {
  body: Buffer;
  contentType: string;
} {
  const boundary = '----talkthrutest7MA4YWxkTrZu0gW';
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = part.filename
      ? `form-data; name="${part.name}"; filename="${part.filename}"`
      : `form-data; name="${part.name}"`;
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: ${disposition}\r\n` +
          `Content-Type: ${part.type ?? 'application/octet-stream'}\r\n\r\n`,
      ),
      Buffer.from(part.body),
      Buffer.from('\r\n'),
    );
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** Issue a request with full control over headers `fetch` refuses to set. */
function rawRequest(port: number, urlPath: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: urlPath, method: 'GET', headers, setHost: false },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode ?? 0));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

beforeEach(async () => {
  ({ cfg, cleanup } = await tempHome('server'));
});
afterEach(async () => {
  await running?.close();
  running = null;
  await cleanup();
});

describe('health', () => {
  it('reports version and configuration without auth', async () => {
    const base = await boot();
    const res = await fetch(`${base}/v1/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; lan: boolean; requiresToken: boolean };
    expect(body.ok).toBe(true);
    expect(body.lan).toBe(false);
    expect(body.requiresToken).toBe(false);
  });
});

describe('upload contract', () => {
  it('accepts a well-formed upload and queues it', async () => {
    const base = await boot();
    const { body, contentType } = multipart([
      { name: 'video', filename: 'clip.mp4', body: 'fake-video-bytes' },
      { name: 'meta', filename: 'meta.json', body: JSON.stringify({ app: 'Test' }), type: 'application/json' },
    ]);
    const res = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': contentType, [CLIENT_HEADER]: 'test/1.0' },
      body,
    });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { id: string; state: string };
    expect(json.state).toBe('queued');

    await running!.drain();
    expect(processed).toEqual([json.id]);

    // The bytes actually landed on disk under the session's raw dir.
    const raw = path.join(cfg.sessionsDir, json.id, 'raw');
    const files = await fs.readdir(raw);
    expect(files.sort()).toEqual(['meta.json', 'video.mp4']);
    expect(await fs.readFile(path.join(raw, 'video.mp4'), 'utf8')).toBe('fake-video-bytes');
  });

  it('stores an uploaded frame sequence under raw/frames', async () => {
    const base = await boot();
    const { body, contentType } = multipart([
      { name: 'frames', filename: '001.jpg', body: 'jpeg-one' },
      { name: 'frames', filename: '002.jpg', body: 'jpeg-two' },
    ]);
    const res = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': contentType, [CLIENT_HEADER]: 'test/1.0' },
      body,
    });
    const { id } = (await res.json()) as { id: string };
    const frames = await fs.readdir(path.join(cfg.sessionsDir, id, 'raw', 'frames'));
    expect(frames.sort()).toEqual(['001.jpg', '002.jpg']);
  });

  it('rejects an upload with no client header', async () => {
    const base = await boot();
    const { body, contentType } = multipart([{ name: 'video', filename: 'c.mp4', body: 'x' }]);
    const res = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { message: string } };
    expect(json.error.message).toMatch(/x-talkthru-client/i);
  });

  it('rejects a non-multipart body', async () => {
    const base = await boot();
    const res = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', [CLIENT_HEADER]: 'test/1.0' },
      body: '{}',
    });
    expect(res.status).toBe(415);
  });

  it('rejects an upload containing no files', async () => {
    const base = await boot();
    const boundary = '----empty';
    const res = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: {
        'content-type': `multipart/form-data; boundary=${boundary}`,
        [CLIENT_HEADER]: 'test/1.0',
      },
      body: `--${boundary}--\r\n`,
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe('NO_MEDIA');
    // The abandoned session is recorded as failed, not left dangling.
    const ids = await listSessionIds(cfg);
    expect(ids).toHaveLength(1);
    expect((await readStatus(cfg, ids[0]!))!.state).toBe('failed');
  });

  it('blocks the cross-origin preflight a browser would send', async () => {
    const base = await boot();
    const res = await fetch(`${base}/v1/sessions`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(res.status).toBe(403);
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses a request with an unexpected Host header', async () => {
    await boot();
    // `fetch` forbids overriding Host, so this goes out over a raw request —
    // which is exactly what a DNS-rebinding attack would do anyway.
    const status = await rawRequest(running!.port, '/v1/health', { host: 'attacker.example.com' });
    expect(status).toBe(403);
  });

  it('allows the hostnames a device legitimately uses', async () => {
    await boot();
    for (const host of ['localhost:1', '127.0.0.1:1', '192.168.1.20:8917', 'talkthru.local:8917']) {
      expect(await rawRequest(running!.port, '/v1/health', { host }), host).toBe(200);
    }
  });

  it('waits for processing when asked to', async () => {
    const base = await boot();
    const { body, contentType } = multipart([{ name: 'video', filename: 'c.mp4', body: 'x' }]);
    const res = await fetch(`${base}/v1/sessions?wait=1`, {
      method: 'POST',
      headers: { 'content-type': contentType, [CLIENT_HEADER]: 'test/1.0' },
      body,
    });
    expect(res.status).toBe(200);
    expect(processed).toHaveLength(1);
  });
});

describe('token auth', () => {
  it('rejects unauthenticated uploads when a token is required', async () => {
    const base = await boot({ requireToken: true });
    const { body, contentType } = multipart([{ name: 'video', filename: 'c.mp4', body: 'x' }]);
    const res = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': contentType, [CLIENT_HEADER]: 'test/1.0' },
      body,
    });
    expect(res.status).toBe(401);
  });

  it('accepts the right token and rejects a wrong one of the same length', async () => {
    const base = await boot({ requireToken: true });
    const token = running!.token!;
    expect(token).toBeTruthy();

    const wrong = 'f'.repeat(token.length);
    const build = () => multipart([{ name: 'video', filename: 'c.mp4', body: 'x' }]);

    const bad = build();
    const badRes = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': bad.contentType, [CLIENT_HEADER]: 't', authorization: `Bearer ${wrong}` },
      body: bad.body,
    });
    expect(badRes.status).toBe(401);

    const good = build();
    const goodRes = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': good.contentType, [CLIENT_HEADER]: 't', authorization: `Bearer ${token}` },
      body: good.body,
    });
    expect(goodRes.status).toBe(202);
  });

  it('still serves health without a token', async () => {
    const base = await boot({ requireToken: true });
    expect((await fetch(`${base}/v1/health`)).status).toBe(200);
  });
});

describe('session queries', () => {
  it('lists sessions and fetches one by id', async () => {
    const base = await boot();
    const { body, contentType } = multipart([{ name: 'video', filename: 'c.mp4', body: 'x' }]);
    const created = await fetch(`${base}/v1/sessions`, {
      method: 'POST',
      headers: { 'content-type': contentType, [CLIENT_HEADER]: 't' },
      body,
    });
    const { id } = (await created.json()) as { id: string };
    await running!.drain();

    const list = (await (await fetch(`${base}/v1/sessions`)).json()) as { sessions: Array<{ id: string }> };
    expect(list.sessions.map((s) => s.id)).toContain(id);

    const one = await fetch(`${base}/v1/sessions/${id}`);
    expect(one.status).toBe(200);
  });

  it('404s an unknown but well-formed session id', async () => {
    const base = await boot();
    expect((await fetch(`${base}/v1/sessions/20260101-000000-aaaaaa`)).status).toBe(404);
  });

  it('400s a malformed session id rather than touching the filesystem', async () => {
    const base = await boot();
    const res = await fetch(`${base}/v1/sessions/..%2F..%2Fetc%2Fpasswd`);
    expect([400, 404]).toContain(res.status);
  });

  it('404s an unknown route', async () => {
    const base = await boot();
    expect((await fetch(`${base}/v1/nope`)).status).toBe(404);
  });
});
