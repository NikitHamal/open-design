// @ts-nocheck
// Removed feature: inert stub kept only so remaining references compile.
const nul: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => '' : p === Symbol.iterator ? function* () {} : nul), apply: () => nul });
const pass = (p: any) => p?.children ?? null;
const none = () => null;
const no = () => false;

export const HomeInviteSurface: any = none;
export type HomeInviteSurface<A = any, B = any, C = any> = any;
export const HomeInviteTrigger: any = none;
export type HomeInviteTrigger<A = any, B = any, C = any> = any;
export const WORKSPACE_INVITES_SENT: any = nul;
export type WORKSPACE_INVITES_SENT<A = any, B = any, C = any> = any;
