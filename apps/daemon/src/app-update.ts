// Self-update from GitHub Releases.
//
// Flow: the daemon downloads and verifies the installer, records its path in
// <data>/updates/pending.json and exits with UPDATE_EXIT_CODE. The desktop shell (which owns
// the window and the daemon process) sees that exit code, launches the installer detached from
// the daemon tree, and quits so the installer can replace the files. Launching from the shell
// instead of from this process is what keeps the installer alive while the app shuts down.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import type { Express } from 'express';

const REPO = 'NikitHamal/open-design';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const UPDATE_EXIT_CODE = 42;

type UpdateStatus = {
  state: 'idle' | 'downloading' | 'verifying' | 'launching' | 'error';
  done: number;
  total: number;
  error?: string;
};
let status: UpdateStatus = { state: 'idle', done: 0, total: 0 };

type ReleaseInfo = {
  enabled: boolean;
  available: boolean;
  current: string;
  latest?: string;
  installerUrl?: string | null;
  installerName?: string | null;
  size?: number;
  sha256?: string | null;
};

function parseVersion(value: string): number[] {
  return value
    .trim()
    .replace(/^v/i, '')
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
}

function isNewer(latest: string, current: string): boolean {
  const a = parseVersion(latest);
  const b = parseVersion(current);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

function currentVersion(): string {
  return process.env.OD_APP_VERSION?.trim() || '';
}

function updatesDir(): string {
  const base = process.env.OD_DATA_DIR?.trim() || path.join(os.tmpdir(), 'opendesign');
  const dir = path.join(base, 'updates');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function readShellError(): string | undefined {
  try {
    const file = path.join(updatesDir(), 'last-error.txt');
    if (!fs.existsSync(file)) return undefined;
    const text = fs.readFileSync(file, 'utf8').trim();
    fs.rmSync(file, { force: true });
    return text || undefined;
  } catch {
    return undefined;
  }
}

async function checkForUpdate(): Promise<ReleaseInfo> {
  const current = currentVersion();
  if (!current || process.platform !== 'win32') return { enabled: false, available: false, current };
  const res = await fetch(API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `OpenDesign/${current}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const release = (await res.json()) as {
    tag_name?: string;
    assets?: Array<{ name: string; browser_download_url: string; size: number; digest?: string | null }>;
  };
  const tag = String(release.tag_name ?? '');
  const installer = (release.assets ?? []).find((asset) => asset.name.toLowerCase().endsWith('setup.exe'));
  const digest = installer?.digest?.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null;
  return {
    enabled: true,
    current,
    latest: tag.replace(/^v/i, ''),
    available: Boolean(installer) && isNewer(tag, current),
    installerUrl: installer?.browser_download_url ?? null,
    installerName: installer?.name ?? null,
    size: installer?.size ?? 0,
    sha256: digest,
  };
}

async function downloadInstaller(info: ReleaseInfo): Promise<string> {
  const res = await fetch(info.installerUrl as string, {
    headers: { 'User-Agent': `OpenDesign/${info.current}` },
    redirect: 'follow',
  });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const headerSize = Number(res.headers.get('content-length') ?? 0);
  const expected = info.size || headerSize;
  status.total = expected || headerSize;

  const safeName = (info.installerName ?? '').replace(/[^A-Za-z0-9._-]/g, '') || 'OpenDesign-setup.exe';
  const dir = updatesDir();
  for (const stale of fs.readdirSync(dir)) {
    if (/setup\.exe(\.part)?$/i.test(stale)) fs.rmSync(path.join(dir, stale), { force: true });
  }
  const partial = path.join(dir, `${safeName}.part`);
  const target = path.join(dir, safeName);

  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(partial);
  const closed = new Promise<void>((resolve, reject) => {
    out.once('close', resolve);
    out.once('error', reject);
  });
  let written = 0;
  try {
    for await (const chunk of Readable.fromWeb(res.body as never) as AsyncIterable<Buffer>) {
      hash.update(chunk);
      written += chunk.length;
      status.done = written;
      if (!out.write(chunk)) await new Promise<void>((resolve) => out.once('drain', resolve));
    }
    out.end();
    await closed; // the file handle must be fully released before Windows will run it
  } catch (error) {
    out.destroy();
    fs.rmSync(partial, { force: true });
    throw error;
  }

  status = { state: 'verifying', done: written, total: status.total };
  if (expected && written !== expected) {
    fs.rmSync(partial, { force: true });
    throw new Error(`Download incomplete (${written} of ${expected} bytes)`);
  }
  if (info.sha256 && hash.digest('hex') !== info.sha256) {
    fs.rmSync(partial, { force: true });
    throw new Error('Installer checksum mismatch');
  }
  if (written < 1_000_000) {
    fs.rmSync(partial, { force: true });
    throw new Error('Installer is unexpectedly small');
  }
  fs.renameSync(partial, target);
  return target;
}

async function runUpdate(): Promise<void> {
  status = { state: 'downloading', done: 0, total: 0 };
  try {
    const info = await checkForUpdate();
    if (!info.available || !info.installerUrl) throw new Error('No newer release is available');
    const installer = await downloadInstaller(info);
    fs.writeFileSync(path.join(updatesDir(), 'pending.json'), installer, 'utf8');
    status = { state: 'launching', done: status.done, total: status.total };
    // Give the UI one poll to show the hand-over, then let the shell take over.
    setTimeout(() => process.exit(UPDATE_EXIT_CODE), 1200);
  } catch (error) {
    status = { state: 'error', done: 0, total: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerAppUpdateRoutes(app: Express): void {
  app.get('/api/app-update/check', async (_req, res) => {
    try {
      const info = await checkForUpdate();
      res.json({ ...info, sha256: undefined });
    } catch (error) {
      res.json({ enabled: true, available: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/app-update/status', (_req, res) => {
    if (status.state === 'idle') {
      const shellError = readShellError();
      if (shellError) status = { state: 'error', done: 0, total: 0, error: shellError };
    }
    res.json(status);
  });

  app.post('/api/app-update/install', (_req, res) => {
    if (status.state === 'downloading' || status.state === 'verifying' || status.state === 'launching') {
      res.status(202).json({ ok: true });
      return;
    }
    void runUpdate();
    res.status(202).json({ ok: true });
  });
}
