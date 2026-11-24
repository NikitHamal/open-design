// TEMPORARY. Neutral stand-ins for removed account, billing, share, campaign and
// community modules. Every call site still importing from here is dead code that
// must be deleted; this file goes away when the last import does.
/* eslint-disable @typescript-eslint/no-explicit-any */

const inert: any = new Proxy(
  {},
  {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : () => undefined),
  },
);
const noop = (..._args: any[]): any => undefined;
const no = (..._args: any[]): boolean => false;
const hook = (..._args: any[]): any => inert;

export type ShareLoginReturn = any;
export type ObservedPublicShareLink = any;
export type ObservedShareUpdateRequest = any;
export type SharePublishFailureKey = any;
export type DeepSeekV4FlashCampaignAudience = any;
export type ProjectShareReadStatus = any;

export const AMR_LOGIN_STATUS_EVENT = 'od:removed-login-status';
export const AMR_LOGIN_POLL_INTERVAL_MS = 0;
export const SHARE_TO_COMMUNITY_PROMPT = '';

export const isAmrSessionAuthenticated = no;
export const requiresAmrReauthentication = no;
export const isObservedShareFileSwitch = no;
export const shareLoginReturnMatches = no;
export const moveConfirmSkipped = noop;
export const boundedPublishProgress = (..._args: any[]): number => 0;
export const nextShareRequestNonce = (..._args: any[]): number => 0;

export const amrLoginStatusEventReason = noop;
export const notifyAmrLoginStatusChanged = noop;
export const closeAmrActivationWindowBestEffort = noop;
export const amrLoginPollOutcome = noop;
export const notifyProjectShareHistoryChanged = noop;
export const invalidateCommentSyncState = noop;
export const notifyArtifactDelivered = noop;
export const observeTestRuntimeIdentity = noop;
export const activeFileSharesBeforeDelete = (..._args: any[]): number => 0;
export const buildCommunityTemplates = (..._args: any[]): any[] => [];
export const formatDiscordPresenceCount = (..._args: any[]): string => '';
export const planBadgeTierForWorkspace = (..._args: any[]): any => null;
export const resolveEntryRailAccountFooterState = (..._args: any[]): any => null;
export const resolveDeepSeekV4FlashCampaignAudience = (..._args: any[]): any => null;

export type HomeAmrBalanceGateBlock = any;

export const useProjectShareHistoryState = hook;
export const useBatchProjectShareCount = hook;
export const useShareSourceGuard = hook;
export const useShareGuideAppUserId = hook;
export const useAfterExportShareGuide = hook;
export const useDeletedShareNotices = hook;
export const useDeepSeekV4FlashCampaignVisibility = hook;
export const useRegistrationInvite = hook;
export const useGithubStars = hook;
export const useDiscordPresence = hook;
export const useDiagnosticsExport = hook;
