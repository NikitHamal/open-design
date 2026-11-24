interface NoopSpan {
  setAttribute(key: string, value: unknown): NoopSpan;
  setStatus(status: { code: number; message?: string }): NoopSpan;
  end(): void;
}

const span: NoopSpan = {
  setAttribute() {
    return span;
  },
  setStatus() {
    return span;
  },
  end() {},
};

export const SpanStatusCode = { UNSET: 0, OK: 1, ERROR: 2 } as const;

export const trace = {
  getTracer(_name: string) {
    return {
      startSpan(_name: string, _options?: unknown): NoopSpan {
        return span;
      },
    };
  },
};
