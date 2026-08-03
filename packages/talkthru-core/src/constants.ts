/**
 * Every tunable in one place. Nothing in this repo hardcodes a magic number at
 * its use site — if you need a new knob, add it here and document the unit.
 *
 * Environment overrides exist for the ones an operator realistically retunes;
 * see `resolveConfig()` in config.ts.
 */

export const INGEST = {
  /** Default TCP port for the ingest daemon. */
  PORT: 8917,
  /** Loopback-only by default. LAN exposure is opt-in (`--lan`) and token-gated. */
  BIND_LOOPBACK: '127.0.0.1',
  BIND_ALL: '0.0.0.0',
  /** Hard cap on a single uploaded session, bytes. Rejected with 413. */
  MAX_UPLOAD_BYTES: 512 * 1024 * 1024,
  /** Hard cap on any one part, bytes. */
  MAX_PART_BYTES: 512 * 1024 * 1024,
  /** Max number of files in one multipart body (video + audio + meta + hierarchy + frames). */
  MAX_FILES: 512,
  /** Idle socket timeout, ms. Devices on flaky Wi-Fi must not wedge a slot. */
  SOCKET_TIMEOUT_MS: 5 * 60_000,
  /** Bearer token length in bytes (hex-encoded to 2x this). */
  TOKEN_BYTES: 16,
  /** Bonjour service type advertised in LAN mode. */
  BONJOUR_TYPE: '_talkthru._tcp',
  BONJOUR_NAME: 'talkthru',
  /** API version prefix. Bump only on a breaking wire change. */
  API_PREFIX: '/v1',
} as const;

export const KEYFRAMES = {
  /** Sampling rate of the cheap perceptual probe pass, frames per second. */
  PROBE_FPS: 4,
  /** Probe frames are decoded to this square. 32x32 RGB = 3 KiB/frame. */
  PROBE_EDGE_PX: 32,
  /**
   * RGB, not grayscale. A grayscale probe cannot tell a red error screen from a
   * green success screen of the same brightness — it reported them as identical
   * on the fixture. Colour costs 3x the (tiny) probe memory and is worth it.
   */
  PROBE_CHANNELS: 3,
  /**
   * Mean absolute RGB difference (0..1) between the candidate and the last
   * *kept* frame required to call it a new scene. Tuned on the synthetic
   * fixture: hard cuts land ~0.15-0.45, scroll/animation noise ~0.01-0.03.
   */
  SCENE_DELTA: 0.055,
  /**
   * Two frames are "the same screen" only if BOTH their luma dHash is within
   * DUP_HAMMING *and* their colour signature is within DUP_COLOR_DIST. Either
   * test alone produces false merges.
   */
  DUP_HAMMING: 5,
  /** Mean per-channel distance (0..1) of the 4x4 colour signature. */
  DUP_COLOR_DIST: 0.05,
  /** Grid edge of the coarse colour signature used for duplicate detection. */
  COLOR_SIGNATURE_EDGE: 4,
  /** Never emit more than this many keyframes, whatever the session length. */
  MAX_FRAMES: 20,
  /** Long-edge cap for emitted keyframes, px. */
  MAX_EDGE_PX: 1024,
  /** ffmpeg -q:v for emitted JPEGs (2 = best, 31 = worst). */
  JPEG_QUALITY: 5,
  /** Minimum seconds between two emitted keyframes — kills strobing. */
  MIN_GAP_SEC: 0.4,
  /**
   * Sample the emitted JPEG this far AFTER the probe frame's nominal time,
   * as a fraction of one probe interval (0.5 = the middle of the interval).
   *
   * WHY: ffmpeg's `fps=N` filter emits the frame that *covers* output time
   * i/N, so probe frame i actually represents source content around
   * i/N + 1/(2N). Re-extracting at exactly i/N reliably grabs the frame just
   * BEFORE the change that selected it — i.e. the previous screen.
   *
   * Found on a real 107 s recording: the frame selected when Settings opened
   * was extracted as the screen from a moment earlier, and because the screen
   * was then static for 16 s, Settings never appeared in the bundle at all.
   * Measured difference between what the selector saw and what we extracted:
   * 0.2278 at offset 0, 0.0041 at offset 0.5. The synthetic fixture never
   * caught this because its cuts land exactly on probe boundaries.
   */
  SAMPLE_OFFSET_RATIO: 0.5,
} as const;

export const TRANSCRIBE = {
  /** whisper.cpp wants 16 kHz mono PCM. */
  SAMPLE_RATE: 16_000,
  CHANNELS: 1,
  /**
   * `small.en` (~466 MB), not `base.en` (~148 MB).
   *
   * base.en mangles exactly the words this tool exists to capture: on the
   * fixture it heard "Now I tapped Mars" as "Now I tap Mars" and "is way too
   * small" as "was way too small". Harmless for prose, but people narrating
   * feedback say product names, screen names and identifiers, and a mangled
   * identifier sends an agent to the wrong symbol.
   *
   * Roughly 3x slower than base.en and still far faster than real time on
   * Apple silicon. Override with TALKTHRU_MODEL=base.en (or tiny.en/medium.en).
   */
  DEFAULT_MODEL: 'small.en',
  /** Models known to work; anything else is passed through to the downloader. */
  KNOWN_MODELS: ['tiny.en', 'base.en', 'small.en', 'medium.en', 'large-v3'],
  MODEL_BASE_URL: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main',
  /** Download timeout for the model, ms. */
  DOWNLOAD_TIMEOUT_MS: 20 * 60_000,
  /** Sanity floor: a truncated model download is worse than none. Bytes. */
  MIN_MODEL_BYTES: 20 * 1024 * 1024,
  /** Wall clock allowed for one transcription, ms. */
  TIMEOUT_MS: 30 * 60_000,
  /** Threads passed to whisper-cli; 0 lets it choose. */
  THREADS: 0,
} as const;

export const ALIGN = {
  /** Silence at or above this splits one utterance from the next, ms. */
  UTTERANCE_PAUSE_MS: 600,
  /** An utterance longer than this is split at the largest internal gap, ms. */
  MAX_UTTERANCE_MS: 20_000,
  /** Drop utterances whose text is empty or pure punctuation after cleanup. */
  MIN_UTTERANCE_CHARS: 1,
  /**
   * The frame shown when someone starts talking is usually the thing they are
   * talking about, but speech lags the tap. Look back by this much, ms.
   */
  SPEECH_LAG_MS: 250,
} as const;

/**
 * Voice activity detection, done with ffmpeg's `silencedetect` rather than by
 * trusting whisper's own timestamps.
 *
 * WHY THIS EXISTS: whisper.cpp compresses long silences — feeding it a 60 s
 * recording with six sentences separated by 8 s gaps produced utterances that
 * merged three sentences and were off by up to 7 s. Detecting speech regions
 * from actual audio energy and transcribing each region separately gives exact
 * boundaries, keeps whisper from hallucinating text over silence, and is
 * faster because silence is never decoded.
 */
export const VAD = {
  /** Anything below this level counts as silence. */
  NOISE_DB: -35,
  /** Silence must last at least this long to split two utterances, seconds. */
  MIN_SILENCE_SEC: ALIGN.UTTERANCE_PAUSE_MS / 1000,
  /** Widen each speech region so the first/last phoneme is not clipped, ms. */
  PAD_MS: 120,
  /** Ignore blips shorter than this — door clicks, mouse taps. ms. */
  MIN_SPEECH_MS: 220,
  /** A single uninterrupted region longer than this is transcribed whole, sec. */
  MAX_SEGMENT_SEC: 120,
  /** Give up on VAD beyond this many regions and transcribe the file whole. */
  MAX_SEGMENTS: 200,
} as const;

export const UI_CONTEXT = {
  /** Max hierarchy nodes summarised per frame in session.md. */
  MAX_NODES_PER_FRAME: 12,
  /** A hierarchy snapshot further than this from a frame is not used, ms. */
  MAX_SNAPSHOT_SKEW_MS: 750,
  /** Truncate any single label to this many chars. */
  MAX_LABEL_CHARS: 48,
  /** Nodes smaller than this (px, either edge) are noise. */
  MIN_NODE_EDGE_PX: 8,
} as const;

export const BUNDLE = {
  /** Soft target for session.md size, characters (~4 chars/token). */
  TARGET_CHARS: 28_000,
  /** Rough chars-per-token used for the estimate we print. */
  CHARS_PER_TOKEN: 4,
  MARKDOWN_NAME: 'session.md',
  JSON_NAME: 'session.json',
  STATUS_NAME: 'status.json',
  FRAMES_DIR: 'frames',
  RAW_DIR: 'raw',
} as const;

export const MCP = {
  /** Max keyframes returned as image blocks by get_session. */
  MAX_IMAGES: 12,
  /** Max total base64 image payload returned in one tool call, bytes. */
  MAX_IMAGE_BYTES: 6 * 1024 * 1024,
  /** Default page size for list_sessions. */
  DEFAULT_LIST_LIMIT: 10,
  MAX_LIST_LIMIT: 100,
} as const;

/**
 * `talkthru watch` — folder ingestion for the "screen-record and AirDrop it"
 * workflow, which needs no SDK in the app being recorded.
 */
export const WATCH = {
  /** Where AirDrop puts things. */
  DEFAULT_DIR_NAME: 'Downloads',
  /** Processed originals move here rather than being deleted. */
  ARCHIVE_DIR_NAME: 'archive',
  /**
   * A file must hold the same size and mtime for this long before we touch it.
   *
   * AirDrop creates the file with its final name and then fills it, so reacting
   * to the create event hands ffmpeg a truncated video. Size-stability is the
   * only reliable signal — there is no "transfer complete" notification we can
   * observe from outside.
   */
  STABLE_MS: 2_500,
  /** How often the directory is re-listed. */
  POLL_MS: 1_000,
  /** Ignore anything smaller than this; a 0-byte placeholder is not a video. */
  MIN_BYTES: 64 * 1024,
  /** Video containers worth processing. */
  EXTENSIONS: ['.mov', '.mp4', '.m4v', '.webm', '.mkv', '.avi'],
  /** In-progress markers used by AirDrop, Safari, Chrome and rsync. */
  PARTIAL_SUFFIXES: ['.download', '.part', '.partial', '.crdownload', '.tmp', '.opdownload'],
} as const;

export const STORE = {
  /** Session ids look like 20260803-001500-a1b2c3. */
  ID_PATTERN: /^[0-9]{8}-[0-9]{6}-[a-z0-9]{6}$/,
  ID_RANDOM_CHARS: 6,
  /** `talkthru prune` defaults. */
  KEEP_SESSIONS: 50,
  KEEP_DAYS: 14,
} as const;

/** Terminal + non-terminal states of a session. */
export const SESSION_STATES = [
  'uploading',
  'queued',
  'processing',
  'ready',
  'failed',
] as const;

export const PIPELINE_STAGES = [
  'probe',
  'audio',
  'keyframes',
  'transcribe',
  'align',
  'render',
] as const;
