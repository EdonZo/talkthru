#!/usr/bin/env node
/**
 * Upgrade-path end-to-end test: the LAST PUBLISHED version creates real
 * sessions, and the CURRENT BUILD must read, serve and compact them.
 *
 * This is the test that protects existing users' setups — the unit suite runs
 * everything against fixtures the current code created, which can never catch
 * "new code misreads old data". Run before every release:
 *
 *   npm run build && node scripts/e2e-upgrade.mjs
 *
 * Needs: network (installs the published packages into a temp dir), ffmpeg,
 * and a whisper model cache (TALKTHRU_MODELS_DIR or ~/.talkthru/models).
 * Leaves nothing behind: everything happens under a temp dir that is removed
 * at the end, pass or fail.
 */
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const NEW_CLI = path.join(ROOT, 'packages/talkthru-core/dist/cli.js');
const NEW_MCP = path.join(ROOT, 'packages/talkthru-mcp/dist/server.js');
const FIXTURE = path.join(ROOT, 'fixtures/generated/fixture.mp4');
const FIXTURE_AUDIO = path.join(ROOT, 'fixtures/generated/fixture-audio.wav');
const MODELS =
  process.env.TALKTHRU_MODELS_DIR ?? path.join(os.homedir(), '.talkthru', 'models');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'talkthru-e2e-'));
const HOME = path.join(tmp, 'home');
let failures = 0;

function check(label, ok, detail = '') {
  const mark = ok ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
}

function run(cmd, args, opts = {}) {
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    env: { ...process.env, TALKTHRU_HOME: HOME, TALKTHRU_MODELS_DIR: MODELS },
    ...opts,
  });
}

function newCli(...args) {
  return run('node', [NEW_CLI, ...args]);
}

try {
  /* 1 ── the published version creates sessions ─────────────────────────── */
  console.log('· installing last published talkthru into a temp dir');
  const oldDir = path.join(tmp, 'oldpkg');
  fs.mkdirSync(oldDir, { recursive: true });
  execFileSync('npm', ['init', '-y'], { cwd: oldDir, stdio: 'ignore' });
  execFileSync('npm', ['install', '--silent', 'talkthru@latest'], {
    cwd: oldDir,
    stdio: 'ignore',
  });
  const OLD_CLI = path.join(oldDir, 'node_modules/talkthru/dist/cli.js');
  const oldVersion = JSON.parse(
    fs.readFileSync(path.join(oldDir, 'node_modules/talkthru/package.json'), 'utf8'),
  ).version;
  console.log(`· published version: ${oldVersion}`);

  run('node', [OLD_CLI, 'process', FIXTURE]);
  run('node', [OLD_CLI, 'process', FIXTURE, FIXTURE_AUDIO]);
  const sessions = fs.readdirSync(path.join(HOME, 'sessions'));
  check('published version created sessions', sessions.length === 2);

  /* 2 ── the new build reads them ───────────────────────────────────────── */
  const list = newCli('list');
  check('new list sees old sessions', sessions.every((id) => list.includes(id)));
  const show = newCli('show', 'latest');
  check('new show renders an old bundle', /# Talkthru session/.test(show));
  const utterancesBefore = (show.match(/^- \[/gm) ?? []).length;
  check('old transcript intact', utterancesBefore > 0, `${utterancesBefore} utterances`);

  /* 3 ── MCP: what a configured client actually does ────────────────────── */
  const mcpResult = await new Promise((resolve) => {
    const child = spawn('node', [NEW_MCP], {
      env: { ...process.env, TALKTHRU_HOME: HOME },
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let buf = '';
    const pending = new Map();
    child.stdout.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.id && pending.has(m.id)) pending.get(m.id)(m);
        } catch {
          /* not json */
        }
      }
    });
    const send = (id, method, params) =>
      new Promise((res) => {
        pending.set(id, res);
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    const timer = setTimeout(() => {
      child.kill();
      resolve(null);
    }, 30_000);
    (async () => {
      await send(1, 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'e2e-upgrade', version: '0' },
      });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
      const latest = await send(2, 'tools/call', { name: 'get_latest_session', arguments: {} });
      clearTimeout(timer);
      child.kill();
      resolve(latest.result?.content ?? null);
    })().catch(() => {
      clearTimeout(timer);
      child.kill();
      resolve(null);
    });
  });
  check('MCP handshake + get_latest_session', mcpResult !== null);
  if (mcpResult) {
    check(
      'MCP serves frames from an old session',
      mcpResult.some((c) => c.type === 'image'),
    );
  }

  /* 4 ── compact keeps the history ──────────────────────────────────────── */
  newCli('compact', '--all', '--keep-recent', '0');
  const showAfter = newCli('show', 'latest');
  const utterancesAfter = (showAfter.match(/^- \[/gm) ?? []).length;
  check('transcript survives compact', utterancesAfter === utterancesBefore);
  const rawDirs = sessions.map((id) => path.join(HOME, 'sessions', id, 'raw'));
  const heavyLeft = rawDirs.flatMap((d) =>
    fs.existsSync(d) ? fs.readdirSync(d).filter((n) => /\.(mp4|mov|wav|m4a)$/i.test(n)) : [],
  );
  check('raw media reclaimed', heavyLeft.length === 0);
  const frames = sessions.every(
    (id) => fs.readdirSync(path.join(HOME, 'sessions', id, 'frames')).length > 0,
  );
  check('frames kept', frames);

  /* 5 ── the watcher end to end ─────────────────────────────────────────── */
  const watchDir = path.join(tmp, 'watchdir');
  fs.mkdirSync(watchDir);
  fs.copyFileSync(FIXTURE, path.join(watchDir, 'Screen Recording e2e.mp4'));
  const watched = await new Promise((resolve) => {
    const child = spawn('node', [NEW_CLI, 'watch', watchDir, '--existing'], {
      env: { ...process.env, TALKTHRU_HOME: HOME, TALKTHRU_MODELS_DIR: MODELS },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      if (/archived:/.test(out)) {
        setTimeout(() => {
          child.kill();
          resolve(out);
        }, 1500);
      }
    });
    setTimeout(() => {
      child.kill();
      resolve(null);
    }, 120_000);
  });
  check('watcher detects, processes, archives', watched !== null);
  if (watched) {
    const id = /ready: (\S+)/.exec(watched)?.[1];
    const status = JSON.parse(
      fs.readFileSync(path.join(HOME, 'sessions', id, 'status.json'), 'utf8'),
    );
    check('archivedTo recorded on the session', typeof status.archivedTo === 'string');
    check('fresh session not auto-compacted', status.compacted === undefined);
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('· temp dir removed');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nall upgrade-path checks passed');
