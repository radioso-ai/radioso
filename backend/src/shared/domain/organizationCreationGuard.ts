export interface OrganizationCreationReservation {
  commit(): Promise<void>;
  release(): Promise<void>;
}

export interface OrganizationCreationGuard {
  reserve(input: { userId: string }): Promise<OrganizationCreationReservation>;
}

const noopReservation: OrganizationCreationReservation = {
  async commit() {},
  async release() {},
};

/**
 * Default OSS guard: organization creation is unlimited unless an Enterprise
 * guard is registered. A shared singleton so the no-op is referenced (not
 * re-instantiated) across composition, dependency wiring, and tests.
 */
export const noopOrganizationCreationGuard: OrganizationCreationGuard = {
  async reserve() {
    return noopReservation;
  },
};
