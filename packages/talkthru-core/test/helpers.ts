import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolveConfig, type TalkthruConfig } from '../src/config.js';
import type { Transcriber, Transcript, TranscriptWord } from '../src/types.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, '..', '..', '..');
export const FIXTURES = path.join(REPO_ROOT, 'fixtures');
export const GENERATED = path.join(FIXTURES, 'generated');
export const FIXTURE_VIDEO = path.join(GENERATED, 'fixture.mp4');
export const FIXTURE_HIERARCHY = path.join(GENERATED, 'hierarchy.json');
export const FIXTURE_META = path.join(GENERATED, 'meta.json');

export function runCommand(bin: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${stderr.slice(-500)}`)),
    );
  });
}

/** Generate the synthetic fixture on demand so a fresh clone can just run tests. */
export async function ensureFixture(): Promise<void> {
  try {
    await fs.access(FIXTURE_VIDEO);
    return;
  } catch {
    await runCommand(process.execPath, [path.join(REPO_ROOT, 'scripts', 'make-fixture.mjs')]);
  }
}

export async function tempHome(label: string): Promise<{ cfg: TalkthruConfig; cleanup: () => Promise<void> }> {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), `talkthru-test-${label}-`));
  const cfg = resolveConfig({ home, port: 0 });
  await fs.mkdir(cfg.sessionsDir, { recursive: true });
  return {
    cfg,
    cleanup: async () => {
      await fs.rm(home, { recursive: true, force: true });
    },
  };
}

/** The committed real-whisper output, replayed without running whisper. */
export async function loadFixtureTranscript(): Promise<{ words: TranscriptWord[]; engine: string }> {
  const raw = await fs.readFile(path.join(FIXTURES, 'transcript.json'), 'utf8');
  const parsed = JSON.parse(raw) as { words: TranscriptWord[]; engine: string };
  return parsed;
}

/**
 * Returns a fixed transcript regardless of input audio. Used with
 * `useVad: false` so the pipeline is exercised end to end deterministically.
 */
export class FakeTranscriber implements Transcriber {
  readonly name: string;
  constructor(
    private readonly words: TranscriptWord[],
    name = 'fixture',
  ) {
    this.name = name;
  }
  async available(): Promise<{ ok: boolean; detail: string }> {
    return { ok: true, detail: 'fake' };
  }
  async transcribe(): Promise<Transcript> {
    return {
      words: this.words.map((w) => ({ ...w })),
      text: this.words.map((w) => w.text).join(' '),
      engine: this.name,
      coarseTiming: false,
    };
  }
}

/** Build a packed RGB probe frame of a single colour. */
export function solidFrame(edge: number, r: number, g: number, b: number): Uint8Array {
  const buf = new Uint8Array(edge * edge * 3);
  for (let i = 0; i < edge * edge; i++) {
    buf[i * 3] = r;
    buf[i * 3 + 1] = g;
    buf[i * 3 + 2] = b;
  }
  return buf;
}

/** Same as solidFrame but with a filled rectangle drawn on it. */
export function frameWithBox(
  edge: number,
  bg: [number, number, number],
  box: { x: number; y: number; w: number; h: number; color: [number, number, number] },
): Uint8Array {
  const buf = solidFrame(edge, bg[0], bg[1], bg[2]);
  for (let y = box.y; y < Math.min(edge, box.y + box.h); y++) {
    for (let x = box.x; x < Math.min(edge, box.x + box.w); x++) {
      const i = (y * edge + x) * 3;
      buf[i] = box.color[0];
      buf[i + 1] = box.color[1];
      buf[i + 2] = box.color[2];
    }
  }
  return buf;
}

export async function copyInto(sessionRawDir: string, files: Array<[string, string]>): Promise<void> {
  await fs.mkdir(sessionRawDir, { recursive: true });
  for (const [src, name] of files) {
    await fs.copyFile(src, path.join(sessionRawDir, name));
  }
}
