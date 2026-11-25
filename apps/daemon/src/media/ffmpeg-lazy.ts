// Drop-in replacement for `@ffmpeg-installer/ffmpeg` in the packaged app. The 60 MB
// binary is not shipped; it is fetched once from the npm registry the first time the
// daemon starts and cached in the data directory. Until it lands, `path` falls back
// to whatever `ffmpeg` is on PATH.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const VERSION = '4.1.0';
const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

function cacheDir(): string {
  const base = process.env.OD_DATA_DIR?.trim() || path.join(os.homedir(), '.opendesign');
  return path.join(base, 'ffmpeg');
}

function cachedBinary(): string | null {
  const file = path.join(cacheDir(), exe);
  return fs.existsSync(file) ? file : null;
}

let pending: Promise<void> | null = null;

export function ensureFfmpeg(): Promise<void> {
  if (cachedBinary() || process.platform !== 'win32' || process.arch !== 'x64') return Promise.resolve();
  if (pending) return pending;
  pending = (async () => {
    const dir = cacheDir();
    fs.mkdirSync(dir, { recursive: true });
    const url = `https://registry.npmjs.org/@ffmpeg-installer/win32-x64/-/win32-x64-${VERSION}.tgz`;
    const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
    if (!res.ok) throw new Error(`ffmpeg download failed: ${res.status}`);
    const archive = path.join(dir, 'ffmpeg.tgz');
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    await new Promise<void>((resolve, reject) => {
      const tar = spawn('tar', ['-xzf', archive, '-C', dir, '--strip-components=1', 'package/ffmpeg.exe'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      tar.on('error', reject);
      tar.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
    });
    fs.rmSync(archive, { force: true });
  })()
    .catch(() => {})
    .finally(() => {
      pending = null;
    });
  return pending;
}

const shim = {
  get path(): string {
    return cachedBinary() ?? 'ffmpeg';
  },
  version: VERSION,
  url: '',
};

export default shim;
