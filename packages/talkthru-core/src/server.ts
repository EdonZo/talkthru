import http from 'node:http';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import Busboy from 'busboy';
import { INGEST, BUNDLE } from './constants.js';
import { TalkthruError, ErrorCodes, toTalkthruError } from './errors.js';
import { log } from './log.js';
import {
  ensureSessionDirs,
  initStatus,
  listSessions,
  newSessionId,
  patchStatus,
  readStatus,
  safeFileName,
  sessionDir,
} from './store.js';
import { processSessionSafe, type ProcessOptions } from './pipeline.js';
import type { TalkthruConfig } from './config.js';

export const VERSION = '0.1.0';

/**
 * Header every client must send.
 *
 * SECURITY: without it, a page you visit in a browser could POST multipart to
 * 127.0.0.1:8917 as a CORS "simple request" — no preflight, no consent. A
 * custom header forces a preflight, and we answer preflights with a denial
 * unless the request carries a valid token. Native clients just set the header.
 */
export const CLIENT_HEADER = 'x-talkthru-client';

const ALLOWED_HOST_PATTERN = /^(localhost|127\.0\.0\.1|\[::1\]|[0-9.]+|[a-z0-9-]+\.local)(:\d+)?$/i;

export interface ServerOptions {
  /** Injected for tests; defaults to the real pipeline. */
  process?: (cfg: TalkthruConfig, id: string, opts: ProcessOptions) => Promise<unknown>;
  /** Called after each session finishes processing. */
  onSession?: (id: string) => void;
  /** Require a bearer token even on loopback. */
  requireToken?: boolean;
  transcriberFactory?: ProcessOptions['transcriber'];
}

export interface RunningServer {
  server: http.Server;
  port: number;
  address: string;
  token: string | null;
  close(): Promise<void>;
  /** Resolves when every queued session has finished processing. */
  drain(): Promise<void>;
}

function isLoopback(bind: string): boolean {
  return bind === '127.0.0.1' || bind === '::1' || bind === 'localhost';
}

export async function ensureToken(cfg: TalkthruConfig): Promise<string> {
  await fs.mkdir(path.dirname(cfg.tokenFile), { recursive: true });
  try {
    const existing = (await fs.readFile(cfg.tokenFile, 'utf8')).trim();
    if (existing.length >= 16) return existing;
  } catch {
    // fall through and create one
  }
  const token = crypto.randomBytes(INGEST.TOKEN_BYTES).toString('hex');
  await fs.writeFile(cfg.tokenFile, `${token}\n`, { mode: 0o600 });
  return token;
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function sendError(res: http.ServerResponse, status: number, err: TalkthruError): void {
  sendJson(res, status, { error: err.toJSON() });
}

interface UploadOutcome {
  files: string[];
  fields: Record<string, string>;
  bytes: number;
}

/** Stream a multipart body into the session's raw dir. */
async function receiveUpload(
  req: http.IncomingMessage,
  rawDir: string,
): Promise<UploadOutcome> {
  return new Promise<UploadOutcome>((resolve, reject) => {
    let bb: Busboy.Busboy;
    try {
      bb = Busboy({
        headers: req.headers,
        limits: {
          fileSize: INGEST.MAX_PART_BYTES,
          files: INGEST.MAX_FILES,
          fields: 32,
          fieldSize: 64 * 1024,
        },
      });
    } catch (e) {
      reject(new TalkthruError(ErrorCodes.BAD_REQUEST, 'Malformed multipart request', { cause: e }));
      return;
    }

    const files: string[] = [];
    const fields: Record<string, string> = {};
    let bytes = 0;
    let settled = false;
    const pending: Promise<void>[] = [];

    const fail = (err: TalkthruError) => {
      if (settled) return;
      settled = true;
      req.unpipe(bb);
      reject(err);
    };

    bb.on('field', (name, value) => {
      fields[name] = value;
    });

    bb.on('file', (name, stream, info) => {
      // Canonical field names win; otherwise fall back to the client filename.
      const canonical: Record<string, string | undefined> = {
        video: `video${path.extname(info.filename || '.mp4') || '.mp4'}`,
        audio: `audio${path.extname(info.filename || '.wav') || '.wav'}`,
        meta: 'meta.json',
        hierarchy: 'hierarchy.json',
      };
      const isFrame = name === 'frames' || name.startsWith('frames[');
      const target = isFrame
        ? path.join(rawDir, 'frames', safeFileName(info.filename || `${Date.now()}.jpg`))
        : path.join(rawDir, canonical[name] ?? safeFileName(info.filename || `${name}.bin`));

      const task = (async () => {
        await fs.mkdir(path.dirname(target), { recursive: true });
        stream.on('data', (d: Buffer) => {
          bytes += d.length;
          if (bytes > INGEST.MAX_UPLOAD_BYTES) {
            stream.destroy();
            fail(
              new TalkthruError(
                ErrorCodes.UPLOAD_TOO_LARGE,
                `Upload exceeds ${INGEST.MAX_UPLOAD_BYTES} bytes`,
                { hint: 'Record shorter sessions, or raise the cap in constants.ts.' },
              ),
            );
          }
        });
        stream.on('limit', () => {
          fail(new TalkthruError(ErrorCodes.UPLOAD_TOO_LARGE, `Part "${name}" exceeds the size limit`));
        });
        await pipeline(stream, createWriteStream(target));
        files.push(path.relative(rawDir, target));
      })();
      pending.push(
        task.catch((e) => {
          fail(toTalkthruError(e));
        }),
      );
    });

    bb.on('filesLimit', () => fail(new TalkthruError(ErrorCodes.BAD_REQUEST, 'Too many files in one upload')));
    bb.on('error', (e) => fail(toTalkthruError(e, ErrorCodes.BAD_REQUEST)));
    bb.on('close', () => {
      void Promise.all(pending).then(() => {
        if (settled) return;
        settled = true;
        resolve({ files, fields, bytes });
      });
    });

    req.on('aborted', () => fail(new TalkthruError(ErrorCodes.BAD_REQUEST, 'Client aborted the upload')));
    req.pipe(bb);
  });
}

export async function startServer(cfg: TalkthruConfig, opts: ServerOptions = {}): Promise<RunningServer> {
  const lan = !isLoopback(cfg.bind);
  const needToken = lan || opts.requireToken === true;
  const token = needToken ? await ensureToken(cfg) : null;
  const processFn = opts.process ?? ((c, id, o) => processSessionSafe(c, id, o));

  // Sessions process one at a time: whisper saturates the machine, and two
  // concurrent transcriptions are slower than two sequential ones.
  let queue: Promise<void> = Promise.resolve();
  const enqueue = (id: string): void => {
    queue = queue
      .then(() =>
        processFn(cfg, id, {
          ...(opts.transcriberFactory ? { transcriber: opts.transcriberFactory } : {}),
        }).then(() => undefined),
      )
      .catch((e) => {
        log.error('queued processing threw', { id, error: String(e) });
      })
      .then(() => {
        opts.onSession?.(id);
      });
  };

  const authorised = (req: http.IncomingMessage): boolean => {
    if (!token) return true;
    const header = req.headers.authorization ?? '';
    const provided = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    return provided.length > 0 && timingSafeEqual(provided, token);
  };

  const server = http.createServer((req, res) => {
    void handle(req, res).catch((e) => {
      const err = toTalkthruError(e);
      log.error('request failed', err.toJSON());
      if (!res.headersSent) sendError(res, 500, err);
      else res.end();
    });
  });

  async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const route = url.pathname.replace(/\/+$/, '') || '/';

    // Deny cross-origin preflights outright: no browser origin is trusted to
    // reach the daemon without an explicit token flow we have not built yet.
    if (req.method === 'OPTIONS') {
      res.writeHead(403, { 'content-length': '0' });
      res.end();
      return;
    }

    const host = req.headers.host ?? '';
    if (host && !ALLOWED_HOST_PATTERN.test(host)) {
      sendError(res, 403, new TalkthruError(ErrorCodes.UNAUTHORIZED, `Host header not allowed: ${host}`));
      return;
    }

    if (route === `${INGEST.API_PREFIX}/health` && req.method === 'GET') {
      sendJson(res, 200, {
        ok: true,
        version: VERSION,
        lan,
        requiresToken: Boolean(token),
        home: cfg.home,
      });
      return;
    }

    if (!authorised(req)) {
      sendError(
        res,
        401,
        new TalkthruError(ErrorCodes.UNAUTHORIZED, 'Missing or invalid bearer token', {
          hint: 'Run `talkthru pair` on the Mac and paste the token into the app.',
        }),
      );
      return;
    }

    if (route === `${INGEST.API_PREFIX}/sessions` && req.method === 'GET') {
      const limit = Number(url.searchParams.get('limit') ?? 20);
      sendJson(res, 200, { sessions: await listSessions(cfg, Number.isFinite(limit) ? limit : 20) });
      return;
    }

    if (route.startsWith(`${INGEST.API_PREFIX}/sessions/`) && req.method === 'GET') {
      const id = route.slice(`${INGEST.API_PREFIX}/sessions/`.length);
      try {
        const status = await readStatus(cfg, id);
        if (!status) {
          sendError(res, 404, new TalkthruError(ErrorCodes.SESSION_NOT_FOUND, `No session ${id}`));
          return;
        }
        sendJson(res, 200, status);
      } catch (e) {
        sendError(res, 400, toTalkthruError(e));
      }
      return;
    }

    if (route === `${INGEST.API_PREFIX}/sessions` && req.method === 'POST') {
      if (!req.headers[CLIENT_HEADER]) {
        sendError(
          res,
          400,
          new TalkthruError(ErrorCodes.BAD_REQUEST, `Missing ${CLIENT_HEADER} header`, {
            hint: 'Identify your client, e.g. `X-Talkthru-Client: TalkthruKit/0.1.0`. See docs/INGEST_PROTOCOL.md.',
          }),
        );
        return;
      }
      const contentType = req.headers['content-type'] ?? '';
      if (!contentType.toLowerCase().startsWith('multipart/form-data')) {
        sendError(
          res,
          415,
          new TalkthruError(ErrorCodes.BAD_REQUEST, 'Expected multipart/form-data'),
        );
        return;
      }

      const id = newSessionId();
      const dir = await ensureSessionDirs(cfg, id);
      await initStatus(cfg, id, 'ingest');
      const rawDir = path.join(dir, BUNDLE.RAW_DIR);

      let outcome: UploadOutcome;
      try {
        outcome = await receiveUpload(req, rawDir);
      } catch (e) {
        const err = toTalkthruError(e);
        await patchStatus(cfg, id, { state: 'failed', error: err.toJSON() });
        sendError(res, err.code === ErrorCodes.UPLOAD_TOO_LARGE ? 413 : 400, err);
        return;
      }

      if (outcome.files.length === 0) {
        const err = new TalkthruError(ErrorCodes.NO_MEDIA, 'Upload contained no files', {
          hint: 'Send at least one of: video, audio, frames. See docs/INGEST_PROTOCOL.md.',
        });
        await patchStatus(cfg, id, { state: 'failed', error: err.toJSON() });
        sendError(res, 400, err);
        return;
      }

      await patchStatus(cfg, id, { state: 'queued', bytesReceived: outcome.bytes });
      log.info(`received session ${id}`, { files: outcome.files, bytes: outcome.bytes });
      enqueue(id);

      if (url.searchParams.get('wait') === '1') {
        await queue;
        const status = await readStatus(cfg, id);
        sendJson(res, 200, { id, state: status?.state ?? 'unknown', warnings: status?.warnings ?? [] });
        return;
      }
      sendJson(res, 202, { id, state: 'queued', path: sessionDir(cfg, id) });
      return;
    }

    sendError(res, 404, new TalkthruError(ErrorCodes.BAD_REQUEST, `No route for ${req.method} ${route}`));
  }

  server.setTimeout(INGEST.SOCKET_TIMEOUT_MS);
  server.requestTimeout = INGEST.SOCKET_TIMEOUT_MS;

  await new Promise<void>((resolve, reject) => {
    const onError = (e: NodeJS.ErrnoException) => {
      if (e.code === 'EADDRINUSE') {
        reject(
          new TalkthruError(ErrorCodes.PORT_IN_USE, `Port ${cfg.port} is already in use`, {
            hint: 'Another `talkthru serve` is probably running. Stop it, or set TALKTHRU_PORT.',
          }),
        );
      } else {
        reject(toTalkthruError(e));
      }
    };
    server.once('error', onError);
    server.listen(cfg.port, cfg.bind, () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : cfg.port;

  return {
    server,
    port,
    address: cfg.bind,
    token,
    async close() {
      await queue.catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
    async drain() {
      await queue.catch(() => undefined);
    },
  };
}
