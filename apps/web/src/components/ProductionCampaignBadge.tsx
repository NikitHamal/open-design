// @ts-nocheck
// Removed feature: inert stub kept only so remaining references compile.
const nul: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => '' : p === Symbol.iterator ? function* () {} : nul), apply: () => nul });
const pass = (p: any) => p?.children ?? null;
const none = () => null;
const no = () => false;

export const ProductionCampaignBadge: any = none;
export type ProductionCampaignBadge<A = any, B = any, C = any> = any;
export const canRenderProductionCampaignBadge: any = no;
export type canRenderProductionCampaignBadge<A = any, B = any, C = any> = any;
