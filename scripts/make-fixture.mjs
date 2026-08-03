#!/usr/bin/env node
/**
 * Generate the synthetic test fixture: a 60 s "screen recording" with scene
 * changes at known times, plus a matching UI hierarchy.
 *
 * Determinism is the whole point. The scene cuts are hard cuts on integer
 * seconds and every scene is a flat colour with axis-aligned boxes, so the
 * 4 fps grayscale probe pass sees identical frames on any ffmpeg build. That
 * is what lets `fixtures/expected-session.md` be a byte-exact golden file.
 *
 * Scene 4 is a pixel-for-pixel repeat of scene 0 — it exists to prove the
 * near-duplicate rejector actually fires. If you change SCENES, you must
 * regenerate the golden: `npm run fixture && npm run golden:accept`.
 *
 * Usage: node scripts/make-fixture.mjs [outDir]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const OUT_DIR = path.resolve(process.argv[2] ?? path.join(REPO, 'fixtures', 'generated'));

const WIDTH = 480;
const HEIGHT = 854;
const FPS = 30;
const SCENE_SECONDS = 10;

/**
 * Each scene: a background colour and a list of boxes.
 * `expectKeyframe` documents the intent of the fixture, and the golden test
 * asserts it — it is not read by the generator.
 */
const SCENES = [
  {
    name: 'home',
    bg: '0x1E3A8A',
    boxes: [{ x: 40, y: 60, w: 400, h: 90, c: 'white' }],
    expectKeyframe: true,
  },
  {
    name: 'planet-open',
    bg: '0x1E3A8A',
    boxes: [
      { x: 40, y: 60, w: 400, h: 90, c: 'white' },
      { x: 90, y: 300, w: 300, h: 300, c: 'white' },
    ],
    expectKeyframe: true,
  },
  {
    name: 'detail',
    bg: '0x7F1D1D',
    boxes: [{ x: 20, y: 500, w: 440, h: 200, c: 'white' }],
    expectKeyframe: true,
  },
  {
    name: 'settings',
    bg: '0x14532D',
    boxes: [{ x: 60, y: 120, w: 360, h: 60, c: 'white' }],
    expectKeyframe: true,
  },
  {
    // Byte-identical to scene 0 — must be rejected as a near-duplicate.
    name: 'home-again',
    bg: '0x1E3A8A',
    boxes: [{ x: 40, y: 60, w: 400, h: 90, c: 'white' }],
    expectKeyframe: false,
  },
  {
    name: 'error-state',
    bg: '0xEAB308',
    boxes: [{ x: 100, y: 400, w: 280, h: 120, c: 'black' }],
    expectKeyframe: true,
  },
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

/** One filter chain per scene: a solid colour source with boxes drawn on it. */
function sceneFilters() {
  const inputs = [];
  const filters = [];
  SCENES.forEach((scene, i) => {
    inputs.push('-f', 'lavfi', '-i', `color=c=${scene.bg}:s=${WIDTH}x${HEIGHT}:r=${FPS}:d=${SCENE_SECONDS}`);
    const boxes = scene.boxes
      .map((b) => `drawbox=x=${b.x}:y=${b.y}:w=${b.w}:h=${b.h}:color=${b.c}:t=fill`)
      .join(',');
    filters.push(`[${i}:v]${boxes},format=yuv420p,setsar=1[v${i}]`);
  });
  const concatInputs = SCENES.map((_, i) => `[v${i}]`).join('');
  filters.push(`${concatInputs}concat=n=${SCENES.length}:v=1:a=0[out]`);
  return { inputs, filterGraph: filters.join(';') };
}

async function makeVideo(outPath) {
  const { inputs, filterGraph } = sceneFilters();
  const totalSeconds = SCENES.length * SCENE_SECONDS;
  await run('ffmpeg', [
    '-v', 'error',
    '-nostdin',
    ...inputs,
    // A silent audio track keeps the fixture self-contained: the pipeline's
    // audio stage runs on every platform without needing macOS `say`, and the
    // golden test supplies words through a fake transcriber.
    '-f', 'lavfi', '-i', `anullsrc=r=16000:cl=mono:d=${totalSeconds}`,
    '-filter_complex', filterGraph,
    '-map', '[out]',
    '-map', `${SCENES.length}:a`,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    // Keyframe every second so seek-and-extract lands exactly where we ask.
    '-g', String(FPS),
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-shortest',
    '-y',
    outPath,
  ]);
}

/**
 * A UI tree per scene, in the shape TalkthruKit uploads. Two origins are present
 * on purpose: `native` nodes as a UIKit app reports them, and `dom` nodes as the
 * WKWebView bridge reports them for a Capacitor app.
 */
function hierarchy() {
  const snapshots = SCENES.map((scene, i) => ({
    tMs: i * SCENE_SECONDS * 1000,
    screen: { width: WIDTH, height: HEIGHT },
    nodes: nodesForScene(scene, i),
    ...(scene.name === 'error-state' ? { occlusions: ['system alert'] } : {}),
  }));
  return { version: 1, snapshots };
}

function nodesForScene(scene, i) {
  const base = [
    { type: 'UIWindow', rect: [0, 0, WIDTH, HEIGHT], depth: 0, origin: 'native' },
    { type: 'WKWebView', rect: [0, 0, WIDTH, HEIGHT], depth: 1, origin: 'native' },
  ];
  const perScene = {
    home: [
      { type: 'header', testId: 'app-header', label: 'AstroShort', rect: [40, 60, 400, 90], depth: 3, origin: 'dom' },
      { type: 'button', testId: 'planet-mars', label: 'Mars', rect: [90, 300, 120, 120], depth: 4, origin: 'dom' },
    ],
    'planet-open': [
      { type: 'header', testId: 'app-header', label: 'AstroShort', rect: [40, 60, 400, 90], depth: 3, origin: 'dom' },
      { type: 'div', testId: 'planet-card', label: 'Mars — the red planet', rect: [90, 300, 300, 300], depth: 4, origin: 'dom' },
    ],
    detail: [
      { type: 'section', testId: 'fact-panel', label: 'Diameter 6,779 km', rect: [20, 500, 440, 200], depth: 4, origin: 'dom' },
    ],
    settings: [
      { type: 'button', testId: 'settings-close', label: 'Close', rect: [60, 120, 360, 60], depth: 3, origin: 'dom' },
    ],
    'home-again': [
      { type: 'header', testId: 'app-header', label: 'AstroShort', rect: [40, 60, 400, 90], depth: 3, origin: 'dom' },
    ],
    'error-state': [
      { type: 'div', testId: 'error-banner', label: 'Could not load', rect: [100, 400, 280, 120], depth: 3, origin: 'dom' },
    ],
  };
  return [...base, ...(perScene[scene.name] ?? [])].map((n) => ({ ...n, sceneIndex: i }));
}

function metadata() {
  return {
    app: 'FixtureApp',
    appVersion: '1.0.0',
    device: 'Fixture',
    os: 'synthetic',
    screen: { width: WIDTH, height: HEIGHT, scale: 2 },
    audioOffsetMs: 0,
    client: 'make-fixture/1',
    note: 'synthetic fixture — deterministic scene cuts every 10s',
  };
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true });
  const videoPath = path.join(OUT_DIR, 'fixture.mp4');
  process.stderr.write(`generating ${videoPath}…\n`);
  await makeVideo(videoPath);
  await fs.writeFile(path.join(OUT_DIR, 'hierarchy.json'), `${JSON.stringify(hierarchy(), null, 2)}\n`);
  await fs.writeFile(path.join(OUT_DIR, 'meta.json'), `${JSON.stringify(metadata(), null, 2)}\n`);
  const stat = await fs.stat(videoPath);
  process.stderr.write(
    `fixture ready: ${SCENES.length} scenes · ${SCENES.length * SCENE_SECONDS}s · ${(stat.size / 1024).toFixed(0)} KB\n`,
  );
}

main().catch((e) => {
  process.stderr.write(`make-fixture failed: ${e.message}\n`);
  process.exit(1);
});

export { SCENES, SCENE_SECONDS, WIDTH, HEIGHT };
