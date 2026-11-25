// Hard egress guard: this build never talks to vendor telemetry, attribution, cloud or
// marketplace hosts, regardless of what legacy code paths try to do.
const BLOCKED = [
  /(^|\.)open-design\.ai$/i,
  /(^|\.)opendesign\.dev$/i,
  /(^|\.)posthog\.com$/i,
  /(^|\.)sentry\.io$/i,
  /(^|\.)segment\.io$/i,
  /(^|\.)mixpanel\.com$/i,
  /(^|\.)amplitude\.com$/i,
  /(^|\.)datadoghq\.com$/i,
];

function hostOf(input: unknown): string | null {
  try {
    if (typeof input === 'string') return new URL(input).hostname;
    if (input instanceof URL) return input.hostname;
    const url = (input as { url?: string } | null)?.url;
    return url ? new URL(url).hostname : null;
  } catch {
    return null;
  }
}

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const host = hostOf(input);
  if (host && BLOCKED.some((re) => re.test(host))) {
    return Promise.reject(new TypeError(`network egress to ${host} is disabled`));
  }
  return nativeFetch(input, init);
}) as typeof fetch;

export {};
