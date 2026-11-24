/* eslint-disable @typescript-eslint/no-explicit-any */
export type PostHog = any;
export type CaptureResult = any;

const noop = () => undefined;

const posthog: any = new Proxy(
  {},
  { get: () => noop },
);

export default posthog;
