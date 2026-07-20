import { forbidden } from "../../../shared/domain/errors.js";
import type {
  OrganizationCoreProvisioner,
  OrganizationCreationGuard,
  OrganizationCreationRequest,
  OrganizationCreationReservation,
} from "../../../shared/domain/organizationCreationGuard.js";

export interface OssOrganizationBootstrapPort extends OrganizationCoreProvisioner {
  isAvailable(): Promise<boolean>;
}

export const registrationClosed = () => forbidden(
  "Registration is closed. Ask an organization owner for an invitation.",
);

export class OssOrganizationCreationGuard implements OrganizationCreationGuard {
  constructor(private readonly bootstrap: OssOrganizationBootstrapPort) {}

  async reserve(input: OrganizationCreationRequest): Promise<OrganizationCreationReservation> {
    if (input.intent === "additional") {
      throw forbidden("Additional organizations require Enterprise Edition.");
    }

    return new OssOrganizationCreationReservation(this.bootstrap);
  }

  async isSignupAvailable(): Promise<boolean> {
    return this.bootstrap.isAvailable();
  }
}

class OssOrganizationCreationReservation implements OrganizationCreationReservation {
  constructor(readonly coreProvisioner: OrganizationCoreProvisioner) {}

  async commit(): Promise<void> {}

  async release(): Promise<void> {}
}
