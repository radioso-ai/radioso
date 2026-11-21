import type { ContextVariableResolverRepositoryPort } from "./repository.js";
import { notFound } from "../../shared/domain/errors.js";
import type { MetricsRegistry } from "../../shared/observability/metrics/metricsRegistry.js";
import type { AppLogger } from "../../shared/observability/logger.js";
import {
  resolvedVariableInput,
  type AgentContextVariableEnablement,
  type ContextValueWriter,
  type ContextVariable,
  type ContextVariableScope,
  type ContextVariableValue,
} from "./domain.js";
import type { ResolvedVariableInput } from "./contextResolutionService.js";
import { validateValue } from "./valueValidation.js";

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

interface ContextVariableResolverServiceOptions {
  repository: ContextVariableResolverRepositoryPort;
  resolver: ContextResolverPort;
  logger?: Pick<AppLogger, "info" | "warn">;
  metrics?: Pick<MetricsRegistry, "incrementCounter" | "observeHistogram"> | null;
  now?: () => number;
}

type ResolverOutcome = "cache_hit" | "cache_miss" | "fetch" | "timeout" | "error" | "null" | "incompatible_value";

const DEFAULT_RESOLVER_TIMEOUT_MS = 2_500;
/** A resolver's cache holds what the host's API returned through the resolver skill. */
const RESOLVER_CACHE_WRITER: ContextValueWriter = { kind: "api", ref: null };

/**
 * The scope a resolver reads and caches under, and hands its skill as the visitor's session: the
 * most specific one past the conversation. A resolver fetches about the visitor, not about one of
 * their conversations, so the ladder's conversation step leaves it where it was.
 */
const resolverScope = (scopes: readonly ContextVariableScope[]): ContextVariableScope | undefined =>
  scopes.find((scope) => scope.type !== "conversation");
const RESOLVE_METRIC_HELP = "Context variable resolver outcomes.";
const RESOLVE_LATENCY_HELP = "Context variable resolver latency in milliseconds.";

export class ContextVariableResolverService {
  private readonly repository: ContextVariableResolverRepositoryPort;
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
    const scope = resolverScope(scopes);
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

  async resolveForEnablements(workspaceId: string, agentId: string, enablements: readonly AgentContextVariableEnablement[], scopes: ContextVariableScope[]): Promise<ResolvedVariableInput[]> {
    const resolved: ResolvedVariableInput[] = [];
    for (const enablement of enablements) {
      if (!enablement.enabled) continue;
      const variable = await this.repository.get(workspaceId, enablement.variableId);
      if (!variable) throw notFound("A context variable selected by this revision no longer exists");
      if (enablement.source === "pushed") {
        for (const scope of scopes) {
          const value = await this.repository.readValue(variable.id, scope);
          if (value) { resolved.push(resolvedVariableInput(enablement, variable, value.data)); break; }
        }
        continue;
      }
      const scope = resolverScope(scopes);
      if (!scope) continue;
      const value = await this.resolveEnablement(workspaceId, agentId, scope, { ...enablement, variable });
      if (value) resolved.push(value);
    }
    return resolved;
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
        const verdict = validateValue(variable, cached.data);
        // A key archived after it was cached still names its option.
        if (!verdict.ok && verdict.code !== "archived_option") {
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
        return resolvedVariableInput(enablement, variable, cached.data);
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
      if (!validateValue(variable, fetched.value).ok) {
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
      await this.repository.upsertValue(variable.id, scope, fetched.value, RESOLVER_CACHE_WRITER);
      return resolvedVariableInput(enablement, variable, fetched.value);
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

