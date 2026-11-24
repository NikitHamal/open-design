// @ts-nocheck
// Removed feature: inert stub kept only so remaining references compile.
const nul: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => '' : p === Symbol.iterator ? function* () {} : nul), apply: () => nul });
const pass = (p: any) => p?.children ?? null;
const none = () => null;
const no = () => false;

export const AmrAccountControl: any = none;
export type AmrAccountControl<A = any, B = any, C = any> = any;
export const AmrAccountControlProps: any = none;
export type AmrAccountControlProps<A = any, B = any, C = any> = any;
export const AmrAccountControlStatus: any = none;
export type AmrAccountControlStatus<A = any, B = any, C = any> = any;
export const AmrLoginPill: any = none;
export type AmrLoginPill<A = any, B = any, C = any> = any;
export const closeAmrActivationWindowBestEffort: any = nul;
export type closeAmrActivationWindowBestEffort<A = any, B = any, C = any> = any;
