import { randomBytes } from "node:crypto";

import { notFound } from "../../../shared/domain/errors.js";
import type { AuditPort } from "../../audit/contracts/index.js";
import { requireAppAdministration } from "../domain/authorization.js";
import { buildAppConnectionBinding } from "../domain/connectionBinding.js";
import { AppsError } from "../domain/errors.js";
import type { AppConnectionRecord } from "../domain/records.js";
import { admittedManifestOf } from "../domain/releaseAdmission.js";
import type { AppOperatorAuthorizationPort, AppOperatorPrincipal } from "../ports/operatorAuthorization.js";
import type { AppSecretCipherPort } from "../ports/secretCipher.js";
import type { AppConnectionRepositoryPort } from "../repositories/appConnectionRepository.js";
import type { AppInstallationRepositoryPort } from "../repositories/appInstallationRepository.js";
import type { AppLifecycleOperationRepositoryPort } from "../repositories/appLifecycleOperationRepository.js";
import type { AppReleaseRepositoryPort } from "../repositories/appReleaseRepository.js";
import type { AppsUnitOfWork } from "../repositories/appsUnitOfWork.js";

interface BindAppConnectionRequest {
  readonly workspaceId: string;
  readonly installationId: string;
  readonly slotId: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly expectedVersion: number;
  readonly principal: AppOperatorPrincipal;
}

interface BindAppConnectionResult {
  readonly connection: AppConnectionRecord;
  /**
   * Present only on the response that mints it, and only for a `generated_secret` slot.
   * There is no read path that returns it again.
   */
  readonly generatedSecret: string | null;
}

interface AppConnectionServiceDependencies {
  readonly installations: AppInstallationRepositoryPort;
  readonly releases: AppReleaseRepositoryPort;
  readonly connections: AppConnectionRepositoryPort;
  readonly operations: AppLifecycleOperationRepositoryPort;
  readonly unitOfWork: AppsUnitOfWork;
  readonly cipher: AppSecretCipherPort;
  readonly authorization: AppOperatorAuthorizationPort;
  readonly audit: Pick<AuditPort, "record">;
}

export class AppConnectionService {
  constructor(private readonly dependencies: AppConnectionServiceDependencies) {}

  /**
   * Write-only: values go in, an identifier and the slot's non-sensitive fields come out.
   *
   * Binding is a mutation of the installation, so it carries the version the operator
   * read and refuses while a lifecycle operation is mid-flight. Both matter for the same
   * reason: a bind that lands during a removal would put live ciphertext back onto an
   * installation whose credentials were already marked for deletion.
   */
  async bind(request: BindAppConnectionRequest): Promise<BindAppConnectionResult> {
    await requireAppAdministration(this.dependencies.authorization, request.principal, request.workspaceId);

    const installation = await this.dependencies.installations.findById(request.workspaceId, request.installationId);
    if (!installation) throw notFound("App installation not found");
    if (installation.state === "removing" || installation.state === "removed") {
      throw new AppsError("installation_removing", "This installation is being removed, so its connections cannot be changed.", {
        state: installation.state,
      });
    }

    const inFlight = await this.dependencies.operations.findActiveByInstallation(installation.id);
    if (inFlight) {
      throw new AppsError(
        "operation_in_progress",
        "A lifecycle operation is running for this installation, so its connections cannot be changed right now.",
        { operationId: inFlight.id, operationKind: inFlight.kind },
      );
    }

    const releaseId = installation.activeReleaseId ?? installation.candidateReleaseId;
    const release = releaseId ? await this.dependencies.releases.findById(releaseId) : null;
    if (!release) throw notFound("App release not found");
    // Whether a field is sensitive is a rule, so it is read from the admitted manifest
    // rather than from whatever the release row happens to hold.
    const manifest = admittedManifestOf(release);

    const slot = manifest.connections.slots.find((candidate) => candidate.id === request.slotId);
    if (!slot) {
      throw new AppsError("connection_slot_unknown", "This release declares no such connection.", {
        slotId: request.slotId,
      });
    }

    const existing = (await this.dependencies.connections.listByInstallation(installation.id))
      .some((connection) => connection.slotId === slot.id);

    const binding = buildAppConnectionBinding({
      slot,
      values: request.values,
      generateSecret: (byteLength) => randomBytes(byteLength).toString("base64url"),
    });
    const secretCiphertext = binding.secret === null ? null : this.dependencies.cipher.encrypt(binding.secret);

    const connection = await this.dependencies.unitOfWork.run(async (repositories) => {
      const claimed = await repositories.installations.update(
        request.workspaceId,
        installation.id,
        request.expectedVersion,
        {},
      );
      if (!claimed) {
        throw new AppsError("plan_stale", "This installation changed since it was read.", {
          cause: "version_mismatch",
        });
      }
      return repositories.connections.bind({
        installationId: installation.id,
        slotId: binding.slotId,
        kind: binding.kind,
        publicFields: binding.publicFields,
        secretCiphertext,
        encryptionKeyId: secretCiphertext === null ? null : this.dependencies.cipher.keyId,
      });
    });

    await this.dependencies.audit.record({
      accountId: request.principal.accountId,
      workspaceId: request.workspaceId,
      eventType: existing ? "app.connection.rotated" : "app.connection.bound",
      eventStatus: "success",
      metadata: {
        installationId: installation.id,
        appId: installation.appId,
        connectionId: connection.id,
        slotId: connection.slotId,
        slotKind: connection.kind,
        actorUserId: request.principal.userId,
        // Field *names* the operator filled in. Never a value.
        publicFieldKeys: Object.keys(connection.publicFields),
        hasSecret: connection.hasSecret,
      },
    });

    return { connection, generatedSecret: binding.generatedSecret };
  }

  list(installationId: string): Promise<AppConnectionRecord[]> {
    return this.dependencies.connections.listByInstallation(installationId);
  }
}
