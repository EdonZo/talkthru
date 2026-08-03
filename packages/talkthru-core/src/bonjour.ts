import { spawn, type ChildProcess } from 'node:child_process';
import { INGEST } from './constants.js';
import { log } from './log.js';

/**
 * Advertise the ingest daemon on the local network so the SDK can find the Mac
 * without a hardcoded IP.
 *
 * Deliberately shells out to the OS registration tool (`dns-sd` on macOS,
 * `avahi-publish` on Linux) instead of taking an mDNS npm dependency: the
 * daemon runs on the developer's own machine, both tools ship with the OS, and
 * an extra native dependency is a worse trade than a 20-line child process.
 * Advertising is best-effort — the SDK always supports a manual IP.
 */
export interface Advertisement {
  stop(): void;
  transport: 'dns-sd' | 'avahi' | 'none';
}

export function advertise(port: number, name = INGEST.BONJOUR_NAME): Advertisement {
  const candidates: Array<{ bin: string; args: string[]; transport: 'dns-sd' | 'avahi' }> = [
    { bin: 'dns-sd', args: ['-R', name, INGEST.BONJOUR_TYPE, 'local', String(port)], transport: 'dns-sd' },
    {
      bin: 'avahi-publish',
      args: ['-s', name, `${INGEST.BONJOUR_TYPE}`, String(port)],
      transport: 'avahi',
    },
  ];

  for (const candidate of candidates) {
    let child: ChildProcess;
    try {
      child = spawn(candidate.bin, candidate.args, { stdio: 'ignore' });
    } catch {
      continue;
    }
    let failedImmediately = false;
    child.on('error', () => {
      failedImmediately = true;
    });
    // A spawn error surfaces asynchronously; if it does, we simply stay silent
    // and the user falls back to a manual IP (which `talkthru pair` prints).
    child.on('exit', (code) => {
      if (code !== 0 && !failedImmediately) log.debug('service advertisement exited', { code });
    });
    return {
      transport: candidate.transport,
      stop() {
        child.kill();
      },
    };
  }

  log.debug('no mDNS registration tool found; devices must use a manual IP');
  return { transport: 'none', stop() {} };
}
