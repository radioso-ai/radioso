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

export class NoopOrganizationCreationGuard implements OrganizationCreationGuard {
  async reserve(_input: { userId: string }): Promise<OrganizationCreationReservation> {
    return noopReservation;
  }
}
