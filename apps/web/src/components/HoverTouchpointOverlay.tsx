// @ts-nocheck
// Removed feature: inert stub kept only so remaining references compile.
const nul: any = new Proxy(function () {}, { get: (_t, p) => (p === 'then' ? undefined : p === Symbol.toPrimitive ? () => '' : p === Symbol.iterator ? function* () {} : nul), apply: () => nul });
const pass = (p: any) => p?.children ?? null;
const none = () => null;
const no = () => false;

export const HoverOverlayPosition: any = none;
export type HoverOverlayPosition<A = any, B = any, C = any> = any;
export const HoverTouchpointOverlay: any = none;
export type HoverTouchpointOverlay<A = any, B = any, C = any> = any;
export const HoverTouchpointOverlayProps: any = none;
export type HoverTouchpointOverlayProps<A = any, B = any, C = any> = any;
export const hoverBridgeRect: any = nul;
export type hoverBridgeRect<A = any, B = any, C = any> = any;
export const placeHoverOverlay: any = nul;
export type placeHoverOverlay<A = any, B = any, C = any> = any;
