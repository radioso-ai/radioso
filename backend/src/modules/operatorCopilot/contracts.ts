import { z, type ZodType } from "zod";

import type { AccountPermission } from "../account/public.js";
import type { AgentTool, AgentToolContext } from "../../shared/agent-runtime/index.js";

/**
 * The single runtime list of page-context entity types a dashboard surface may report to the
 * copilot. The client's mirror of this list lives in frontend/lib/api-copilot.ts's
 * COPILOT_PAGE_ENTITY_TYPES; there is no shared package between the two runtimes, so
 * backend/tests/unit/operatorCopilot/copilot-contracts.test.ts parses that file's source to keep
 * the two declarations from drifting apart again (the client type once allowed "agent_skill",
 * a value this schema had never accepted). The OpenAPI turn schema also derives from this array
 * rather than repeating its own literal enum, the same discipline copilotProposalTargetTypes below
 * already follows.
 */
export const copilotPageEntityTypes = ["agent", "conversation", "routine", "directive", "document", "evalCase"] as const;
export type CopilotPageEntityType = (typeof copilotPageEntityTypes)[number];

export const copilotPageContextSchema = z.object({
  view: z.enum(["activity", "history", "agent", "documents", "workbench", "quality", "evals", "copilot", "other"]).nullable(),
  agentId: z.string().uuid().nullable(),
  conversationId: z.string().uuid().nullable(),
  selection: z.string().nullable().optional().transform((value) => value === undefined || value === null ? null : value.slice(0, 2_000)),
  entities: z.array(z.object({
    type: z.enum(copilotPageEntityTypes),
    id: z.string().min(1),
    label: z.string().max(120),
    focused: z.boolean(),
  }).strict()).max(30).optional().default([]),
}).strict().superRefine((context, issueContext) => {
  if (context.entities.filter((entity) => entity.focused).length > 3) {
    issueContext.addIssue({ code: z.ZodIssueCode.custom, message: "At most three page-context entities may be focused", path: ["entities"] });
  }
});

export const copilotTurnRequestSchema = z.object({
  conversationId: z.string().uuid().nullable(),
  message: z.string().min(1).max(8000),
  pageContext: copilotPageContextSchema,
}).strict();

export type CopilotPageContext = z.infer<typeof copilotPageContextSchema>;
export type CopilotTurnRequest = z.infer<typeof copilotTurnRequestSchema>;

export interface CopilotToolInvocationContext {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly operatorUserId: string;
  /**
   * Where the turn running this tool came in. Carried on the context because a tool audits its own
   * effects — a drafted proposal is recorded by the tool that drafted it, not by the service — so
   * without it the one act Ray actually performs is the one act nobody can attribute.
   */
  readonly surface: CopilotSurface;
  /** Present for transport-facing catalog calls so entity lookup cannot bypass tool permissions. */
  readonly permissions?: ReadonlySet<string>;
  /**
   * Resolves the operator's entitlement at the instant a descriptor is about to
   * read or act. The turn-start permission set remains useful for catalog
   * discovery, but is never sufficient for a protected descriptor hook.
   */
  readonly currentAuthorization: CopilotCurrentAuthorizationPort;
  /** Internal copilot thread identity; distinct from pageContext.conversationId. */
  readonly copilotConversationId?: string;
  readonly pageContext: CopilotPageContext;
}

/** Narrow authorization port: it answers entitlement only and returns no role or customer data. */
export interface CopilotCurrentAuthorizationPort {
  hasAllPermissions(input: {
    readonly workspaceId: string;
    readonly accountId: string;
    readonly operatorUserId: string;
    readonly requiredPermissions: readonly AccountPermission[];
  }): Promise<boolean>;
}

/** Resolves the public workspace key required for dashboard-safe copilot handoffs. */
export interface CopilotWorkspaceRouteKeyResolver {
  resolveWorkspaceKey(workspaceId: string): Promise<string>;
}

export interface CopilotEntityReference {
  readonly type: string;
  readonly id?: string;
  readonly label?: string;
  readonly agentId?: string;
}

export type CopilotEntityDescription<TInput> =
  | CopilotEntityReference
  | {
      readonly kind: "resolved";
      readonly entity: CopilotEntityReference;
      /** The entity-owning descriptor may replace a human name with its stable id. */
      readonly input: TInput;
    }
  | {
      readonly kind: "ambiguous";
      readonly candidates: ReadonlyArray<CopilotEntityReference>;
    }
  | {
      readonly kind: "not_found";
    };

/**
 * Where a copilot call entered the product. Required with no default on every entry point that
 * audits, so a transport added later cannot inherit `dashboard` by omission: "who changed this,
 * and from where" is the first question asked when a configuration change is a surprise, and an
 * event written without the answer can never be reconstructed.
 */
export type CopilotSurface = "dashboard" | "mcp";

/** The principal a copilot audit event is attributed to, and the surface it acted through. */
export interface CopilotActor {
  readonly operatorUserId: string;
  readonly surface: CopilotSurface;
}

/** Narrow audit port owned by the copilot consumer. */
export interface CopilotAuditPort {
  record(input: { accountId: string; workspaceId: string; eventType: string; eventStatus: "success" | "failure"; metadata: Record<string, unknown> }): Promise<void>;
}

/**
 * Stamps the actor onto an event's metadata.
 *
 * Deliberately not extra fields on {@link CopilotAuditPort}: the audit service it binds to accepts
 * a wider input type, so extra properties would typecheck at the boundary and then be dropped
 * before the row is written — attribution that compiles and does not exist. Folding into metadata
 * here keeps the one shape the table actually persists.
 */
export const withCopilotActor = (
  actor: CopilotActor,
  metadata: Record<string, unknown>,
): Record<string, unknown> => ({ ...metadata, operatorUserId: actor.operatorUserId, surface: actor.surface });

/**
 * The single runtime list of proposal target types. Every completeness guard over target types
 * (the copilot service's tool-output narrowing, the repository's row narrowing, the OpenAPI and
 * tool-output zod enums) must derive from this array rather than repeating its own OR-chain or
 * literal enum, so adding a target type cannot silently miss one of those sites again.
 */
export const copilotProposalTargetTypes = ["directive", "agent_setting", "routine", "agent_skill", "context_variable", "document", "ingestion_settings", "website_crawl"] as const;
export type CopilotProposalTargetType = (typeof copilotProposalTargetTypes)[number];
/**
 * The permission an operator needs to apply a proposal, by what it changes. Applying is a write to
 * the owning domain, so it has to ask for that domain's permission rather than one permission for
 * everything: gating a document deletion on agent management both blocks the document managers who
 * should be able to apply it and lets an agent manager delete documents they cannot otherwise touch.
 * Every target type appears here, so a new one cannot inherit an unrelated domain's authority by
 * omission.
 */
export const copilotProposalPermissions = {
  directive: ["workspace.agents.manage"],
  agent_setting: ["workspace.agents.manage"],
  routine: ["workspace.agents.manage"],
  agent_skill: ["workspace.agents.manage"],
  context_variable: ["workspace.agents.manage"],
  document: ["workspace.documents.manage"],
  ingestion_settings: ["workspace.settings.manage"],
  website_crawl: ["workspace.documents.manage"],
} as const satisfies Record<CopilotProposalTargetType, readonly [AccountPermission, ...AccountPermission[]]>;

/**
 * How long the sentence a proposal card states may be. Enforced on the composed sentence rather than
 * argued from its parts: a summary is built from a title, a URL, a rationale and whatever else the
 * target needs, and proving every combination of those fits is arithmetic that goes stale the moment
 * one of them changes. Composing then clamping cannot go stale.
 */
export const MAX_COPILOT_PROPOSAL_SUMMARY = 2_000;

export type CopilotProposalStatus = "pending" | "applied" | "dismissed" | "failed" | "stale";

export interface CopilotProposal {
  readonly id: string;
  readonly workspaceId: string;
  readonly operatorUserId: string;
  readonly conversationId: string;
  readonly messageId: string | null;
  readonly targetType: CopilotProposalTargetType;
  readonly targetRef: unknown;
  readonly payload: unknown;
  readonly versionToken: string;
  /** Replays measured before the draft, or null when the change was proposed unmeasured. */
  readonly evidence: CopilotProposalEvidence | null;
  readonly status: CopilotProposalStatus;
  readonly reason?: string | null;
  readonly appliedRef: unknown | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CopilotProposalCard {
  readonly id: string;
  readonly targetType: CopilotProposalTargetType;
  readonly targetLabel: string;
  readonly summary: string;
  readonly status: CopilotProposalStatus;
  readonly reason?: string | null;
  /** Absent when nothing was measured; the card must not imply a verified change either way. */
  readonly evidence?: CopilotProposalEvidenceSummary;
  /**
   * True only for a proposal that permanently deletes its target (currently
   * propose_directive_removal) rather than updating it. A structural signal the frontend can act
   * on directly - e.g. to state plainly in an Apply confirmation that the change cannot be
   * undone - rather than inferring irreversibility from `summary`'s prose (Finding 1, issue
   * triage next-ray-epic-issue). Absent, not false, when the proposal is an ordinary update.
   */
  readonly removal?: boolean;
}

export interface CopilotProposalAdapter {
  readonly targetType: CopilotProposalTargetType;
  /**
   * `payload` is the proposal's stored payload where the caller has one (getProposal always
   * does; a tool minting the very first token for a fresh create does too, once it has drafted
   * one). A create target ref names no row of its own to read a version from, so a create
   * adapter's own implementation uses this to check the one thing that actually determines
   * whether Apply would still succeed — whether the resource it would create already exists —
   * instead of falling back to an unrelated row's timestamp. Adapters whose target always
   * addresses an existing row ignore it.
   */
  readVersionToken(workspaceId: string, targetRef: unknown, payload?: unknown): Promise<string>;
  preview(workspaceId: string, targetRef: unknown, payload: unknown): Promise<{ targetLabel: string; current: unknown | null; proposed: unknown }>;
  applyIfVersionMatches(workspaceId: string, targetRef: unknown, payload: unknown, versionToken: string): Promise<
    | { outcome: "applied"; appliedRef: unknown }
    | { outcome: "stale" }
    | { outcome: "failed"; reason: string }
  >;
  /**
   * Whether applying this proposal again is safe after an earlier attempt was interrupted — a
   * process that died between the effect and recording it leaves a claim nothing ever resolves,
   * and the claim's TTL exists so an operator is not stuck with a card they can neither apply nor
   * dismiss.
   *
   * Answered by whether this target's version token can tell the two crash windows apart. A token
   * read from the world can: after a successful first attempt the target has moved, so the retry
   * comes back `stale`. A token that is a constant cannot, because a create addresses no stored
   * row — retrying it would ingest a second document or start a second crawl. Absent means
   * retryable, which is right for every adapter whose target always addresses an existing row.
   */
  canRetryAfterInterruptedApply?(targetRef: unknown, payload: unknown): boolean;
}

export interface CopilotDirectiveProposalAdapter extends CopilotProposalAdapter {
  readonly targetType: "directive";
  draft(workspaceId: string, targetRef: unknown, intent: string): Promise<{ payload: unknown; targetLabel: string; summary: string }>;
}

/** Whether a routine goes live, comes out of service, or comes back. */
export type CopilotRoutineLifecycleAction = "publish" | "archive" | "restore";

export interface CopilotRoutineProposalDraft {
  readonly payload: unknown;
  readonly targetLabel: string;
  readonly summary: string;
  /** Structural problems the proposed routine still carries. Empty when it validates cleanly. */
  readonly diagnostics: ReadonlyArray<{ readonly code: string; readonly location: string; readonly message: string }>;
}

export interface CopilotRoutineProposalAdapter extends CopilotProposalAdapter {
  readonly targetType: "routine";
  draft(workspaceId: string, targetRef: unknown, intent: string): Promise<CopilotRoutineProposalDraft>;
  /**
   * Field edits addressed by stable id. Rejects an edit the routine cannot take — an id it does
   * not have, a status it cannot be edited in, or a change that would introduce a validation
   * diagnostic it does not already carry — so an unusable draft never reaches an operator.
   */
  draftEdit(workspaceId: string, targetRef: unknown, changes: unknown, rationale?: string): Promise<CopilotRoutineProposalDraft>;
  draftLifecycle(workspaceId: string, targetRef: unknown, action: CopilotRoutineLifecycleAction, rationale?: string): Promise<CopilotRoutineProposalDraft>;
}

export interface CopilotAgentSettingProposalAdapter extends CopilotProposalAdapter {
  readonly targetType: "agent_setting";
  /**
   * The version token is returned from the same read that normalizes the payload (not a
   * follow-up `readVersionToken` call): a partial patch is expanded against current state here,
   * so a second, later read could pair an expansion built from stale state with a fresher token
   * and let a concurrent edit slip past the apply-time version check undetected.
   */
  validatePayload(workspaceId: string, targetRef: unknown, payload: unknown): Promise<{ targetRef: unknown; payload: unknown; versionToken: string }>;
}

/** A skill config is supplied by Ray from settings it read, not drafted from prose. */
export interface CopilotAgentSkillProposalAdapter extends CopilotProposalAdapter {
  readonly targetType: "agent_skill";
  /** See {@link CopilotAgentSettingProposalAdapter.validatePayload} for why the token travels with the payload. */
  validatePayload(workspaceId: string, targetRef: unknown, payload: unknown): Promise<{ targetRef: unknown; payload: unknown; versionToken: string }>;
}

/**
 * A context variable proposal is supplied by Ray from a definition and/or an agent enablement it
 * already read, not drafted from prose — the same reason agent_skill validates rather than drafts.
 */
export interface CopilotContextVariableProposalAdapter extends CopilotProposalAdapter {
  readonly targetType: "context_variable";
  /** See {@link CopilotAgentSettingProposalAdapter.validatePayload} for why the token travels with the payload. */
  validatePayload(workspaceId: string, targetRef: unknown, payload: unknown): Promise<{ targetRef: unknown; payload: unknown; versionToken: string }>;
}

/**
 * A document change is supplied by Ray from a document it read the status and metadata of, never
 * drafted from prose, so validation happens entirely in `validatePayload`.
 */
export interface CopilotDocumentProposalAdapter extends CopilotProposalAdapter {
  readonly targetType: "document";
  /** See {@link CopilotAgentSettingProposalAdapter.validatePayload} for why the token travels with the payload. */
  validatePayload(workspaceId: string, targetRef: unknown, payload: unknown): Promise<{ targetRef: unknown; payload: unknown; versionToken: string }>;
}

/**
 * An ingestion settings change is supplied by Ray from settings it read, and the write replaces
 * every field at once, so `validatePayload` merges it against the stored row.
 */
export interface CopilotIngestionSettingsProposalAdapter extends CopilotProposalAdapter {
  readonly targetType: "ingestion_settings";
  /** See {@link CopilotAgentSettingProposalAdapter.validatePayload} for why the token travels with the payload. */
  validatePayload(workspaceId: string, targetRef: unknown, payload: unknown): Promise<{ targetRef: unknown; payload: unknown; versionToken: string }>;
}

/**
 * A crawl proposal is supplied by Ray from a URL an operator named or a source it read. Applying it
 * starts a job rather than changing a stored row, so nothing about it can go stale.
 */
export interface CopilotWebsiteCrawlProposalAdapter extends CopilotProposalAdapter {
  readonly targetType: "website_crawl";
  /** See {@link CopilotAgentSettingProposalAdapter.validatePayload} for why the token travels with the payload. */
  validatePayload(workspaceId: string, targetRef: unknown, payload: unknown): Promise<{ targetRef: unknown; payload: unknown; versionToken: string }>;
}

/**
 * Every adapter a tool factory may be handed, discriminated by `targetType`. One declaration so a
 * new target type reaches every proposal tool at once instead of being added to each one by hand.
 */
export type CopilotAnyProposalAdapter =
  | CopilotDirectiveProposalAdapter
  | CopilotAgentSettingProposalAdapter
  | CopilotRoutineProposalAdapter
  | CopilotAgentSkillProposalAdapter
  | CopilotContextVariableProposalAdapter
  | CopilotDocumentProposalAdapter
  | CopilotIngestionSettingsProposalAdapter
  | CopilotWebsiteCrawlProposalAdapter;

export type CopilotProposalAdapterRegistry = ReadonlyArray<CopilotAnyProposalAdapter>;

export interface CopilotToolDescriptor<TInput = unknown, TOutput = unknown> {
  readonly name: string;
  readonly shape: CopilotToolShape;
  /**
   * How much of a turn's verification budget one call spends, counted in replayed turns. `0` for a
   * tool that commands no synchronous model work.
   *
   * Required rather than optional, and separate from {@link shape}, because those are the two ways
   * this has already gone wrong. Shape answers what a tool changes; it does not answer what a tool
   * costs, and inferring cost from it left `run_eval_suite` — an `act`, because it moves a case's
   * stored verdict — spending five replays a call against no budget at all. An optional field would
   * fail the same way by omission, so every descriptor states a number and a reviewer can see a
   * wrong one.
   *
   * Takes the arguments because cost can depend on them: `run_eval_suite` costs one per case asked
   * for, not one per call. Declared as a method rather than a function-typed property so a
   * descriptor narrowed to its own input type stays assignable to the catalog's, the same way
   * {@link describeEntity} does.
   */
  verificationCost(input: TInput): number;
  readonly uiLabel: string;
  readonly description: string;
  readonly inputSchema: ZodType<TInput>;
  readonly outputSchema: ZodType<TOutput>;
  /** Every permission is required; descriptors use all-of semantics. */
  readonly requiredPermissions: readonly [AccountPermission, ...AccountPermission[]];
  /**
   * Production catalog assembly attaches a reviewed declaration here. Factories
   * intentionally stay unaware of the HTTP registry and owner-port registry.
   */
  readonly capabilityProvenance?: CopilotCapabilityProvenance;
  readonly contributingModule: string;
  /** Default dashboard handoff for this tool's collection or owning subject. */
  readonly dashboardSubject: CopilotEntityReference;
  createTool(context: CopilotToolInvocationContext): AgentTool<TInput, TOutput>;
  describeEntity?(input: TInput, context?: CopilotToolInvocationContext): CopilotEntityDescription<TInput> | null | Promise<CopilotEntityDescription<TInput> | null>;
  /** Lets a result refine the declared dashboard handoff without coupling catalog enrichment to its shape. */
  describeOutputEntity?(output: TOutput): CopilotEntityReference | null;
  /** Optional last-mile sanitizer for the successful result after its dashboard link is attached. */
  finalizeEnrichedOutput?(output: Record<string, unknown>): Record<string, unknown>;
}

export interface CopilotRayOnlyDisposition {
  readonly reason: string;
}

/**
 * A descriptor represents ordinary public operations, a registered owning
 * application primitive, or reviewed Ray-only orchestration. Compositions may
 * name both their ordinary backing and the additional Ray-specific behavior.
 */
export interface CopilotCapabilityProvenance {
  readonly backingOperationIds?: readonly [string, ...string[]];
  readonly applicationPrimitiveIds?: readonly [string, ...string[]];
  readonly rayOnly?: CopilotRayOnlyDisposition;
}

/**
 * The write and cost semantics of a catalog tool. This remains independent of
 * any transport so future MCP administration can consume the same taxonomy.
 */
export type CopilotToolShape =
  /** No state change and no meaningful compute cost. */
  | "read"
  /**
   * Changes no operator-managed configuration, but spends real compute budget and leaves a record
   * of the run. Neither safe to auto-run nor safe to retry.
   */
  | "probe"
  /** Persists a reversible, idempotent change that is not customer-visible. */
  | "act"
  /** Drafts an operator-confirmed change to live agent or workspace behavior. */
  | "propose";

export type CopilotSseEvent =
  | { readonly event: "conversation"; readonly data: { conversationId: string; turnId: string } }
  | { readonly event: "activity"; readonly data: { toolCallId: string; tool: string; stage: "started" | "completed" | "failed"; entity?: CopilotEntityReference } }
  | { readonly event: "chunk"; readonly data: { text: string } }
  | { readonly event: "proposal"; readonly data: { proposalId: string; targetType: CopilotProposalTargetType; targetLabel: string; summary: string; evidence?: CopilotProposalEvidenceSummary; removal?: boolean } }
  | { readonly event: "outcome"; readonly data: { status: CopilotTurnOutcome } }
  | { readonly event: "done"; readonly data: Record<string, never> };

export type CopilotTurnOutcome = "completed" | "budget_exhausted" | "failed";

export type CopilotAgentTool = AgentTool<unknown, unknown>;
export type CopilotAgentToolContext = AgentToolContext;

/** One case a proposal was measured against, as the operator reviews it. */
export interface CopilotProposalEvidenceCase {
  readonly caseId: string;
  readonly caseName: string;
  readonly runId: string;
  /** The case's recorded verdict before the replay. */
  readonly before: "pending" | "passing" | "failing" | "error";
  /** What the proposed configuration produced. */
  readonly after: "pass" | "fail" | "error" | "recorded";
  /** True when the agent moved after this replay, so the measurement describes an older agent. */
  readonly stale: boolean;
}

export interface CopilotProposalEvidence {
  readonly cases: ReadonlyArray<CopilotProposalEvidenceCase>;
}

/**
 * What the card states without expanding. Regressions are counted, not hidden: a change that
 * fixes two cases and breaks one is the review the operator is equipped to make.
 */
export interface CopilotProposalEvidenceSummary {
  readonly total: number;
  readonly improved: number;
  readonly regressed: number;
  readonly unchanged: number;
  readonly stale: number;
}
