import { AppsError } from "../domain/errors.js";

export interface AppRuntimeProvisioningRequest {
  readonly installationId: string;
  readonly releaseId: string;
  readonly appId: string;
  readonly version: string;
}

/**
 * How an installation's App process comes into existence. The Apps domain knows only
 * this shape; the local-process provider, and later a sandbox provider, live behind it.
 */
export interface AppRuntimeProvisioningPort {
  provision(request: AppRuntimeProvisioningRequest): Promise<void>;
  deprovision(request: { readonly installationId: string }): Promise<void>;
}

/**
 * The default when no runtime provider is configured. Radioso must build and run with
 * the hosted App runtime absent (FR-075), so this fails the one step that needs a
 * runtime with a reason an operator can act on, rather than the platform refusing to
 * start or an installation hanging in `provisioning`.
 */
export const createUnavailableAppRuntimeProvisioning = (): AppRuntimeProvisioningPort => ({
  provision: async () => {
    throw new AppsError(
      "runtime_unavailable",
      "No App runtime provider is configured, so this installation cannot be provisioned. Configure a runtime provider and retry the installation.",
    );
  },
  deprovision: async () => {},
});
