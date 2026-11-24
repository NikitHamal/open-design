export class PostHog {
  constructor(_key: string, _options?: unknown) {}
  on(_event: string, _listener: (...args: unknown[]) => void): void {}
  capture(_event: Record<string, unknown>): void {}
  groupIdentify(_event: Record<string, unknown>): void {}
  async shutdown(): Promise<void> {}
}
