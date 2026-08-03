#!/usr/bin/env node
/**
 * Generate the narration track that pairs with `fixture.mp4`, with each
 * sentence placed at a known offset so alignment can be asserted exactly.
 *
 * macOS only: it uses `say` for text-to-speech. This is a convenience for
 * end-to-end testing on a developer machine, NOT a CI dependency — the golden
 * test uses `fixtures/transcript.json` and never runs whisper or `say`.
 *
 * Usage: node scripts/make-fixture-audio.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT_DIR = path.resolve(process.argv[2] ?? path.join(REPO, 'fixtures', 'generated'));

const SAMPLE_RATE = 16_000;
const TOTAL_SECONDS = 60;
const VOICE = 'Samantha';

/** Each line starts at `atMs`, inside the scene it talks about. */
export const NARRATION = [
  { atMs: 2_000, text: 'This is the home screen. The header spacing at the top looks wrong.' },
  { atMs: 12_000, text: 'Now I tapped Mars and the planet card opened.' },
  { atMs: 22_000, text: 'The fact panel down here is too low on the screen.' },
  { atMs: 32_000, text: 'This is settings. The close button is way too small.' },
  { atMs: 42_000, text: 'I am back on the home screen again. Same spacing problem.' },
  { atMs: 52_000, text: 'And this error state. The yellow is far too bright.' },
];

function run(bin, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      stderr += d.toString();
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`${bin} exited ${code}: ${stderr.slice(-600)}`)),
    );
  });
}

async function main() {
  if (os.platform() !== 'darwin') {
    process.stderr.write('make-fixture-audio needs macOS `say`; skipping.\n');
    process.exit(0);
  }
  await fs.mkdir(OUT_DIR, { recursive: true });
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'talkthru-fixture-'));

  try {
    const clips = [];
    for (const [i, line] of NARRATION.entries()) {
      const aiff = path.join(tmp, `line${i}.aiff`);
      const wav = path.join(tmp, `line${i}.wav`);
      await run('say', ['-v', VOICE, '-o', aiff, line.text]);
      await run('ffmpeg', ['-v', 'error', '-i', aiff, '-ar', String(SAMPLE_RATE), '-ac', '1', '-y', wav]);
      clips.push({ wav, atMs: line.atMs });
    }

    // Silent bed + one delayed copy of each clip, mixed without normalisation
    // (normalising would make loudness depend on how many clips overlap).
    const args = ['-v', 'error', '-f', 'lavfi', '-i', `anullsrc=r=${SAMPLE_RATE}:cl=mono`, '-t', String(TOTAL_SECONDS)];
    for (const clip of clips) args.push('-i', clip.wav);

    const chains = clips.map((clip, i) => `[${i + 1}:a]adelay=${clip.atMs}:all=1[d${i}]`);
    const mixInputs = ['[0:a]', ...clips.map((_, i) => `[d${i}]`)].join('');
    const filter = `${chains.join(';')};${mixInputs}amix=inputs=${clips.length + 1}:normalize=0[out]`;

    const outPath = path.join(OUT_DIR, 'fixture-audio.wav');
    args.push(
      '-filter_complex', filter,
      '-map', '[out]',
      '-ar', String(SAMPLE_RATE),
      '-ac', '1',
      '-t', String(TOTAL_SECONDS),
      '-y', outPath,
    );
    await run('ffmpeg', args);

    await fs.writeFile(
      path.join(OUT_DIR, 'narration.json'),
      `${JSON.stringify({ voice: VOICE, sampleRate: SAMPLE_RATE, lines: NARRATION }, null, 2)}\n`,
    );
    const stat = await fs.stat(outPath);
    process.stderr.write(`fixture audio ready: ${NARRATION.length} lines · ${(stat.size / 1024).toFixed(0)} KB\n`);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

main().catch((e) => {
  process.stderr.write(`make-fixture-audio failed: ${e.message}\n`);
  process.exit(1);
});
