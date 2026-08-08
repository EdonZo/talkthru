#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveConfig, type TalkthruConfig } from './config.js';
import { INGEST, WATCH } from './constants.js';
import {
  defaultArchiveDir,
  defaultPattern,
  defaultWatchDir,
  watchDirectory,
  SCREEN_RECORDING_PATTERN,
} from './watch.js';
import { isTalkthruError, toTalkthruError } from './errors.js';
import { setLogLevel, type LogLevel } from './log.js';
import { processSession } from './pipeline.js';
import { importMedia } from './import.js';
import { startServer, ensureToken, VERSION, CLIENT_HEADER } from './server.js';
import { advertise } from './bonjour.js';
import { formatDoctor, lanAddresses, runDoctor } from './doctor.js';
import {
  deleteSession,
  migrateLegacyHome,
  isValidSessionId,
  latestReadySession,
  listSessions,
  markdownPath,
  pruneSessions,
  sessionBytes,
  sessionDir,
  summarise,
} from './store.js';

interface Args {
  command: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

function parseArgs(argv: string[]): Args {
  const [command = 'help', ...rest] = argv;
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith('--')) {
      const [name, inline] = token.slice(2).split('=', 2);
      if (!name) continue;
      if (inline !== undefined) flags.set(name, inline);
      else {
        const next = rest[i + 1];
        if (next !== undefined && !next.startsWith('--')) {
          flags.set(name, next);
          i++;
        } else flags.set(name, true);
      }
    } else positionals.push(token);
  }
  return { command, positionals, flags };
}

function flagNumber(args: Args, name: string, fallback: number): number {
  const raw = args.flags.get(name);
  if (raw === undefined || raw === true) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function out(line = ''): void {
  process.stdout.write(`${line}\n`);
}

const HELP = `talkthru ${VERSION} — narrated screen recordings, aligned for coding agents.

Usage
  talkthru serve [--lan] [--port N] [--no-bonjour] [--token]
      Run the ingest daemon. Loopback only unless --lan.

  talkthru process <file.mp4> [audio.wav] [--hierarchy h.json] [--no-audio]
  talkthru process <session-id>
      Build a bundle from local files, or re-process an existing session.
      An events.json beside the media adds network/console context; see
      docs/events.md and docs/hierarchy.md for both sidecar formats.

  talkthru watch                       watch ~/Downloads, SCREEN RECORDINGS ONLY
  talkthru watch <dir>                 watch <dir>, ANY video file
      Processes each recording, then moves the original to ~/.talkthru/archive.
      Waits for the file to stop growing, so an in-flight AirDrop is safe.
      In the default (~/Downloads) mode only files named like a screen
      recording are touched — RPReplay_*, ScreenRecording*, Screen Recording*.
      Everything else in the folder is ignored entirely.
        --any                  accept any video, even in ~/Downloads
        --screen-recordings    apply the name filter to a custom folder too
        --pattern <regex>      use your own name filter
        --existing             also process files already in the folder
        --archive <dir>        where originals are moved (default ~/.talkthru/archive)

  talkthru list [--limit N] [--json]
  talkthru show [<session-id>|latest] [--json]
  talkthru path [<session-id>|latest]
  talkthru delete <session-id>
  talkthru prune [--keep N] [--days N] [--dry-run]
  talkthru pair
      Print the token and URLs a device needs.
  talkthru doctor [--fix]

Environment
  TALKTHRU_HOME    state dir (default ~/.talkthru)
  TALKTHRU_PORT    ingest port (default ${INGEST.PORT})
  TALKTHRU_MODEL   whisper model (default small.en; base.en is faster/less accurate)
  TALKTHRU_LOG     debug|info|warn|error|silent
`;

async function resolveId(cfg: TalkthruConfig, given: string | undefined): Promise<string> {
  if (!given || given === 'latest') {
    const latest = await latestReadySession(cfg);
    if (!latest) throw new Error('No ready sessions yet.');
    return latest.id;
  }
  if (!isValidSessionId(given)) throw new Error(`Not a session id: ${given}`);
  return given;
}

async function cmdServe(cfg: TalkthruConfig, args: Args): Promise<void> {
  const lan = args.flags.get('lan') === true || args.flags.get('lan') === 'true';
  const port = flagNumber(args, 'port', cfg.port);
  const effective: TalkthruConfig = {
    ...cfg,
    port,
    bind: lan ? INGEST.BIND_ALL : cfg.bind,
  };
  const running = await startServer(effective, {
    requireToken: args.flags.get('token') === true,
    onSession: (id) => out(`  processed ${id}`),
  });
  out(`talkthru ${VERSION} listening on http://${lan ? '0.0.0.0' : effective.bind}:${running.port}`);
  out(`  state: ${cfg.home}`);
  if (running.token) {
    out(`  token: ${running.token}`);
    out(`  urls:  ${lanAddresses().map((ip) => `http://${ip}:${running.port}`).join('  ') || '(no LAN address)'}`);
  } else {
    out('  loopback only — pass --lan to accept uploads from a device');
  }

  const ad = lan && args.flags.get('no-bonjour') !== true ? advertise(running.port) : null;
  if (ad && ad.transport !== 'none') out(`  advertising as ${INGEST.BONJOUR_NAME}.${INGEST.BONJOUR_TYPE} via ${ad.transport}`);

  const shutdown = async (): Promise<void> => {
    out('\nshutting down…');
    ad?.stop();
    await running.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
  await new Promise<never>(() => {});
}

async function cmdProcess(cfg: TalkthruConfig, args: Args): Promise<void> {
  const [first, ...others] = args.positionals;
  if (!first) throw new Error('Give a media file or a session id.');
  if (!(await ensureReady(cfg))) return;

  let id: string;
  if (isValidSessionId(first)) {
    id = first;
  } else {
    const hierarchy = args.flags.get('hierarchy');
    id = await importMedia(cfg, [first, ...others], {
      ...(typeof hierarchy === 'string' ? { hierarchyPath: hierarchy } : {}),
      metadata: { client: `talkthru-cli/${VERSION}`, note: 'imported from the command line' },
    });
    out(`created session ${id}`);
  }

  const result = await processSession(cfg, id, { noAudio: args.flags.get('no-audio') === true });
  out(`ready: ${markdownPath(cfg, id)}`);
  out(`  ${result.bundle.keyframes.length} frames · ${result.bundle.timeline.length} timeline entries · ~${result.bundle.estimatedTokens} tokens`);
  for (const w of result.warnings) out(`  warning: ${w}`);
}


/**
 * Make sure the tools are present, installing them if they are not.
 *
 * Nobody should have to run a second command to make the first one work. The
 * speech model already downloads itself on first use; ffmpeg and whisper.cpp
 * now do the same, so `talkthru watch` on a clean machine just works.
 *
 * Returns false when something could not be installed, having already
 * explained what and why.
 */
async function ensureReady(cfg: TalkthruConfig): Promise<boolean> {
  const missing = (await runDoctor(cfg)).filter((c) => !c.ok);
  if (missing.length === 0) return true;

  out(`first run: setting up ${missing.map((c) => c.name).join(', ')}`);
  out('');
  const after = (await runDoctor(cfg, { fix: true })).filter((c) => !c.ok);
  if (after.length === 0) {
    out('ready.');
    out('');
    return true;
  }

  out('');
  out("talkthru could not finish setting itself up:");
  for (const c of after) {
    out(`  ${c.name} — ${c.detail}`);
    if (c.hint) out(`     ${c.hint}`);
  }
  process.exitCode = 1;
  return false;
}

async function cmdWatch(cfg: TalkthruConfig, args: Args): Promise<void> {
  const explicitDir = args.positionals[0];
  const dir = explicitDir ?? defaultWatchDir();
  const archiveDir =
    typeof args.flags.get('archive') === 'string' ? String(args.flags.get('archive')) : defaultArchiveDir(cfg);

  /**
   * Two modes, because the two folders mean different things.
   *
   * ~/Downloads is shared with the rest of your life, so only files named like
   * a screen recording are touched — everything else is invisible to us.
   * A folder you name explicitly is a folder you created for this, so anything
   * you drop in it is fair game.
   */
  const customPattern = args.flags.get('pattern');
  let pattern: RegExp | null;
  if (typeof customPattern === 'string') pattern = new RegExp(customPattern, 'i');
  else if (args.flags.get('any') === true) pattern = null;
  else if (args.flags.get('screen-recordings') === true) pattern = SCREEN_RECORDING_PATTERN;
  // On Windows the default folder is Videos\Captures, which holds nothing but
  // recordings, so the name filter is both unnecessary and unmatchable there.
  else pattern = explicitDir ? null : defaultPattern();

  if (!(await ensureReady(cfg))) return;

  const controller = new AbortController();

  const stop = (): void => {
    out('\nstopped watching.');
    controller.abort();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  await watchDirectory(cfg, {
    dir,
    archiveDir,
    pattern,
    stableMs: flagNumber(args, 'stable-ms', WATCH.STABLE_MS),
    pollMs: flagNumber(args, 'poll-ms', WATCH.POLL_MS),
    includeExisting: args.flags.get('existing') === true,
    signal: controller.signal,
    processOptions: { noAudio: args.flags.get('no-audio') === true },
    onReady: ({ dir: watched, ignored }) => {
      out(`watching ${watched}`);
      out(`  archive: ${archiveDir}`);
      out(
        pattern === null
          ? '  accepting: any video file in this folder'
          : `  accepting: screen recordings only (names matching ${pattern.source})`,
      );
      if (pattern !== null) out('  everything else in this folder is ignored and never touched.');
      if (ignored > 0) out(`  ignoring ${ignored} existing recording(s) — pass --existing to process them`);
      out('  record on your phone, AirDrop it here, and it processes automatically.');
      out('');
    },
    onDetected: (file) => out(`→ ${path.basename(file)}`),
    onProcessed: ({ sessionId, bundle, elapsedMs, bytes, archivedTo }) => {
      out(`  ready: ${sessionId}`);
      out(
        `  ${bundle.keyframes.length} frames · ${bundle.timeline.length} utterances · ` +
          `~${bundle.estimatedTokens} tokens · ${(bytes / 1e6).toFixed(1)} MB in ${(elapsedMs / 1000).toFixed(1)}s`,
      );
      for (const warning of bundle.warnings) out(`  warning: ${warning}`);
      out(`  archived: ${archivedTo}`);
      out('');
    },
    onError: ({ file, error }) => {
      out(`  FAILED ${path.basename(file)}: ${error.message}`);
      out('  the file was left in place.');
      out('');
    },
  });
}

async function cmdList(cfg: TalkthruConfig, args: Args): Promise<void> {
  const sessions = await listSessions(cfg, flagNumber(args, 'limit', 20));
  if (args.flags.get('json') === true) {
    out(JSON.stringify(sessions, null, 2));
    return;
  }
  if (sessions.length === 0) {
    out('No sessions yet. Record one, or run `talkthru process <file.mp4>`.');
    return;
  }
  for (const s of sessions) {
    const dur = `${(s.durationMs / 1000).toFixed(0)}s`.padStart(5);
    const line = `${s.id}  ${s.state.padEnd(10)} ${dur}  ${String(s.frameCount).padStart(2)}f  ${s.summary || '(no narration)'}`;
    out(line);
  }
}

async function cmdShow(cfg: TalkthruConfig, args: Args): Promise<void> {
  const id = await resolveId(cfg, args.positionals[0]);
  if (args.flags.get('json') === true) {
    out(JSON.stringify(await summarise(cfg, id), null, 2));
    return;
  }
  out(await fs.readFile(markdownPath(cfg, id), 'utf8'));
}

async function cmdPath(cfg: TalkthruConfig, args: Args): Promise<void> {
  out(sessionDir(cfg, await resolveId(cfg, args.positionals[0])));
}

async function cmdDelete(cfg: TalkthruConfig, args: Args): Promise<void> {
  const id = args.positionals[0];
  if (!id) throw new Error('Give a session id.');
  const removed = await deleteSession(cfg, id);
  out(removed ? `deleted ${id}` : `no such session ${id}`);
}

async function cmdPrune(cfg: TalkthruConfig, args: Args): Promise<void> {
  const result = await pruneSessions(cfg, {
    keep: flagNumber(args, 'keep', 50),
    days: flagNumber(args, 'days', 14),
    dryRun: args.flags.get('dry-run') === true,
  });
  out(`${args.flags.get('dry-run') === true ? 'would delete' : 'deleted'} ${result.deleted.length}, kept ${result.kept}`);
  for (const id of result.deleted) out(`  ${id}`);
}

async function cmdPair(cfg: TalkthruConfig): Promise<void> {
  const token = await ensureToken(cfg);
  const ips = lanAddresses();
  out('Point the app at one of these, with the token below.');
  out('');
  for (const ip of ips) out(`  http://${ip}:${cfg.port}${INGEST.API_PREFIX}/sessions`);
  if (ips.length === 0) out('  (no LAN address found — is Wi-Fi on?)');
  out('');
  out(`  token: ${token}`);
  out(`  header: ${CLIENT_HEADER}: <your app name>`);
  out('');
  out('Start the daemon with `talkthru serve --lan`.');
}

async function cmdDoctor(cfg: TalkthruConfig, args: Args): Promise<void> {
  out(`talkthru ${VERSION} doctor`);
  out('');
  const results = await runDoctor(cfg, { fix: args.flags.get('fix') === true });
  out(formatDoctor(results));
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

async function cmdDisk(cfg: TalkthruConfig): Promise<void> {
  const sessions = await listSessions(cfg, 1000);
  let total = 0;
  for (const s of sessions) total += await sessionBytes(cfg, s.id);
  out(`${sessions.length} sessions · ${(total / 1e6).toFixed(1)} MB under ${cfg.sessionsDir}`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const level = args.flags.get('log');
  if (typeof level === 'string') setLogLevel(level as LogLevel);

  const cfg = resolveConfig(
    typeof args.flags.get('home') === 'string' ? { home: String(args.flags.get('home')) } : {},
  );
  const migrated = await migrateLegacyHome(cfg);
  if (migrated) out(`moved your existing data from ${migrated} to ${cfg.home}`);
  await fs.mkdir(cfg.sessionsDir, { recursive: true });

  switch (args.command) {
    case 'serve':
      return cmdServe(cfg, args);
    case 'process':
      return cmdProcess(cfg, args);
    case 'watch':
      return cmdWatch(cfg, args);
    case 'list':
    case 'ls':
      return cmdList(cfg, args);
    case 'show':
    case 'cat':
      return cmdShow(cfg, args);
    case 'path':
      return cmdPath(cfg, args);
    case 'delete':
    case 'rm':
      return cmdDelete(cfg, args);
    case 'prune':
      return cmdPrune(cfg, args);
    case 'pair':
      return cmdPair(cfg);
    case 'doctor':
      return cmdDoctor(cfg, args);
    case 'disk':
      return cmdDisk(cfg);
    case 'version':
    case '--version':
      out(VERSION);
      return;
    default:
      out(HELP);
      if (args.command !== 'help' && args.command !== '--help') process.exitCode = 1;
  }
}

main().catch((e) => {
  const err = toTalkthruError(e);
  process.stderr.write(`talkthru: ${err.message}\n`);
  if (isTalkthruError(e) && e.hint) process.stderr.write(`  ↳ ${e.hint}\n`);
  process.exitCode = 1;
});
