// @ts-nocheck
// Removed feature: inert stub kept only so remaining references compile.
const nul: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => '' : p === Symbol.iterator ? function* () {} : nul), apply: () => nul });
const pass = (p: any) => p?.children ?? null;
const none = () => null;
const no = () => false;

export const MOVE_CONFIRM_SKIP_KEY: any = nul;
export type MOVE_CONFIRM_SKIP_KEY<A = any, B = any, C = any> = any;
export const MoveToTeamConfirmDialog: any = none;
export type MoveToTeamConfirmDialog<A = any, B = any, C = any> = any;
export const moveConfirmSkipped: any = nul;
export type moveConfirmSkipped<A = any, B = any, C = any> = any;
