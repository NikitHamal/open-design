// @ts-nocheck
// Removed feature: inert stub kept only so remaining references compile.
const nul: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => '' : p === Symbol.iterator ? function* () {} : nul), apply: () => nul });
const pass = (p: any) => p?.children ?? null;
const none = () => null;
const no = () => false;

export const AmrBalanceDialog: any = none;
export type AmrBalanceDialog<A = any, B = any, C = any> = any;
export const WALLET_WATCH_INTERVAL_MS: any = nul;
export type WALLET_WATCH_INTERVAL_MS<A = any, B = any, C = any> = any;
export const WALLET_WATCH_TIMEOUT_MS: any = nul;
export type WALLET_WATCH_TIMEOUT_MS<A = any, B = any, C = any> = any;
