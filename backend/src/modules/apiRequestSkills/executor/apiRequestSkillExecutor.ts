import type {
  SkillDispatchResult,
  SkillExecutorPort,
  SkillInvocation,
  SkillOutcome,
  SkillOutputContract,
} from "@radioso/conversation-contract";

import { skillOutputContractFor } from "../../../shared/domain/skillDataContract/index.js";
import type { AppLogger } from "../../../shared/observability/logger.js";
import type { MetricsRegistry } from "../../../shared/observability/metrics/metricsRegistry.js";
import { setTraceAttributes, traceOperation } from "../../../shared/observability/tracing/operations.js";
import {
  apiRequestSkillConfigSchema,
  type ApiConnectionTarget,
  type ApiRequestFailureReason,
  type ApiRequestSkillOutcome,
} from "../domain.js";
import { resolveApiRequestParams } from "../inputResolution.js";
import { runApiRequest, type ApiRequestRun, type ApiRequestSender } from "../requestRunner.js";

export const API_REQUEST_SKILLS_ADAPTER = "api-request-skills";

/** The stored skill the executor runs: any agent-skill row, of which it takes only an enabled `api_request`. */
interface ApiRequestSkillRecord {
  skillName: string;
  kind: string;
  enabled: boolean;
  targetId?: string | null;
  config?: Record<string, unknown>;
}

interface ApiRequestSkillSource {
  findByName(workspaceId: string, agentId: string, skillName: string): Promise<ApiRequestSkillRecord | null>;
}

export type ApiConnectionTargetResolution =
  | { kind: "found"; target: ApiConnectionTarget }
  | { kind: "not_found" }
  | { kind: "credential_unavailable" };

export interface ApiConnectionTargetResolver {
  resolveTarget(workspaceId: string, connectionId: string): Promise<ApiConnectionTargetResolution>;
}

interface ApiRequestSkillExecutorOptions {
  skills: ApiRequestSkillSource;
  connections: ApiConnectionTargetResolver;
  send: ApiRequestSender;
  metricsRegistry?: Pick<MetricsRegistry, "incrementCounter"> | null;
  logger?: Pick<AppLogger, "warn">;
}

const settled = (
  status: ApiRequestSkillOutcome,
  outputs: Record<string, unknown> = {},
  outputContract?: SkillOutputContract,
): SkillDispatchResult => ({
  disposition: "settled",
  outcome: { status, outputs, ...(outputContract ? { outputContract } : {}) } as SkillOutcome,
});

const withStatus = (run: ApiRequestRun): Record<string, unknown> => (run.httpStatus === null ? {} : { httpStatus: run.httpStatus });

/**
 * What leaves the executor for each outcome: the declared outputs and their contract on
 * `completed`, codes and names otherwise. A value a visitor or the response supplied never does.
 */
const settledRun = (run: ApiRequestRun, outputContract: SkillOutputContract | undefined): SkillDispatchResult => {
  switch (run.outcome) {
    case "completed":
      return settled("completed", run.outputs, outputContract);
    case "rejected":
      return settled("rejected", withStatus(run));
    case "failed":
      return settled("failed", {
        reason: run.reason,
        ...withStatus(run),
        ...(run.missingOutputs ? { missingOutputs: run.missingOutputs } : {}),
      });
    default:
      return settled(run.outcome);
  }
};

const failed = (reason: ApiRequestFailureReason): ApiRequestRun =>
  ({ outcome: "failed", reason, httpStatus: null, durationMs: 0, outputs: {} });

/**
 * Whether the routine resolved the skill as read-only. The dispatcher hands over the resolver's
 * full skill definition, which carries `readOnly`; the executor port's own type does not name it.
 */
const resolvedAsReadOnly = (skill: object): boolean => "readOnly" in skill && skill.readOnly === true;

const contextString = (invocation: SkillInvocation, key: string): string =>
  typeof invocation.context?.[key] === "string" ? invocation.context[key] : "";

/**
 * Runs an agent's API request skill from a routine step: resolves the skill and its connection,
 * gates verified-only inputs, sends the request, and settles the outcome with only the outputs the
 * author declared. The response body, the URL and the param values never reach a log, a span or
 * a metric: those carry ids, the method, the status and a reason code.
 */
export class ApiRequestSkillExecutor implements SkillExecutorPort {
  constructor(private readonly options: ApiRequestSkillExecutorOptions) {}

  async dispatch(invocation: SkillInvocation): Promise<SkillDispatchResult> {
    return traceOperation({
      name: "api_request.skill.dispatch",
      attributes: { "skill.name": invocation.skill.name },
      run: () => this.dispatchInner(invocation),
      resultAttributes: (result) => ({
        "api_request.outcome": result.disposition === "settled" ? result.outcome.status : "deferred",
      }),
    });
  }

  private async dispatchInner(invocation: SkillInvocation): Promise<SkillDispatchResult> {
    const workspaceId = contextString(invocation, "workspaceId");
    const agentId = contextString(invocation, "agentId");
    const ids = { workspaceId, agentId, skillName: invocation.skill.name, connectionId: null as string | null };
    let outputContract: SkillOutputContract | undefined;
    const finish = (run: ApiRequestRun, method: string | null = null): SkillDispatchResult => {
      this.observe(ids, run, method);
      return settledRun(run, outputContract);
    };
    if (!workspaceId || !agentId) return finish(failed("context_missing"));

    const skill = await this.options.skills.findByName(workspaceId, agentId, invocation.skill.name);
    if (!skill || skill.kind !== "api_request" || !skill.enabled || !skill.targetId) {
      return finish(failed("skill_not_found"));
    }
    ids.connectionId = skill.targetId;
    const config = apiRequestSkillConfigSchema.safeParse(skill.config ?? {});
    if (!config.success) return finish(failed("invalid_config"));
    const method = config.data.method;
    // The routine let this run as read-only (a safe test runs it) when the skill sent a GET; a
    // method changed since then must not go out under that judgement.
    if (resolvedAsReadOnly(invocation.skill) && method !== "GET") return finish(failed("method_not_read_only"), method);
    if (Object.keys(config.data.outputs).length > 0) outputContract = skillOutputContractFor(config.data.outputs);

    const params = resolveApiRequestParams(config.data, invocation.collected ?? {}, invocation.collectedOrigins ?? {});
    if (params.kind !== "ready") {
      this.observe(ids, { outcome: params.kind, httpStatus: null, durationMs: 0, outputs: {} }, method);
      const { kind, ...names } = params;
      return settled(kind, names);
    }

    const connection = await this.options.connections.resolveTarget(workspaceId, skill.targetId);
    if (connection.kind !== "found") {
      return finish(failed(connection.kind === "not_found" ? "connection_not_found" : "credential_unavailable"), method);
    }
    const run = await runApiRequest({
      target: connection.target,
      method,
      path: config.data.path,
      params: params.params,
      outputs: config.data.outputs,
      send: this.options.send,
    });
    if (run.outcome === "invalid_input") {
      // A path placeholder that cannot take its value is named as the routine collected it.
      const param = run.invalidParam ?? "";
      this.observe(ids, run, method);
      return settled("invalid_input", { invalidInputs: [config.data.exposedParams[param]?.slotBinding ?? param] });
    }
    return finish(run, method);
  }

  private observe(
    ids: { workspaceId: string; agentId: string; skillName: string; connectionId: string | null },
    run: ApiRequestRun,
    method: string | null,
  ): void {
    setTraceAttributes({
      ...(ids.connectionId ? { "api_request.connection_id": ids.connectionId } : {}),
      ...(method ? { "http.method": method } : {}),
      ...(run.httpStatus === null ? {} : { "http.status_code": run.httpStatus }),
      "api_request.outcome": run.outcome,
      ...(run.reason ? { "api_request.reason": run.reason } : {}),
      ...(run.missingOutputs ? { "api_request.missing_outputs": run.missingOutputs.join(",") } : {}),
      "api_request.duration_ms": run.durationMs,
    });
    this.options.metricsRegistry?.incrementCounter("api_request_skill_dispatch_total", {
      help: "API request skill dispatches, by outcome and failure reason.",
      labels: { outcome: run.outcome, reason: run.reason ?? "none" },
    });
    if (run.outcome === "failed") {
      this.options.logger?.warn({
        event: "api_request_skill_failed",
        workspaceId: ids.workspaceId,
        agentId: ids.agentId,
        skillName: ids.skillName,
        connectionId: ids.connectionId,
        ...(method ? { method } : {}),
        reason: run.reason,
        ...(run.httpStatus === null ? {} : { httpStatus: run.httpStatus }),
        ...(run.missingOutputs ? { missingOutputs: run.missingOutputs } : {}),
      }, "API request skill failed");
    }
  }
}
