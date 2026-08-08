import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import os from 'node:os';
import { TRANSCRIBE } from './constants.js';
import { ffmpegVersion, resolveFfmpeg } from './ffmpeg.js';
import { ensureModel, modelFileName, resolveWhisperBinary } from './whisper.js';
import { listSessionIds, readStatus } from './store.js';
import { run, resolveBinary } from './ffmpeg.js';
import { log } from './log.js';
import type { TalkthruConfig } from './config.js';

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}


/**
 * Install a missing system dependency with the platform package manager.
 *
 * ffmpeg and whisper.cpp are native binaries, not npm packages — npm cannot
 * install them, and vendoring them would mean shipping ~100 MB and losing the
 * hardware acceleration a Homebrew build gives you (Metal, on Apple silicon,
 * is the difference between whisper running faster than real time and not).
 * So `doctor --fix` drives the package manager for you instead: one command
 * still gets a working setup.
 *
 * Only runs under `--fix`, which is explicitly opt-in.
 */
async function installPackage(pkg: string): Promise<{ ok: boolean; detail: string }> {
  const platform = process.platform;
  let manager: string;
  let args: string[];

  if (platform === 'darwin') {
    manager = 'brew';
    args = ['install', pkg];
  } else if (platform === 'linux') {
    // apt needs root, and silently prompting for a sudo password from a tool
    // you just installed is not something we should do.
    return {
      ok: false,
      detail: `run: sudo apt-get install -y ${pkg === 'whisper-cpp' ? 'whisper.cpp' : pkg}`,
    };
  } else if (platform === 'win32') {
    // winget ships with Windows 11 and is the closest thing to a default.
    // whisper.cpp has no winget package, so say so rather than fail opaquely.
    if (pkg === 'whisper-cpp') {
      return {
        ok: false,
        detail: 'no winget package for whisper.cpp — see https://github.com/ggml-org/whisper.cpp, then set TALKTHRU_WHISPER',
      };
    }
    manager = 'winget';
    args = ['install', '--silent', '--accept-package-agreements', '--accept-source-agreements', '-e', '--id', 'Gyan.FFmpeg'];
  } else {
    return { ok: false, detail: `install ${pkg} manually on ${platform}` };
  }

  try {
    await resolveBinary(manager);
  } catch {
    return { ok: false, detail: `${manager} not found — install ${pkg} manually` };
  }

  log.info(`installing ${pkg} with ${manager} (this can take a few minutes)`);
  try {
    await run(manager, args, { timeoutMs: 20 * 60_000 });
    return { ok: true, detail: `installed ${pkg} with ${manager}` };
  } catch (e) {
    return { ok: false, detail: `${manager} install ${pkg} failed: ${String(e)}` };
  }
}

async function checkNode(): Promise<CheckResult> {
  const major = Number(process.versions.node.split('.')[0]);
  const ok = major >= 20;
  return {
    name: 'node',
    ok,
    detail: `v${process.versions.node}`,
    ...(ok ? {} : { hint: 'Talkthru needs Node 20.11 or newer.' }),
  };
}

async function checkFfmpeg(cfg: TalkthruConfig, fix = false): Promise<CheckResult[]> {
  try {
    const tools = await resolveFfmpeg(cfg);
    const version = await ffmpegVersion(tools);
    return [
      { name: 'ffmpeg', ok: true, detail: `${tools.ffmpeg} · ${version}` },
      { name: 'ffprobe', ok: true, detail: tools.ffprobe },
    ];
  } catch (e) {
    if (fix) {
      const installed = await installPackage('ffmpeg');
      if (installed.ok) {
        try {
          const tools = await resolveFfmpeg(cfg);
          return [
            { name: 'ffmpeg', ok: true, detail: `${tools.ffmpeg} (just installed)` },
            { name: 'ffprobe', ok: true, detail: tools.ffprobe },
          ];
        } catch {
          // fall through to the failure below
        }
      }
      return [{ name: 'ffmpeg', ok: false, detail: installed.detail, hint: 'brew install ffmpeg' }];
    }
    const err = e as { message?: string; hint?: string };
    return [
      {
        name: 'ffmpeg',
        ok: false,
        detail: err.message ?? String(e),
        hint: err.hint ?? 'run `talkthru doctor --fix`, or: brew install ffmpeg',
      },
    ];
  }
}

async function checkWhisper(cfg: TalkthruConfig, fix: boolean): Promise<CheckResult[]> {
  const out: CheckResult[] = [];
  let binary: string | null = null;
  try {
    binary = await resolveWhisperBinary(cfg.whisperPath);
    out.push({ name: 'whisper.cpp', ok: true, detail: binary });
  } catch (e) {
    if (fix) {
      const installed = await installPackage('whisper-cpp');
      if (installed.ok) {
        try {
          binary = await resolveWhisperBinary(cfg.whisperPath);
          out.push({ name: 'whisper.cpp', ok: true, detail: `${binary} (just installed)` });
        } catch {
          out.push({ name: 'whisper.cpp', ok: false, detail: installed.detail });
        }
      } else {
        out.push({ name: 'whisper.cpp', ok: false, detail: installed.detail });
      }
    } else {
    const err = e as { message?: string; hint?: string };
    out.push({
      name: 'whisper.cpp',
      ok: false,
      detail: err.message ?? String(e),
      hint: err.hint ?? 'run `talkthru doctor --fix`, or: brew install whisper-cpp',
    });
    }
  }

  const modelPath = path.join(cfg.modelsDir, modelFileName(cfg.whisperModel));
  let size: number | null = null;
  try {
    size = (await fs.stat(modelPath)).size;
  } catch {
    size = null;
  }
  if (size !== null && size >= TRANSCRIBE.MIN_MODEL_BYTES) {
    out.push({ name: 'model', ok: true, detail: `${cfg.whisperModel} (${(size / 1e6).toFixed(0)} MB)` });
  } else if (fix) {
    try {
      await ensureModel({ modelsDir: cfg.modelsDir, model: cfg.whisperModel });
      out.push({ name: 'model', ok: true, detail: `${cfg.whisperModel} downloaded` });
    } catch (e) {
      out.push({ name: 'model', ok: false, detail: String(e), hint: 'Check your network and retry.' });
    }
  } else {
    out.push({
      name: 'model',
      ok: false,
      detail: `${cfg.whisperModel} not downloaded`,
      hint: 'Run `talkthru doctor --fix` to download it (~490 MB, one time).',
    });
  }
  return out;
}

async function checkHome(cfg: TalkthruConfig): Promise<CheckResult> {
  try {
    await fs.mkdir(cfg.sessionsDir, { recursive: true });
    const probe = path.join(cfg.home, `.write-probe-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
    return { name: 'home', ok: true, detail: cfg.home };
  } catch (e) {
    return {
      name: 'home',
      ok: false,
      detail: `${cfg.home} is not writable: ${String(e)}`,
      hint: 'Set TALKTHRU_HOME to a writable directory.',
    };
  }
}

async function checkPort(cfg: TalkthruConfig): Promise<CheckResult> {
  const free = await new Promise<boolean>((resolve) => {
    const probe = net.createServer();
    probe.once('error', () => resolve(false));
    probe.once('listening', () => probe.close(() => resolve(true)));
    probe.listen(cfg.port, cfg.bind);
  });
  return free
    ? { name: 'port', ok: true, detail: `${cfg.bind}:${cfg.port} is free` }
    : {
        name: 'port',
        ok: true,
        detail: `${cfg.bind}:${cfg.port} is in use — a daemon is probably already running`,
      };
}

async function checkSessions(cfg: TalkthruConfig): Promise<CheckResult> {
  const ids = await listSessionIds(cfg);
  let failed = 0;
  let ready = 0;
  for (const id of ids.slice(0, 50)) {
    const status = await readStatus(cfg, id);
    if (status?.state === 'failed') failed++;
    if (status?.state === 'ready') ready++;
  }
  return {
    name: 'sessions',
    ok: true,
    detail: `${ids.length} total · ${ready} ready · ${failed} failed (of the newest 50)`,
  };
}

/** LAN addresses a device could reach this Mac on — printed by `talkthru pair`. */
export function lanAddresses(): string[] {
  const out: string[] = [];
  for (const [, addrs] of Object.entries(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) out.push(addr.address);
    }
  }
  return out;
}

export async function runDoctor(cfg: TalkthruConfig, opts: { fix?: boolean } = {}): Promise<CheckResult[]> {
  const results: CheckResult[] = [];
  results.push(await checkNode());
  results.push(await checkHome(cfg));
  results.push(...(await checkFfmpeg(cfg, opts.fix ?? false)));
  results.push(...(await checkWhisper(cfg, opts.fix ?? false)));
  results.push(await checkPort(cfg));
  results.push(await checkSessions(cfg));
  return results;
}

export function formatDoctor(results: CheckResult[]): string {
  const lines = results.map((r) => {
    const mark = r.ok ? 'ok  ' : 'FAIL';
    const hint = r.hint && !r.ok ? `\n       ↳ ${r.hint}` : '';
    return `  ${mark} ${r.name.padEnd(12)} ${r.detail}${hint}`;
  });
  const failed = results.filter((r) => !r.ok).length;
  lines.push('');
  lines.push(failed === 0 ? '  All checks passed.' : `  ${failed} check(s) need attention.`);
  return lines.join('\n');
}
