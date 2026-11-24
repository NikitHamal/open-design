// @ts-nocheck
// Removed feature: inert stub kept only so remaining references compile.
const nul: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => '' : p === Symbol.iterator ? function* () {} : nul), apply: () => nul });
const pass = (p: any) => p?.children ?? null;
const none = () => null;
const no = () => false;

export const PlanBadgeSources: any = none;
export type PlanBadgeSources<A = any, B = any, C = any> = any;
export const PlanBadgeTier: any = none;
export type PlanBadgeTier<A = any, B = any, C = any> = any;
export const PlanWordmark: any = none;
export type PlanWordmark<A = any, B = any, C = any> = any;
export const planBadgeTierForLabel: any = nul;
export type planBadgeTierForLabel<A = any, B = any, C = any> = any;
export const planBadgeTierForWorkspace: any = nul;
export type planBadgeTierForWorkspace<A = any, B = any, C = any> = any;
