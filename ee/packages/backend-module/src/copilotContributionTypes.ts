import type { ZodType } from "zod";

/**
 * Mirrors OSS's operator-copilot catalog contract (in
 * `backend/src/modules/operatorCopilot/contracts.ts` and `contribution.ts`). Kept structurally
 * compatible so EE modules can contribute Ray tools without importing OSS types directly, the same
 * arrangement `AgentSurfaceExtension` in `radiosoModuleTypes.ts` uses, which re-exports these.
 *
 * `registerCopilotTools` takes reads, probes, and acts. A proposal goes through
 * `registerCopilotProposalAdapter` (see {@link CopilotProposalAdapterContribution}), which brings the
 * target type it needs.
 */
export type CopilotToolShape = "read" | "probe" | "act" | "propose";

/**
 * The subset of OSS's `CopilotToolInvocationContext` an EE descriptor reads. OSS passes the full
 * context; declaring only what is used keeps the mirror small and the drift surface narrow.
 */
export interface CopilotToolInvocationContext {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly operatorUserId: string;
  /**
   * Where the turn came in. Present because a contributed tool audits its own effects: without it
   * an EE tool recording a `copilot.*` event would have to omit the attribution OSS requires
   * everywhere else, or invent a value.
   */
  readonly surface: "dashboard" | "mcp";
}

interface CopilotAgentToolContext {
  readonly signal: AbortSignal;
  readonly stepIndex: number;
  readonly callId: string;
}

export interface CopilotAgentTool<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly outputSchema: ZodType<TOutput>;
  invoke(input: TInput, context: CopilotAgentToolContext): Promise<TOutput>;
}

export interface CopilotEntityReference {
  readonly type: string;
  readonly id?: string;
  readonly label?: string;
  readonly agentId?: string;
}

export interface CopilotCapabilityProvenance {
  readonly backingOperationIds?: readonly [string, ...string[]];
  readonly applicationPrimitiveIds?: readonly [string, ...string[]];
  readonly rayOnly?: { readonly reason: string };
}

/**
 * Operator MCP exposure a contributed descriptor declares. OSS keeps a contributed descriptor that
 * omits it off the operator MCP catalog.
 */
export type CopilotMcpDisposition =
  | {
      readonly status: "eligible";
      readonly inputStrategy: "explicit";
      readonly scope: "operator:read" | "operator:probe" | "operator:act" | "operator:propose" | "operator:write";
      readonly retry: {
        readonly effect: "none" | "proposal" | "act";
        readonly idempotent: boolean;
        readonly operationIdentity: "client" | "input";
      };
    }
  | { readonly status: "excluded"; readonly reason: string };

export interface CopilotToolDescriptor<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly shape: CopilotToolShape;
  /**
   * How much of a turn's verification budget one call spends, counted in replayed turns. `0` for a
   * tool that commands no synchronous model work, which is every read.
   *
   * Separate from {@link shape} on purpose: shape says what a tool changes, not what it costs, and
   * OSS meters the budget from this number alone. A contributed tool that spends model budget and
   * declares `0` is unmetered.
   */
  verificationCost(input: TInput): number;
  readonly uiLabel: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly outputSchema: ZodType<TOutput>;
  /** Workspace permissions, every one required. OSS resolves them per turn and filters on them. */
  readonly requiredPermissions: readonly [string, ...string[]];
  readonly capabilityProvenance: CopilotCapabilityProvenance;
  readonly contributingModule: string;
  readonly mcpDisposition?: CopilotMcpDisposition;
  readonly dashboardSubject: CopilotEntityReference;
  createTool(context: CopilotToolInvocationContext): CopilotAgentTool<TInput, TOutput>;
}

/**
 * Descriptors plus the identities their provenance cites. OSS validates provenance against its own
 * OpenAPI document and application-primitive registry, neither of which describes an EE surface, so
 * a contribution declares its own operations and primitives instead.
 */
export interface CopilotToolContribution {
  readonly moduleId: string;
  readonly descriptors: ReadonlyArray<CopilotToolDescriptor>;
  /** Operation id -> the workspace permissions that operation's own HTTP route requires. */
  readonly operationPermissions?: Readonly<Record<string, readonly string[]>>;
  readonly applicationPrimitives?: Readonly<Record<string, { readonly owningModule: string; readonly exportedPort: string }>>;
}

/**
 * Mirrors OSS's proposal contribution contract (in
 * `backend/src/modules/operatorCopilot/proposalContribution.ts`). An EE module owns a target type
 * no first-party proposal uses; OSS refuses to boot when it is first-party or already contributed.
 * Ray drafts through the adapter, then stores, audits, presents, and applies the proposal through
 * the paths a first-party proposal takes.
 */
interface CopilotProposalPresentation {
  /** What the applied card's link names, as in "Open usage alerts". */
  readonly label: string;
  /** A path inside the workspace's dashboard, relative to its root: `/settings?settingsTab=usage`. */
  readonly dashboardPath: string;
}

interface CopilotContributedProposalDraft {
  readonly targetRef: unknown;
  /** The change the adapter applies; OSS stores it and hands it back unchanged. */
  readonly change: unknown;
  readonly versionToken: string;
  readonly targetLabel: string;
  readonly summary: string;
  readonly presentation: CopilotProposalPresentation;
  readonly removesTarget?: boolean;
}

type CopilotProposalApplyOutcome =
  | { outcome: "applied"; appliedRef: unknown; reason?: string }
  | { outcome: "stale"; reason?: string }
  | { outcome: "failed"; reason: string };

export interface CopilotContributedProposalAdapter<TInput = unknown> {
  /** A lowercase identifier such as `alert_threshold`. */
  readonly targetType: string;
  /** Workspace permissions to read the target type's proposals, and to apply one. */
  readonly permissions: { readonly read: readonly [string, ...string[]]; readonly manage: readonly [string, ...string[]] };
  draft(input: TInput, context: { readonly workspaceId: string; readonly accountId: string; readonly operatorUserId: string }): Promise<CopilotContributedProposalDraft>;
  readVersionToken(workspaceId: string, targetRef: unknown, change: unknown): Promise<string>;
  preview(workspaceId: string, targetRef: unknown, change: unknown): Promise<{ current: unknown; proposed: unknown }>;
  applyIfVersionMatches(workspaceId: string, targetRef: unknown, change: unknown, versionToken: string, context?: { readonly surface: "dashboard" | "mcp"; readonly accountId: string }): Promise<CopilotProposalApplyOutcome>;
  /** Required: false for a create, whose retry after an interrupted apply would create it twice. */
  canRetryAfterInterruptedApply(targetRef: unknown, change: unknown): boolean;
  proposalDetailTargetRef?(targetRef: unknown): Record<string, string | boolean | null>;
}

export interface CopilotProposalAdapterContribution<TInput = unknown> {
  readonly moduleId: string;
  readonly adapter: CopilotContributedProposalAdapter<TInput>;
  readonly tool: {
    readonly name: string;
    readonly description: string;
    readonly uiLabel: string;
    readonly inputSchema: ZodType<TInput>;
    readonly capabilityProvenance: CopilotCapabilityProvenance;
  };
  readonly operationPermissions?: Readonly<Record<string, readonly string[]>>;
  readonly applicationPrimitives?: Readonly<Record<string, { readonly owningModule: string; readonly exportedPort: string }>>;
}
