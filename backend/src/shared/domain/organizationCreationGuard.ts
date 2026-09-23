export type OrganizationCoreProvisioningRequest =
  | {
      intent: "new_user";
      organizationName: string;
      email: string;
      passwordHash: string;
      emailVerifiedAt: Date | null;
    }
  | {
      intent: "existing_user";
      userId: string;
      organizationName: string;
      email: string;
      passwordHash: string;
    };

export interface OrganizationCoreProvisioningResult {
  account: {
    id: string;
    name: string;
  };
  userId: string;
  workspace: {
    id: string;
    name: string;
    publicRouteKey: string;
  };
}

export interface OrganizationCoreProvisioner {
  provision(input: OrganizationCoreProvisioningRequest): Promise<OrganizationCoreProvisioningResult>;
}

export interface OrganizationCreationReservation {
  coreProvisioner?: OrganizationCoreProvisioner;
  commit(input: { accountId: string }): Promise<void>;
  release(): Promise<void>;
}

export type OrganizationCreationRequest =
  | { intent: "signup" }
  | { intent: "additional"; userId: string };

export interface OrganizationCreationGuard {
  reserve(input: OrganizationCreationRequest): Promise<OrganizationCreationReservation>;
  isSignupAvailable(): Promise<boolean>;
}

/** Counters only: a denial's payload can carry customer content, an audit event must not. */
interface OrganizationCreationRateLimit {
  limit?: number;
  used?: number;
  periodStart?: string;
  resetAt?: string;
}

interface OrganizationCreationDenial {
  rateLimited: boolean;
  rateLimit: OrganizationCreationRateLimit | null;
}

/**
 * Reads a refusal thrown by a guard or by the provisioner it hands back. Both
 * answer the same question — may this organization be created — so the shape of
 * a "no" belongs to the contract rather than to each caller that has to name it.
 *
 * Returns null when the error is not a refusal at all but a fault, which the
 * caller names differently: "we said no" and "we could not tell" send an
 * operator to different places.
 */
export const describeOrganizationCreationDenial = (error: unknown): OrganizationCreationDenial | null => {
  const candidate = error as { statusCode?: number; code?: string; details?: unknown } | null | undefined;
  const rateLimited = candidate?.statusCode === 429 || candidate?.code === "rate_limit_exceeded";
  const refused = candidate?.statusCode === 403 || candidate?.code === "forbidden";
  if (!rateLimited && !refused) {
    return null;
  }

  const details = candidate?.details as Partial<OrganizationCreationRateLimit> | undefined;
  return {
    rateLimited,
    rateLimit: rateLimited && details
      ? {
          limit: details.limit,
          used: details.used,
          periodStart: details.periodStart,
          resetAt: details.resetAt,
        }
      : null,
  };
};

const noopReservation: OrganizationCreationReservation = {
  async commit() {},
  async release() {},
};

/**
 * Inert fallback for isolated service construction and tests. Runtime OSS
 * composition registers its database-backed bootstrap guard explicitly, while
 * Enterprise replaces that registration with its own policy.
 */
export const noopOrganizationCreationGuard: OrganizationCreationGuard = {
  async reserve() {
    return noopReservation;
  },
  async isSignupAvailable() {
    return true;
  },
};
