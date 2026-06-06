import type { AccessGrant, AccessGrantService } from "./public.js";

export interface PublicLaunchLifecycle {
  lastUsedAt: string | null;
}

export const presentPublicLaunchLifecycle = (grant: AccessGrant | null): PublicLaunchLifecycle => {
  if (!grant) {
    return { lastUsedAt: null };
  }

  return {
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
  };
};

export const resolvePublicLaunchLifecycle = async (
  token: string | null,
  accessGrantService?: Pick<AccessGrantService, "resolvePublicLaunchGrant">,
): Promise<PublicLaunchLifecycle> => {
  if (!token || !accessGrantService) {
    return { lastUsedAt: null };
  }

  const grant = await accessGrantService.resolvePublicLaunchGrant(token);
  return presentPublicLaunchLifecycle(grant);
};
