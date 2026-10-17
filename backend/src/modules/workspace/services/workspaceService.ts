import type { AccountMembershipRepositoryPort } from "../../../db/repositories/accountMembershipRepository.js";
import type { WorkspaceRecord, WorkspaceRepositoryPort } from "../../../db/repositories/workspaceRepository.js";
import type { AuditService } from "../../audit/contracts/index.js";
import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type {
  VendorHeldConversationDataEraser,
  VendorHeldConversationDataErasure,
} from "../../../shared/domain/vendorHeldConversationData.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import { createWorkspacePublicRouteKey } from "../domain/publicRouteKey.js";
import {
  transactionalLifecycleAuditEvent,
  type PersonalCredentialLifecyclePort,
} from "../../machineAccess/public.js";

/** A narrow outbound signal; workspace lifecycle does not know credential storage. */
export interface WorkspacePersonalCredentialTerminationPort {
  endWorkspace(input: { accountId: string; workspaceId: string; actorUserId?: string | null }): Promise<void>;
}

export class WorkspaceService {
  constructor(
    private readonly workspaceRepository: WorkspaceRepositoryPort,
    private readonly auditService: AuditService,
    private readonly accountMembershipRepository?: AccountMembershipRepositoryPort,
    private readonly personalCredentialTermination?: WorkspacePersonalCredentialTerminationPort,
    private readonly personalCredentialLifecycle?: Pick<PersonalCredentialLifecyclePort, "deleteWorkspace">,
    /** What vendors hold for the workspace's conversations, erased after a deletion went through. */
    private readonly vendorHeld?: { eraser: VendorHeldConversationDataEraser; logger: Pick<AppLogger, "warn"> },

  ) {}

  private async createWorkspaceWithPublicRouteKey(accountId: string, name: string): Promise<WorkspaceRecord> {
    let attempts = 0;

    while (attempts < 5) {
      try {
        return await this.workspaceRepository.create(accountId, name, createWorkspacePublicRouteKey(name));
      } catch (error) {
        attempts += 1;
        if (!(error instanceof Error) || !/public_route_key/i.test(error.message) || attempts >= 5) {
          throw error;
        }
      }
    }

    throw new Error("Failed to generate unique workspace route key");
  }

  async create(accountId: string, name: string): Promise<WorkspaceRecord> {
    const trimmedName = name.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw badRequest("Workspace name must be between 1 and 100 characters");
    }

    return this.createWorkspaceWithPublicRouteKey(accountId, trimmedName);
  }

  async createDefault(accountId: string): Promise<WorkspaceRecord> {
    const existing = await this.workspaceRepository.listByAccountId(accountId);
    if (existing.length > 0) {
      return existing.find((workspace) => workspace.name === "Default") ?? existing[0];
    }

    return this.createWorkspaceWithPublicRouteKey(accountId, "Default");
  }

  async resolveLoginWorkspace(accountId: string, preferredWorkspaceId?: string | null): Promise<WorkspaceRecord> {
    const existing = await this.workspaceRepository.listByAccountId(accountId);
    if (existing.length === 0) {
      return this.createWorkspaceWithPublicRouteKey(accountId, "Default");
    }

    if (preferredWorkspaceId) {
      const preferred = existing.find((workspace) => workspace.id === preferredWorkspaceId);
      if (preferred) {
        return preferred;
      }
    }

    return existing.find((workspace) => workspace.name === "Default") ?? existing.at(-1)!;
  }

  async listForAccount(accountId: string): Promise<WorkspaceRecord[]> {
    return this.workspaceRepository.listByAccountId(accountId);
  }

  async validateOwnership(workspaceId: string, accountId: string): Promise<WorkspaceRecord> {
    const workspace = await this.workspaceRepository.findByIdAndAccountId(workspaceId, accountId);
    if (!workspace) {
      throw notFound("Workspace not found");
    }

    return workspace;
  }

  async findByPublicRouteKey(publicRouteKey: string): Promise<WorkspaceRecord | null> {
    return this.workspaceRepository.findByPublicRouteKey(publicRouteKey.trim());
  }

  async resolveAccessibleByPublicRouteKey(userId: string, publicRouteKey: string): Promise<WorkspaceRecord> {
    const workspace = await this.findByPublicRouteKey(publicRouteKey);
    if (!workspace || !this.accountMembershipRepository) {
      throw notFound("Workspace not found");
    }

    const membership = await this.accountMembershipRepository.findActiveByAccountAndUser(workspace.accountId, userId);
    if (!membership) {
      throw notFound("Workspace not found");
    }

    return workspace;
  }

  async rename(workspaceId: string, accountId: string, newName: string): Promise<WorkspaceRecord> {
    const workspace = await this.validateOwnership(workspaceId, accountId);
    const trimmedName = newName.trim();
    if (!trimmedName || trimmedName.length > 100) {
      throw badRequest("Workspace name must be between 1 and 100 characters");
    }

    const updated = await this.workspaceRepository.updateName(workspaceId, accountId, trimmedName);

    await this.auditService.record({
      accountId,
      workspaceId,
      eventType: "workspace.renamed",
      eventStatus: "success",
      metadata: { previousName: workspace.name, newName: trimmedName },
    });

    return updated;
  }

  async delete(workspaceId: string, accountId: string, actorUserId?: string): Promise<void> {
    const workspace = await this.validateOwnership(workspaceId, accountId);

    const count = await this.workspaceRepository.countByAccountId(accountId);
    if (count <= 1) {
      throw badRequest("Cannot delete the last workspace");
    }

    const auditEvent = transactionalLifecycleAuditEvent({
      accountId,
      workspaceId: null,
      eventType: "workspace.deleted",
      eventStatus: "success",
      metadata: { deletedWorkspaceId: workspaceId, deletedWorkspaceName: workspace.name },
    });
    // Read while the workspace's conversations and vendor keys still exist; the cascade takes both.
    const vendorHeld = await this.prepareVendorHeldErasure({
      account: { id: accountId, deleted: false },
      scopes: [{ kind: "workspace", workspaceId }],
    });
    if (this.personalCredentialLifecycle) {
      const deleted = await this.personalCredentialLifecycle.deleteWorkspace({
        accountId,
        workspaceId,
        actorUserId,
        auditEvent,
      });
      if (!deleted) throw notFound("Workspace not found");
      this.auditService.logRecorded?.(auditEvent);
      await vendorHeld.erase();
      return;
    }

    await this.personalCredentialTermination?.endWorkspace({ accountId, workspaceId, actorUserId });

    await this.auditService.record(auditEvent);

    await this.workspaceRepository.deleteByIdAndAccountId(workspaceId, accountId);
    await vendorHeld.erase();
  }

  /**
   * Prepares erasing what vendors hold for every workspace of an account about to be deleted, while
   * the workspaces still exist: one erasure, its workspaces in order under one budget.
   * `afterDeletion` runs once the account is gone, and never rejects.
   */
  async prepareAccountDeletion(accountId: string): Promise<{ afterDeletion(): Promise<void> }> {
    if (!this.vendorHeld) return { afterDeletion: async () => undefined };
    let workspaces: WorkspaceRecord[];
    try {
      workspaces = await this.workspaceRepository.listByAccountId(accountId);
    } catch (error) {
      this.vendorHeld.logger.warn(
        { accountId, errorClass: error instanceof Error ? error.name : typeof error },
        "Workspaces whose vendor-held data to erase could not be read",
      );
      return { afterDeletion: async () => undefined };
    }
    const prepared = await this.prepareVendorHeldErasure({
      account: { id: accountId, deleted: true },
      scopes: workspaces.map((workspace) => ({ kind: "workspace", workspaceId: workspace.id })),
    });
    return { afterDeletion: () => prepared.erase() };
  }

  /** Never rejects: data a vendor holds that cannot be read is left there, and its eraser says so. */
  private async prepareVendorHeldErasure(erasure: VendorHeldConversationDataErasure): Promise<{ erase(): Promise<void> }> {
    const nothing = { erase: async () => undefined };
    if (!this.vendorHeld) return nothing;
    try {
      const prepared = await this.vendorHeld.eraser.prepare(erasure);
      return { erase: () => prepared.erase().catch(() => undefined) };
    } catch (error) {
      this.vendorHeld.logger.warn(
        { accountId: erasure.account?.id ?? null, errorClass: error instanceof Error ? error.name : typeof error },
        "Vendor-held data to erase could not be read",
      );
      return nothing;
    }
  }
}
