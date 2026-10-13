import type { WorkspaceSetupStateRepositoryPort, WorkspaceSetupStateRecord, WorkspaceSetupStep } from "../../src/db/repositories/workspaceSetupStateRepository.js";

export class InMemoryWorkspaceSetupStateRepository implements WorkspaceSetupStateRepositoryPort {
  private readonly states = new Map<string, WorkspaceSetupStateRecord>();

  async get(workspaceId: string): Promise<WorkspaceSetupStateRecord> {
    const current = this.states.get(workspaceId) ?? { workspaceId, purpose: null, dismissedAt: null, notifyReceiptConfirmedAt: null, skippedSteps: [] };
    this.states.set(workspaceId, current);
    return current;
  }

  async update(workspaceId: string, input: { purpose?: string | null; dismissed?: boolean; notifyReceiptConfirmed?: boolean; skippedSteps?: WorkspaceSetupStep[] }): Promise<WorkspaceSetupStateRecord> {
    const current = await this.get(workspaceId);
    const next = {
      ...current,
      ...(input.purpose !== undefined ? { purpose: input.purpose } : {}),
      ...(input.dismissed !== undefined ? { dismissedAt: input.dismissed ? new Date() : null } : {}),
      ...(input.notifyReceiptConfirmed !== undefined ? { notifyReceiptConfirmedAt: input.notifyReceiptConfirmed ? new Date() : null } : {}),
      ...(input.skippedSteps !== undefined ? { skippedSteps: input.skippedSteps } : {}),
    };
    this.states.set(workspaceId, next);
    return next;
  }

  async getOutcomeFlags(): Promise<{ hasDirectivesOrRoutines: boolean; hasNotifyDestination: boolean; hasCredential: boolean }> {
    return { hasDirectivesOrRoutines: false, hasNotifyDestination: false, hasCredential: false };
  }
}
