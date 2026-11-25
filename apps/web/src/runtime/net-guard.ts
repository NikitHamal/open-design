// Browser-side egress guard: block telemetry/cloud hosts for fetch, XHR and beacons.
const BLOCKED = [
  /(^|\.)open-design\.ai$/i,
  /(^|\.)opendesign\.dev$/i,
  /(^|\.)posthog\.com$/i,
  /(^|\.)sentry\.io$/i,
  /(^|\.)segment\.io$/i,
  /(^|\.)mixpanel\.com$/i,
  /(^|\.)amplitude\.com$/i,
];

function blocked(input: unknown): boolean {
  try {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : (input as Request)?.url;
    if (!raw) return false;
    const host = new URL(raw, window.location.href).hostname;
    return BLOCKED.some((re) => re.test(host));
  } catch {
    return false;
  }
}

export function installNetGuard(): void {
  if (typeof window === 'undefined' || (window as unknown as { __odNetGuard?: boolean }).__odNetGuard) return;
  (window as unknown as { __odNetGuard?: boolean }).__odNetGuard = true;

  const nativeFetch = window.fetch.bind(window);
  window.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    blocked(input) ? Promise.reject(new TypeError('network egress disabled')) : nativeFetch(input, init)) as typeof fetch;

  const nativeOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    if (blocked(url)) throw new DOMException('network egress disabled', 'NetworkError');
    return (nativeOpen as (...args: unknown[]) => void).call(this, method, url, ...rest);
  } as typeof XMLHttpRequest.prototype.open;

  const nativeBeacon = navigator.sendBeacon?.bind(navigator);
  if (nativeBeacon) {
    navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => (blocked(url) ? false : nativeBeacon(url, data));
  }
}
