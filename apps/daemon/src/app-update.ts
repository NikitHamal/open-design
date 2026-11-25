// Self-update from GitHub Releases. The desktop shell exits when this process exits
// cleanly, so launching the installer and exiting hands the app over to the new build.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Express } from 'express';

const REPO = 'NikitHamal/open-design';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const DOWNLOAD_PREFIX = `https://github.com/${REPO}/releases/download/`;

type UpdateStatus = { state: 'idle' | 'downloading' | 'launching' | 'error'; done: number; total: number; error?: string };
let status: UpdateStatus = { state: 'idle', done: 0, total: 0 };

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

async function checkForUpdate() {
  const current = currentVersion();
  if (!current || process.platform !== 'win32') return { enabled: false, available: false, current };
  const res = await fetch(API, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `OpenDesign/${current}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub returned ${res.status}`);
  const release = (await res.json()) as {
    tag_name?: string;
    assets?: Array<{ name: string; browser_download_url: string; size: number }>;
  };
  const tag = String(release.tag_name ?? '');
  const installer = (release.assets ?? []).find((asset) => asset.name.toLowerCase().endsWith('setup.exe'));
  return {
    enabled: true,
    current,
    latest: tag.replace(/^v/i, ''),
    available: Boolean(installer) && isNewer(tag, current),
    installerUrl: installer?.browser_download_url ?? null,
    installerName: installer?.name ?? null,
    size: installer?.size ?? 0,
  };
}

async function downloadAndInstall(url: string, name: string) {
  status = { state: 'downloading', done: 0, total: 0 };
  try {
    const res = await fetch(url, { headers: { 'User-Agent': 'OpenDesign-Updater' }, redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`Download failed: ${res.status}`);
    status.total = Number(res.headers.get('content-length') ?? 0);
    const safeName = name.replace(/[^A-Za-z0-9._-]/g, '') || 'OpenDesign-setup.exe';
    const target = path.join(os.tmpdir(), safeName);
    const body = Readable.fromWeb(res.body as never);
    body.on('data', (chunk: Buffer) => {
      status.done += chunk.length;
    });
    await pipeline(body, fs.createWriteStream(target));
    status = { ...status, state: 'launching' };
    const child = spawn(target, ['/P', '/R', '/UPDATE'], { detached: true, stdio: 'ignore', windowsHide: false });
    child.unref();
    setTimeout(() => process.exit(0), 600);
  } catch (error) {
    status = { state: 'error', done: 0, total: 0, error: error instanceof Error ? error.message : String(error) };
  }
}

export function registerAppUpdateRoutes(app: Express): void {
  app.get('/api/app-update/check', async (_req, res) => {
    try {
      res.json(await checkForUpdate());
    } catch (error) {
      res.json({ enabled: true, available: false, error: error instanceof Error ? error.message : String(error) });
    }
  });

  app.get('/api/app-update/status', (_req, res) => {
    res.json(status);
  });

  app.post('/api/app-update/install', (req, res) => {
    const { url, name } = (req.body ?? {}) as { url?: string; name?: string };
    if (typeof url !== 'string' || !url.startsWith(DOWNLOAD_PREFIX)) {
      res.status(400).json({ error: 'Untrusted update URL' });
      return;
    }
    if (status.state === 'downloading' || status.state === 'launching') {
      res.status(202).json({ ok: true });
      return;
    }
    void downloadAndInstall(url, typeof name === 'string' ? name : '');
    res.status(202).json({ ok: true });
  });
}
