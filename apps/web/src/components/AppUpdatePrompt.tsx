'use client';

import { useEffect, useRef, useState } from 'react';

type CheckResult = {
  enabled?: boolean;
  available?: boolean;
  latest?: string;
  installerUrl?: string | null;
  installerName?: string | null;
};

type Status = { state: 'idle' | 'downloading' | 'launching' | 'error'; done: number; total: number };

const RECHECK_MS = 6 * 60 * 60 * 1000;

export function AppUpdatePrompt() {
  const [update, setUpdate] = useState<CheckResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [status, setStatus] = useState<Status>({ state: 'idle', done: 0, total: 0 });
  const timer = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      try {
        const res = await fetch('/api/app-update/check');
        const data = (await res.json()) as CheckResult;
        if (!cancelled && data.available && data.installerUrl) setUpdate(data);
      } catch {
        /* offline: try again later */
      }
    };
    const first = window.setTimeout(check, 4000);
    const every = window.setInterval(check, RECHECK_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(first);
      window.clearInterval(every);
    };
  }, []);

  useEffect(() => () => {
    if (timer.current) window.clearInterval(timer.current);
  }, []);

  if (!update || dismissed) return null;

  const busy = status.state === 'downloading' || status.state === 'launching';
  const percent = status.total > 0 ? Math.min(100, Math.round((status.done / status.total) * 100)) : null;

  const install = async () => {
    setStatus({ state: 'downloading', done: 0, total: 0 });
    await fetch('/api/app-update/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: update.installerUrl, name: update.installerName }),
    }).catch(() => undefined);
    timer.current = window.setInterval(async () => {
      try {
        const res = await fetch('/api/app-update/status');
        setStatus((await res.json()) as Status);
      } catch {
        /* daemon exits while the installer takes over */
      }
    }, 500);
  };

  return (
    <div className="od-update" role="status">
      <span className="od-update__text">
        {status.state === 'error' ? 'Update failed' : `Update ${update.latest ?? ''}`}
        {busy && percent !== null ? ` · ${percent}%` : ''}
      </span>
      {busy ? null : (
        <button type="button" className="od-update__btn od-update__btn--primary" onClick={install}>
          {status.state === 'error' ? 'Retry' : 'Install'}
        </button>
      )}
      {busy ? null : (
        <button type="button" className="od-update__btn" onClick={() => setDismissed(true)}>
          Later
        </button>
      )}
    </div>
  );
}
