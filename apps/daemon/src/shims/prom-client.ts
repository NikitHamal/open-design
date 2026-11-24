class Metric {
  constructor(_config?: unknown) {}
  inc(..._args: unknown[]): void {}
  dec(..._args: unknown[]): void {}
  set(..._args: unknown[]): void {}
  observe(..._args: unknown[]): void {}
  reset(): void {}
  labels(..._args: unknown[]): this {
    return this;
  }
  startTimer(..._args: unknown[]): (..._labels: unknown[]) => number {
    return () => 0;
  }
}

export class Counter extends Metric {}
export class Gauge extends Metric {}
export class Histogram extends Metric {}

export const register = {
  contentType: 'text/plain; version=0.0.4; charset=utf-8',
  async metrics(): Promise<string> {
    return '';
  },
  clear(): void {},
};
