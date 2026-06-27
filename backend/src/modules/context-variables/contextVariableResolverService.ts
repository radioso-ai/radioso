import type { ContextVariableRepositoryPort } from "../../db/repositories/contextVariableRepository.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import type {
  AgentContextVariableEnablement,
  ContextVariable,
  ContextVariableScope,
  ContextVariableValue,
} from "./domain.js";
import type { ResolvedVariableInput } from "./contextResolutionService.js";
import { isValueCompatibleWithType } from "./valueCompatibility.js";

export interface ContextResolverPort {
  resolve(input: {
    workspaceId: string;
    agentId: string;
    resolverSkillId: string;
    variableName: string;
    scope: ContextVariableScope;
    signal?: AbortSignal;
  }): Promise<{ value: unknown } | null>;
}

export interface ContextVariableResolverServiceOptions {
  repository: ContextVariableRepositoryPort;
  resolver: ContextResolverPort;
  logger?: Pick<AppLogger, "info" | "warn">;
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  now?: () => number;
}

type ResolverOutcome = "cache_hit" | "cache_miss" | "fetch" | "timeout" | "error" | "null" | "incompatible_value";

const DEFAULT_RESOLVER_TIMEOUT_MS = 2_500;
const RESOLVE_METRIC_HELP = "Context variable resolver outcomes.";
const RESOLVE_LATENCY_HELP = "Context variable resolver latency in milliseconds.";

export class ContextVariableResolverService {
  private readonly repository: ContextVariableRepositoryPort;
  private readonly resolver: ContextResolverPort;
  private readonly logger?: Pick<AppLogger, "info" | "warn">;
  private readonly metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  private readonly now: () => number;

  constructor(options: ContextVariableResolverServiceOptions) {
    this.repository = options.repository;
    this.resolver = options.resolver;
    this.logger = options.logger;
    this.metrics = options.metrics ?? null;
    this.now = options.now ?? (() => Date.now());
  }

  async resolveForAgent(
    workspaceId: string,
    agentId: string,
    scopes: ContextVariableScope[],
  ): Promise<ResolvedVariableInput[]> {
    const pushed = await this.repository.resolveForAgent(workspaceId, agentId, scopes);
    const scope = scopes[0];
    if (!scope) {
      return pushed;
    }

    let enablements: AgentContextVariableEnablement[];
    try {
      enablements = await this.repository.listByAgent(workspaceId, agentId);
    } catch (error) {
      this.logger?.warn({
        event: "context_variable_resolver_list_failed",
        workspaceId,
        agentId,
        errorName: error instanceof Error ? error.name : "UnknownError",
      }, "Context variable resolver enablements failed to load");
      return pushed;
    }

    const resolverValues: ResolvedVariableInput[] = [];
    for (const enablement of enablements) {
      const resolved = await this.resolveEnablement(workspaceId, agentId, scope, enablement);
      if (resolved) {
        resolverValues.push(resolved);
      }
    }

    return [...pushed, ...resolverValues];
  }

  private async resolveEnablement(
    workspaceId: string,
    agentId: string,
    scope: ContextVariableScope,
    enablement: AgentContextVariableEnablement,
  ): Promise<ResolvedVariableInput | null> {
    const variable = enablement.variable;
    if (!isResolvableEnablement(enablement, variable)) {
      return null;
    }
    const resolverSkillId = enablement.resolverSkillId;
    if (!resolverSkillId) {
      return null;
    }

    const startedAt = this.now();
    try {
      const cached = await this.repository.readValue(variable.id, scope);
      if (isFresh(cached, enablement.maxAgeSeconds, this.now())) {
        if (!isValueCompatibleWithType(variable.valueType, cached.data)) {
          this.recordResolution({
            outcome: "incompatible_value",
            latencyMs: this.now() - startedAt,
            workspaceId,
            agentId,
            variableId: variable.id,
            variableName: variable.name,
          });
          return null;
        }
        this.recordResolution({
          outcome: "cache_hit",
          latencyMs: this.now() - startedAt,
          workspaceId,
          agentId,
          variableId: variable.id,
          variableName: variable.name,
        });
        return mapResolvedVariable(enablement, variable, cached.data);
      }

      this.recordResolution({
        outcome: "cache_miss",
        latencyMs: this.now() - startedAt,
        workspaceId,
        agentId,
        variableId: variable.id,
        variableName: variable.name,
      });

      const fetched = await this.fetchWithTimeout({
        workspaceId,
        agentId,
        resolverSkillId,
        variableName: variable.name,
        variableId: variable.id,
        scope,
        timeoutMs: enablement.resolverTimeoutMs ?? DEFAULT_RESOLVER_TIMEOUT_MS,
      });
      if (!fetched) {
        return null;
      }
      if (!isValueCompatibleWithType(variable.valueType, fetched.value)) {
        this.recordResolution({
          outcome: "incompatible_value",
          latencyMs: this.now() - startedAt,
          workspaceId,
          agentId,
          variableId: variable.id,
          variableName: variable.name,
        });
        return null;
      }
      await this.repository.upsertValue(variable.id, scope, fetched.value);
      return mapResolvedVariable(enablement, variable, fetched.value);
    } catch (error) {
      this.recordResolution({
        outcome: "error",
        latencyMs: this.now() - startedAt,
        workspaceId,
        agentId,
        variableId: variable.id,
        variableName: variable.name,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return null;
    }
  }

  private async fetchWithTimeout(input: {
    workspaceId: string;
    agentId: string;
    resolverSkillId: string;
    variableName: string;
    variableId: string;
    scope: ContextVariableScope;
    timeoutMs: number;
  }): Promise<{ value: unknown } | null> {
    const startedAt = this.now();
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<"timeout">((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        resolve("timeout");
      }, input.timeoutMs);
    });

    try {
      const resolved = await Promise.race([
        this.resolver.resolve({
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          resolverSkillId: input.resolverSkillId,
          variableName: input.variableName,
          scope: input.scope,
          signal: controller.signal,
        }),
        timeoutPromise,
      ]);
      if (resolved === "timeout") {
        this.recordResolution({
          outcome: "timeout",
          latencyMs: this.now() - startedAt,
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          variableId: input.variableId,
          variableName: input.variableName,
        });
        return null;
      }
      const outcome: ResolverOutcome = resolved ? "fetch" : "null";
      this.recordResolution({
        outcome,
        latencyMs: this.now() - startedAt,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        variableId: input.variableId,
        variableName: input.variableName,
      });
      return resolved;
    } catch (error) {
      this.recordResolution({
        outcome: "error",
        latencyMs: this.now() - startedAt,
        workspaceId: input.workspaceId,
        agentId: input.agentId,
        variableId: input.variableId,
        variableName: input.variableName,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      return null;
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
    }
  }

  private recordResolution(input: {
    outcome: ResolverOutcome;
    latencyMs: number;
    workspaceId: string;
    agentId: string;
    variableId: string;
    variableName: string;
    errorName?: string;
  }): void {
    const logFields = {
      event: "context_variable_resolve",
      outcome: input.outcome,
      latencyMs: input.latencyMs,
      workspaceId: input.workspaceId,
      agentId: input.agentId,
      variableId: input.variableId,
      variableName: input.variableName,
      ...(input.errorName ? { errorName: input.errorName } : {}),
    };
    if (input.outcome === "error" || input.outcome === "timeout") {
      this.logger?.warn(logFields, "Context variable resolver skipped a variable");
    } else {
      this.logger?.info(logFields, "Context variable resolver completed");
    }
    this.metrics?.incrementCounter("context_variable_resolve_total", {
      help: RESOLVE_METRIC_HELP,
      labels: { outcome: input.outcome },
    });
    this.metrics?.observeHistogram("context_variable_resolve_latency_ms", {
      help: RESOLVE_LATENCY_HELP,
      labels: { outcome: input.outcome },
      value: Math.max(0, input.latencyMs),
    });
  }
}

const isResolvableEnablement = (
  enablement: AgentContextVariableEnablement,
  variable: ContextVariable | undefined,
): variable is ContextVariable =>
  Boolean(
    enablement.enabled &&
      enablement.source === "resolver" &&
      enablement.resolverSkillId &&
      variable,
  );

const isFresh = (
  cached: ContextVariableValue | null,
  maxAgeSeconds: number | null,
  now: number,
): cached is ContextVariableValue => {
  if (!cached || maxAgeSeconds == null) {
    return false;
  }
  return (now - cached.lastModified.getTime()) / 1_000 < maxAgeSeconds;
};

const mapResolvedVariable = (
  enablement: AgentContextVariableEnablement,
  variable: ContextVariable,
  value: unknown,
): ResolvedVariableInput => ({
  name: variable.name,
  description: variable.description,
  value,
  surfacing: enablement.surfacing,
  sensitive: variable.sensitivity === "sensitive",
  trust: variable.trustTier === "signed" ? "verified" : "unverified",
});
