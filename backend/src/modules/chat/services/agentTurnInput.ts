import { badRequest, notFound } from "../../../shared/domain/errors.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { validateRoutineInvocation } from "../../routines/public.js";
import type { AgentToolCatalogPort, AgentToolDescriptor, RoutineInvocation } from "../contracts/routineInvocation.js";

/**
 * What a calling agent sent for one turn, resolved once before any turn state
 * exists: either a message, or a tool call already validated against the
 * release's catalog. Both agent-facing doors (MCP converse `ask` and the REST
 * agent chat route) call this, so neither transport validates on its own.
 */
export type AgentTurnInput =
  | { kind: "message"; message: string }
  | { kind: "routine_invocation"; invocation: RoutineInvocation; descriptor: AgentToolDescriptor };

interface AgentTurnInputRequest {
  workspaceId: string;
  agentId: string;
  /** The release the conversation is pinned to; absent resolves against the current published one. */
  agentRevisionId?: string;
  body: {
    message?: string;
    routine?: { toolName: string; input: unknown };
  };
}

interface AgentTurnInputObservability {
  metrics?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger?: Pick<AppLogger, "info">;
}

const CONVERSE_TURNS_TOTAL = "converse_turns_total";
const ROUTINE_INVOCATIONS_TOTAL = "routine_invocations_total";

const countTurn = (observability: AgentTurnInputObservability, inputKind: AgentTurnInput["kind"]): void => {
  observability.metrics?.incrementCounter(CONVERSE_TURNS_TOTAL, {
    help: "Agent-facing converse turns by input kind.",
    labels: { input_kind: inputKind },
  });
};

const countInvocation = (observability: AgentTurnInputObservability, outcome: "validation_failed" | "unknown_tool"): void => {
  observability.metrics?.incrementCounter(ROUTINE_INVOCATIONS_TOTAL, {
    help: "Routine tool invocations by outcome.",
    labels: { outcome },
  });
};

export const resolveAgentTurnInput = async (
  catalog: AgentToolCatalogPort,
  request: AgentTurnInputRequest,
  observability: AgentTurnInputObservability = {},
): Promise<AgentTurnInput> => {
  const { routine } = request.body;
  if (!routine) {
    const message = request.body.message?.trim();
    if (!message) {
      throw badRequest("message is required unless a routine is invoked");
    }
    countTurn(observability, "message");
    return { kind: "message", message };
  }

  const loaded = await catalog.load({
    workspaceId: request.workspaceId,
    agentId: request.agentId,
    ...(request.agentRevisionId ? { agentRevisionId: request.agentRevisionId } : {}),
  });
  const descriptor = loaded.tools.find((tool) => tool.toolName === routine.toolName);
  if (!descriptor) {
    countInvocation(observability, "unknown_tool");
    throw notFound(`Unknown tool: ${routine.toolName}`, { code: "routine_tool_unknown", toolName: routine.toolName });
  }
  const validation = validateRoutineInvocation(descriptor, routine.input);
  if (!validation.ok) {
    countInvocation(observability, "validation_failed");
    // Paths only: slot values may be personal data and never reach a log line.
    observability.logger?.info(
      {
        workspaceId: request.workspaceId,
        agentId: request.agentId,
        toolName: routine.toolName,
        errorPaths: validation.errors.map((error) => error.path),
      },
      "Routine invocation rejected before the turn: input did not match the tool's schema",
    );
    throw badRequest("Routine invocation input is invalid", {
      code: "routine_invocation_invalid",
      toolName: routine.toolName,
      errors: validation.errors,
    });
  }
  countTurn(observability, "routine_invocation");
  return { kind: "routine_invocation", invocation: validation.invocation, descriptor };
};

/** The chat request fields one resolved turn input fills in; the rest of the request is the route's. */
export const chatRequestInputFor = (
  turnInput: AgentTurnInput,
): { message?: string; routineInvocation?: RoutineInvocation } =>
  turnInput.kind === "message"
    ? { message: turnInput.message }
    : { routineInvocation: turnInput.invocation };
