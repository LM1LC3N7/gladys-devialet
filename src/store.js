// -----------------------------------------------------------------------------
// What the integration keeps across restarts, in /data (the one writable
// volume, file mode 0600): the known speakers by serial number, their address,
// who they are (system, role), and the source values they have shown (the
// "Source" dropdown only grows). No secret: the IP control API has none.
//
// The serial numbers come from the network: the speaker table has no
// prototype, and a serial that is not a plain identifier (`__proto__`,
// `constructor`...) is never a key.
// -----------------------------------------------------------------------------

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isSafeId } from './devialet/client.js';

export const emptyData = () => ({ speakers: Object.create(null) });

function sanitize(data) {
  const base = emptyData();
  if (data && typeof data === 'object' && data.speakers && typeof data.speakers === 'object') {
    for (const [serial, speaker] of Object.entries(data.speakers)) {
      if (
        isSafeId(serial) &&
        speaker &&
        typeof speaker === 'object' &&
        !Array.isArray(speaker) &&
        speaker.serial === serial
      ) {
        // A plain copy of the own fields only.
        base.speakers[serial] = Object.fromEntries(Object.entries(speaker));
      }
    }
  }
  return base;
}

export class FileStore {
  constructor({ dir = process.env.DATA_DIR || '/data', name = 'devialet.json' } = {}) {
    this.dir = dir;
    this.path = join(dir, name);
    this.corrupted = false;
  }

  /**
   * The saved data. An unreadable file is moved aside to `devialet.json.bad`
   * and `corrupted` is set, so the app says so instead of silently starting
   * over.
   */
  async load() {
    let text;
    try {
      text = await readFile(this.path, 'utf8');
    } catch {
      return emptyData();
    }
    try {
      return sanitize(JSON.parse(text));
    } catch {
      this.corrupted = true;
      const bad = `${this.path}.bad`;
      await rename(this.path, bad).catch(() => {});
      await chmod(bad, 0o600).catch(() => {});
      return emptyData();
    }
  }

  async save(data) {
    await mkdir(this.dir, { recursive: true });
    const temporary = `${this.path}.tmp`;
    await writeFile(temporary, JSON.stringify(data), { mode: 0o600 });
    await rename(temporary, this.path);
  }
}

/** For the tests. */
export class MemoryStore {
  constructor(data = emptyData()) {
    this.data = JSON.parse(JSON.stringify(data));
    this.saves = 0;
    this.corrupted = false;
  }

  async load() {
    return sanitize(JSON.parse(JSON.stringify(this.data)));
  }

  async save(data) {
    // Through JSON, as the file store: what a restart would read back.
    this.data = JSON.parse(JSON.stringify(data));
    this.saves += 1;
  }
}
