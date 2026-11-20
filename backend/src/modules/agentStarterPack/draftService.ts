import { AppError, notFound } from "../../shared/domain/errors.js";
import type { RoutineDefinitionDraftInput, RoutineValidationResult } from "../routines/public.js";
import type {
  StarterPackDraftItem,
  StarterPackDraftResponse,
  StarterPackItemConflict,
} from "./contracts.js";
import type { StarterPackAgentContext, StarterPackDraftGenerator } from "./draftGenerator.js";

/**
 * Read-only ports. The draft path is given no way to write: suggestions are only persisted later,
 * by the apply step, through the owning directive and routine services.
 */
export interface StarterPackDraftServiceOptions {
  agents: {
    findByIdAndWorkspaceId(agentId: string, workspaceId: string): Promise<StarterPackAgentContext | null>;
  };
  directives: { list(workspaceId: string, agentId: string): Promise<ReadonlyArray<{ name: string }>> };
  routines: { list(workspaceId: string, agentId: string): Promise<ReadonlyArray<{ name: string }>> };
  /** Turns plain-language procedure text into a routine definition draft; saves nothing. */
  routineDrafter: {
    draft(
      workspaceId: string,
      agentId: string,
      input: { prose: string },
      options: { outputLanguage?: string },
    ): Promise<{ draft: RoutineDefinitionDraftInput; validation: RoutineValidationResult }>;
  };
  chatReadiness: { assertChatConfigured(workspaceId: string): Promise<void> };
  generator: Pick<StarterPackDraftGenerator, "generate">;
}

const llmUnavailable = (): AppError =>
  new AppError(
    503,
    "llm_unavailable",
    "The language model could not draft the starter pack right now. Try again shortly.",
  );

/**
 * Model and network failures are not the caller's fault and carry no safe message of their own,
 * so they become one stable 503. Errors that already carry an HTTP meaning pass through.
 */
const asModelFailure = (error: unknown): unknown => (error instanceof AppError ? error : llmUnavailable());

const conflictFor = (name: string, takenNames: ReadonlySet<string>): StarterPackItemConflict =>
  takenNames.has(name) ? "name_exists" : null;

export class StarterPackDraftService {
  constructor(private readonly options: StarterPackDraftServiceOptions) {}

  async draft(
    workspaceId: string,
    agentId: string,
    purpose: string,
    requestOptions: { signal?: AbortSignal } = {},
  ): Promise<StarterPackDraftResponse> {
    const agent = await this.options.agents.findByIdAndWorkspaceId(agentId, workspaceId);
    if (!agent) {
      throw notFound("Agent not found");
    }
    await this.options.chatReadiness.assertChatConfigured(workspaceId);

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
      signal: requestOptions.signal,
    }).catch((error: unknown) => { throw asModelFailure(error); });

    // The pack's one routine is drafted in a second model call; the language detected for the
    // pack goes with it, so the routine's user-facing text matches the directives'.
    const routineDraft = await this.options.routineDrafter
      .draft(
        workspaceId,
        agentId,
        { prose: pack.routine.procedure },
        pack.outputLanguage ? { outputLanguage: pack.outputLanguage } : {},
      )
      .catch((error: unknown) => { throw asModelFailure(error); });
    // The pack's routine name was chosen with the agent's taken names in view; the routine
    // drafter never saw them, so its own suggestion could collide.
    const routine: RoutineDefinitionDraftInput = { ...routineDraft.draft, name: pack.routine.name };

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
        conflict: conflictFor(routine.name, routineNames),
      },
    ];
    return { outputLanguage: pack.outputLanguage, items };
  }
}
