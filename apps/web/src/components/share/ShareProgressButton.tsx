// @ts-nocheck
// Removed feature: inert stub kept only so remaining references compile.
const nul: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => '' : p === Symbol.iterator ? function* () {} : nul), apply: () => nul });
const pass = (p: any) => p?.children ?? null;
const none = () => null;
const no = () => false;

export const ShareProgressButton: any = none;
export type ShareProgressButton<A = any, B = any, C = any> = any;
export const ShareProgressButtonProps: any = none;
export type ShareProgressButtonProps<A = any, B = any, C = any> = any;
