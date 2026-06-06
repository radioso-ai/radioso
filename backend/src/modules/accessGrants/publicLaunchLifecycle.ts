import type { AccessGrant, AccessGrantService } from "./public.js";

export interface PublicLaunchLifecycle {
  lastUsedAt: string | null;
  status: "active" | "revoked" | null;
}

export const presentPublicLaunchLifecycle = (grant: AccessGrant | null): PublicLaunchLifecycle => {
  if (!grant) {
    return { lastUsedAt: null, status: null };
  }

  return {
    lastUsedAt: grant.lastUsedAt?.toISOString() ?? null,
    status: grant.revokedAt ? "revoked" : "active",
  };
};

export const resolvePublicLaunchLifecycle = async (
  token: string | null,
  accessGrantService?: Pick<AccessGrantService, "resolvePublicLaunchGrant">,
): Promise<PublicLaunchLifecycle> => {
  if (!token || !accessGrantService) {
    return { lastUsedAt: null, status: null };
  }

  const grant = await accessGrantService.resolvePublicLaunchGrant(token);
  return presentPublicLaunchLifecycle(grant);
};
