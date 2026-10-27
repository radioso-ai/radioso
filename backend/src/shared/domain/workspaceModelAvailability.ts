import type { LlmProviderName } from "../infra/llm/providerTypes.js";
import { badRequest } from "./errors.js";

/**
 * Which models a workspace can run on a provider. A workspace holding its own key for the
 * provider runs any model the provider offers; otherwise it runs what the deployment's platform
 * key serves. Which keys exist and what the platform endpoint serves are the implementation's
 * knowledge alone.
 */
export interface WorkspaceModelAvailability {
  /** Whether a call for `model` on `provider` succeeds for this workspace; decides what a call runs. */
  canRun(workspaceId: string, provider: LlmProviderName, model: string): Promise<boolean>;
  /**
   * The catalog models the workspace can pick on `provider`, or `null` when nothing restricts the
   * pick. The one list a model picker offers, a write accepts, and a refusal names.
   */
  runnableModels(workspaceId: string, provider: LlmProviderName): Promise<readonly string[] | null>;
}

type ModelPick = { provider: LlmProviderName; model: string };

/** Whether the workspace could pick `pick` today: the same test `assertWorkspaceCanRunModel` enforces. */
export const workspaceCanPickModel = async (
  availability: Pick<WorkspaceModelAvailability, "runnableModels">,
  workspaceId: string,
  pick: ModelPick,
): Promise<boolean> => {
  const runnable = await availability.runnableModels(workspaceId, pick.provider);
  return runnable === null || runnable.includes(pick.model);
};

/** Rejects a model pick the workspace cannot run, naming what it can run and the own-key route to the rest. */
export const assertWorkspaceCanRunModel = async (
  availability: Pick<WorkspaceModelAvailability, "runnableModels">,
  workspaceId: string,
  pick: ModelPick,
): Promise<void> => {
  const runnable = await availability.runnableModels(workspaceId, pick.provider);
  if (runnable === null || runnable.includes(pick.model)) {
    return;
  }
  const alternatives = runnable.length > 0 ? `Pick one of: ${runnable.join(", ")}, or add` : "Add";
  throw badRequest(
    `Model "${pick.model}" is not available on this deployment's shared ${pick.provider} key. ${alternatives} this workspace's own ${pick.provider} API key under Settings → Providers to use any supported ${pick.provider} model.`,
    { provider: pick.provider, model: pick.model, runnableModels: [...runnable] },
  );
};
