import { AppError, notFound } from "../../shared/domain/errors.js";
import { describeProviderFailure } from "../../shared/infra/llm/providerErrors.js";
import { INVALID_ROUTINE_DRAFT_CODE, type RoutineDefinitionDraftInput, type RoutineValidationResult } from "../routines/public.js";
import type {
  StarterPackDraftItem,
  StarterPackDraftResponse,
  StarterPackItemConflict,
} from "./contracts.js";
import { invalidStarterPackDraftError, type StarterPackAgentContext, type StarterPackDraftGenerator } from "./draftGenerator.js";

/**
 * Read-only ports. The draft path is given no way to write: suggestions are only persisted later,
 * by the apply step, through the owning directive and routine services.
 */
export interface StarterPackDraftServiceOptions {
  agents: {
    findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<StarterPackAgentContext | null>;
  };
  directives: { list(workspaceId: string, agentId: string): Promise<ReadonlyArray<{ name: string }>> };
  routines: {
    list(workspaceId: string, agentId: string): Promise<ReadonlyArray<{ name: string }>>;
    /**
     * The row that would block creating a routine under `name`, as apply checks it. Unlike
     * `list()`, it also sees a retired, non-canonical row that still holds the name.
     */
    findCreateConflict(workspaceId: string, agentId: string, name: string): Promise<unknown>;
  };
  /**
   * Turns plain-language procedure text into a routine definition draft under the given name, and
   * validates it under that name; saves nothing.
   */
  routineDrafter: {
    draft(
      workspaceId: string,
      agentId: string,
      input: { prose: string },
      options: { outputLanguage?: string; name: string; signal?: AbortSignal },
    ): Promise<{ draft: RoutineDefinitionDraftInput; validation: RoutineValidationResult }>;
  };
  chatReadiness: { assertChatConfigured(workspaceId: string): Promise<void> };
  generator: Pick<StarterPackDraftGenerator, "generate">;
  logger: { warn(bindings: Record<string, unknown>, message: string): void };
}

interface StarterPackDraftRequestOptions {
  signal?: AbortSignal;
  /**
   * Runs once the agent exists and a chat model is configured, before the first model call. A
   * caller spends its rate-limit budget here, so a request refused for those reasons spends none.
   */
  beforeModelCalls?: () => Promise<void>;
}

const llmUnavailable = (): AppError =>
  new AppError(
    503,
    "llm_unavailable",
    "The language model could not draft the starter pack right now. Try again shortly.",
  );

const conflictFor = (name: string, takenNames: ReadonlySet<string>): StarterPackItemConflict =>
  takenNames.has(name) ? "name_exists" : null;

const isAbortError = (error: unknown): boolean =>
  typeof error === "object" && error !== null && "name" in error && error.name === "AbortError";

export class StarterPackDraftService {
  constructor(private readonly options: StarterPackDraftServiceOptions) {}

  async draft(
    workspaceId: string,
    agentId: string,
    purpose: string,
    requestOptions: StarterPackDraftRequestOptions = {},
  ): Promise<StarterPackDraftResponse> {
    const agent = await this.options.agents.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }
    await this.options.chatReadiness.assertChatConfigured(workspaceId);
    await requestOptions.beforeModelCalls?.();
    const { signal } = requestOptions;
    const asModelFailure = (error: unknown): unknown => this.asModelFailure(error, { workspaceId, agentId, signal });

    const [directives, routines] = await Promise.all([
      this.options.directives.list(workspaceId, agentId),
      this.options.routines.list(workspaceId, agentId),
    ]);
    const directiveNames = new Set(directives.map((directive) => directive.name));
    const routineNames = new Set(routines.map((routine) => routine.name));

    const pack = await this.options.generator.generate({
      workspaceId,
      agent,
      purpose,
      existingDirectiveNames: [...directiveNames],
      existingRoutineNames: [...routineNames],
      signal,
    }).catch((error: unknown) => { throw asModelFailure(error); });

    // The pack's one routine is drafted in a second model call; the language detected for the
    // pack goes with it, so the routine's user-facing text matches the directives'. The pack's
    // routine name was chosen with the agent's taken names in view, so the drafter uses it, and
    // validates under it, instead of suggesting its own.
    const routineDraft = await this.options.routineDrafter
      .draft(
        workspaceId,
        agentId,
        { prose: pack.routine.procedure },
        {
          ...(pack.outputLanguage ? { outputLanguage: pack.outputLanguage } : {}),
          name: pack.routine.name,
          ...(signal ? { signal } : {}),
        },
      )
      .catch((error: unknown) => { throw asModelFailure(error); });
    const routine = routineDraft.draft;
    const routineNameTaken = await this.options.routines.findCreateConflict(workspaceId, agentId, routine.name) !== null;

    const items: StarterPackDraftItem[] = [
      ...pack.directives.map((directive, index): StarterPackDraftItem => ({
        itemKey: `directive-${index + 1}`,
        kind: "directive",
        directive,
        conflict: conflictFor(directive.name, directiveNames),
      })),
      {
        itemKey: "routine-1",
        kind: "routine",
        routine,
        procedure: pack.routine.procedure,
        validation: routineDraft.validation,
        conflict: routineNameTaken ? "name_exists" : null,
      },
    ];
    return { outputLanguage: pack.outputLanguage, items };
  }

  /**
   * An abort stays an abort: the caller went away. A failure that is not an abort is still logged
   * when the caller is gone. The routine drafter's invalid draft is this
   * endpoint's own 422. Any other error with an HTTP meaning passes through. Model and network
   * failures are not the caller's fault and carry no safe message of their own, so they are
   * logged by class and become one stable 503.
   */
  private asModelFailure(
    error: unknown,
    context: { workspaceId: string; agentId: string; signal: AbortSignal | undefined },
  ): unknown {
    if (context.signal?.aborted && isAbortError(error)) {
      return error;
    }
    if (error instanceof AppError) {
      return error.code === INVALID_ROUTINE_DRAFT_CODE ? invalidStarterPackDraftError() : error;
    }
    this.options.logger.warn(
      { workspaceId: context.workspaceId, agentId: context.agentId, ...describeProviderFailure(error) },
      "starter_pack_draft_failed",
    );
    return llmUnavailable();
  }
}
