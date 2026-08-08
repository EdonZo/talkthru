import fs from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import path from 'node:path';
import { BUNDLE } from './constants.js';
import { TalkthruError, ErrorCodes } from './errors.js';
import { ensureSessionDirs, initStatus, newSessionId, patchStatus, safeFileName, sessionDir } from './store.js';
import type { TalkthruConfig } from './config.js';

/**
 * Create a session from local files — a screen recording you already have, a
 * QuickTime capture, or a video+audio pair. This is the path that lets someone
 * try Talkthru before wiring the SDK into an app.
 */
export async function importMedia(
  cfg: TalkthruConfig,
  files: string[],
  opts: { metadata?: Record<string, unknown>; hierarchyPath?: string } = {},
): Promise<string> {
  if (files.length === 0) {
    throw new TalkthruError(ErrorCodes.NO_MEDIA, 'No input files given');
  }
  for (const file of files) {
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) throw new Error('not a file');
    } catch {
      throw new TalkthruError(ErrorCodes.NO_MEDIA, `Cannot read input file: ${file}`);
    }
  }

  const id = newSessionId();
  const dir = await ensureSessionDirs(cfg, id);
  await initStatus(cfg, id, 'local');
  const rawDir = path.join(dir, BUNDLE.RAW_DIR);

  for (const file of files) {
    // Copy rather than link: the source may be a temp file the user deletes.
    // FICLONE makes this a copy-on-write clone on APFS/btrfs — instant and
    // zero extra disk for a multi-GB recording — and silently falls back to a
    // real copy on filesystems without reflinks.
    await fs.copyFile(file, path.join(rawDir, safeFileName(path.basename(file))), fsConstants.COPYFILE_FICLONE);
  }
  if (opts.hierarchyPath) {
    await fs.copyFile(opts.hierarchyPath, path.join(rawDir, 'hierarchy.json'));
  }
  if (opts.metadata) {
    await fs.writeFile(path.join(rawDir, 'meta.json'), `${JSON.stringify(opts.metadata, null, 2)}\n`, 'utf8');
  }
  await patchStatus(cfg, id, { state: 'queued' });
  return sessionDir(cfg, id) === dir ? id : id;
}
