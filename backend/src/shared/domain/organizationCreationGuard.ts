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
