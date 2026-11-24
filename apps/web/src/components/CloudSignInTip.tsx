// @ts-nocheck
// Removed feature: inert stub kept only so remaining references compile.
const nul: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => '' : p === Symbol.iterator ? function* () {} : nul), apply: () => nul });
const pass = (p: any) => p?.children ?? null;
const none = () => null;
const no = () => false;

export const CloudSignInTip: any = none;
export type CloudSignInTip<A = any, B = any, C = any> = any;
export const RailAccountRecoveryTip: any = none;
export type RailAccountRecoveryTip<A = any, B = any, C = any> = any;
export const RailAccountSyncTip: any = none;
export type RailAccountSyncTip<A = any, B = any, C = any> = any;
export const resetCloudSignInTipDismissal: any = nul;
export type resetCloudSignInTipDismissal<A = any, B = any, C = any> = any;
