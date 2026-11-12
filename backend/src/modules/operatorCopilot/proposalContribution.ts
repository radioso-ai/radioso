import { z, type ZodType } from "zod";

import type { AccountPermission } from "../account/public.js";
import {
  copilotProposalPermissions,
  copilotProposalTargetTypes,
  type CopilotCapabilityProvenance,
  type CopilotProposalAdapter,
  type CopilotProposalApplyContext,
  type CopilotProposalPresentation,
} from "./contracts.js";

/**
 * How a module outside this repository contributes a proposal Ray can draft, store, show, and
 * apply: a target type of its own, the adapter that reads and applies it, and the propose tool Ray
 * offers for it. Ray drafts through the adapter and then stores, audits, presents, and applies the
 * proposal through the same paths a first-party proposal takes, so the contributing module never
 * touches Ray's persistence and a contributed card cannot drift from a first-party one.
 */

/** What reading a target type's proposals takes, and what applying one takes. */
export interface CopilotProposalPermissions {
  readonly read: readonly [AccountPermission, ...AccountPermission[]];
  readonly manage: readonly [AccountPermission, ...AccountPermission[]];
}

/**
 * The proposal target types one deployment's Ray can store, read, and apply, with what each asks
 * of an operator. Composition assembles it from the first-party list and the contributions; every
 * site that narrows a stored or streamed target type reads it.
 */
export interface CopilotProposalTargetTypeSet {
  /** First-party types in their declared order, then contributed types in registration order. */
  readonly targetTypes: readonly [string, ...string[]];
  has(targetType: unknown): boolean;
  /** Throws for a target type outside the set: authorizing against a guess would be worse. */
  permissionsFor(targetType: string): CopilotProposalPermissions;
}

/** The adapter's draft, before Ray stores it. */
export interface CopilotContributedProposalDraft {
  /** What the adapter's reads and apply address. Stored as the proposal's target ref. */
  readonly targetRef: unknown;
  /** The change the adapter applies. Ray stores it and hands it back unchanged. */
  readonly change: unknown;
  readonly versionToken: string;
  /** Names the target on the card. */
  readonly targetLabel: string;
  /** The sentence the card states. Ray shortens it to what a proposal payload holds. */
  readonly summary: string;
  /** Where the applied card links to. */
  readonly presentation: CopilotProposalPresentation;
  /** True when applying permanently deletes the target, so Apply asks for the irreversible confirmation. */
  readonly removesTarget?: boolean;
}

export interface CopilotContributedProposalDraftContext {
  readonly workspaceId: string;
  readonly accountId: string;
  readonly operatorUserId: string;
}

type CopilotProposalApplyOutcome = Awaited<ReturnType<CopilotProposalAdapter["applyIfVersionMatches"]>>;

export interface CopilotContributedProposalAdapter<TInput = unknown> {
  /** A lowercase identifier no first-party type and no other contribution uses, such as `alert_threshold`. */
  readonly targetType: string;
  readonly permissions: CopilotProposalPermissions;
  /** Turns the propose tool's parsed input into a draft. Throw to refuse the draft. */
  draft(input: TInput, context: CopilotContributedProposalDraftContext): Promise<CopilotContributedProposalDraft>;
  readVersionToken(workspaceId: string, targetRef: unknown, change: unknown): Promise<string>;
  /** What the card's diff shows as the current and the proposed value. */
  preview(workspaceId: string, targetRef: unknown, change: unknown): Promise<{ current: unknown; proposed: unknown }>;
  /** Runs once per claim: Ray holds the apply claim and checks the operator's permission first. */
  applyIfVersionMatches(workspaceId: string, targetRef: unknown, change: unknown, versionToken: string, context?: CopilotProposalApplyContext): Promise<CopilotProposalApplyOutcome>;
  /**
   * Whether applying again is safe after an earlier attempt was interrupted before its outcome was
   * recorded. Required, and checked at boot, because a create-shaped contribution that left it out
   * would otherwise be retried.
   *
   * Answer true only when the version token tells the two crash windows apart: `applyIfVersionMatches`
   * writes only if the target still matches `versionToken` (a compare-and-set in the same write, not
   * a read followed by a write), and a completed apply changes what `readVersionToken` returns. A
   * retry after a first attempt that took effect then comes back `stale`, and nothing is applied
   * twice. Answer false when the token cannot tell them apart, as for a create, whose target has no
   * version before it exists: Ray then resolves the proposal as interrupted instead of applying it
   * again.
   */
  canRetryAfterInterruptedApply(targetRef: unknown, change: unknown): boolean;
  /** Identifiers `proposal_detail` may show for the target; Ray keeps strings, booleans, and nulls, each string cut to 300 characters. */
  proposalDetailTargetRef?(targetRef: unknown): Record<string, string | boolean | null>;
}

export interface CopilotProposalAdapterContribution<TInput = unknown> {
  /** The contributing application module's id, used to attribute a rejected contribution. */
  readonly moduleId: string;
  readonly adapter: CopilotContributedProposalAdapter<TInput>;
  /** The propose tool Ray offers for the target type. It asks for the adapter's manage permissions. */
  readonly tool: {
    readonly name: string;
    readonly description: string;
    readonly uiLabel: string;
    readonly inputSchema: ZodType<TInput>;
    readonly capabilityProvenance: CopilotCapabilityProvenance;
  };
  /** Operation ids the tool's provenance cites, with what each operation's own route requires. */
  readonly operationPermissions?: Readonly<Record<string, readonly string[]>>;
  /** Application primitives the tool's provenance cites, owned by the contributing module. */
  readonly applicationPrimitives?: Readonly<Record<string, { readonly owningModule: string; readonly exportedPort: string }>>;
}

export interface ResolvedCopilotProposalContributions {
  readonly targetTypes: CopilotProposalTargetTypeSet;
  /** The contributed adapters, read and applied through the same service path a first-party adapter is. */
  readonly adapters: ReadonlyArray<CopilotProposalAdapter>;
  readonly contributions: ReadonlyArray<CopilotProposalAdapterContribution>;
}

const DASHBOARD_ORIGIN = "https://dashboard.invalid";
// Structural: a path the dashboard router can take, never a URL that leaves the workspace dashboard.
const CONTROL_OR_SPACE = /[\u0000- \u007f]/u;
/**
 * The dashboard prefixes the path with the workspace's own root (`/w/<routeKey>`), so a `.` or `..`
 * segment, raw or percent-encoded, would walk out of the workspace once a browser resolves it. The
 * path is decoded before its segments are checked; one that does not decode is refused.
 */
const hasDotSegment = (path: string): boolean => {
  const pathname = path.split(/[?#]/u, 1)[0] ?? "";
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return decoded.includes("\\") || decoded.split("/").some((segment) => segment === "." || segment === "..");
};
const isWorkspaceDashboardPath = (path: string): boolean => {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\") || CONTROL_OR_SPACE.test(path) || hasDotSegment(path)) return false;
  try {
    return new URL(path, DASHBOARD_ORIGIN).origin === DASHBOARD_ORIGIN;
  } catch {
    return false;
  }
};

export const copilotProposalPresentationSchema = z.object({
  label: z.string().min(1).max(120),
  dashboardPath: z.string().min(1).max(500).refine(isWorkspaceDashboardPath, "must be a path inside the workspace dashboard, such as /settings"),
}).strict();

/** A stored or streamed presentation, or null when there is none or it is not one the card may render. */
export const readCopilotProposalPresentation = (value: unknown): CopilotProposalPresentation | null => {
  const parsed = copilotProposalPresentationSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
};

const createTargetTypeSet = (
  contributed: ReadonlyArray<{ readonly targetType: string; readonly permissions: CopilotProposalPermissions }>,
): CopilotProposalTargetTypeSet => {
  const permissions = new Map<string, CopilotProposalPermissions>(
    copilotProposalTargetTypes.map((targetType) => [targetType, copilotProposalPermissions[targetType]]),
  );
  for (const entry of contributed) permissions.set(entry.targetType, entry.permissions);
  const targetTypes = [...permissions.keys()] as [string, ...string[]];
  return {
    targetTypes,
    has: (targetType) => typeof targetType === "string" && permissions.has(targetType),
    permissionsFor: (targetType) => {
      const found = permissions.get(targetType);
      if (!found) throw new Error(`Unknown copilot proposal target type: ${targetType}`);
      return found;
    },
  };
};

export const firstPartyCopilotProposalTargetTypes: CopilotProposalTargetTypeSet = createTargetTypeSet([]);

// Structural identifier syntax; it carries no product meaning.
const TARGET_TYPE_PATTERN = /^[a-z][a-z0-9_]{0,62}$/u;
const firstPartyTargetTypes: ReadonlySet<string> = new Set(copilotProposalTargetTypes);

/**
 * A contribution is compiled elsewhere, so the types that make these fields mandatory in-repo are
 * only advice to it. Each check names the module and the target type, so a deployment that fails
 * to boot says which contribution to fix.
 */
const assertContribution = (contribution: CopilotProposalAdapterContribution, claimed: Map<string, string>): void => {
  const { moduleId, adapter } = contribution;
  const targetType: unknown = adapter.targetType;
  if (typeof targetType !== "string" || !TARGET_TYPE_PATTERN.test(targetType)) {
    throw new Error(`Copilot proposal adapter contributed by "${moduleId}" has an invalid target type ${JSON.stringify(targetType)}; use a lowercase identifier such as alert_threshold.`);
  }
  if (firstPartyTargetTypes.has(targetType)) {
    throw new Error(`Copilot proposal adapter contributed by "${moduleId}" claims first-party target type "${targetType}". A second adapter for it would shadow the first-party one; contribute a target type the module owns.`);
  }
  const owner = claimed.get(targetType);
  if (owner !== undefined) {
    throw new Error(`Copilot proposal adapter contributed by "${moduleId}" claims target type "${targetType}", already contributed by "${owner}".`);
  }
  if (typeof adapter.canRetryAfterInterruptedApply !== "function") {
    throw new Error(`Copilot proposal adapter for "${targetType}" contributed by "${moduleId}" declares no canRetryAfterInterruptedApply. State whether an interrupted apply may run again; return false for a create.`);
  }
  for (const kind of ["read", "manage"] as const) {
    const permissions: unknown = adapter.permissions?.[kind];
    if (!Array.isArray(permissions) || permissions.length === 0 || !permissions.every((permission) => typeof permission === "string" && permission.length > 0)) {
      throw new Error(`Copilot proposal adapter for "${targetType}" contributed by "${moduleId}" declares no ${kind} permission.`);
    }
  }
  claimed.set(targetType, moduleId);
};

const contributedPayloadSchema = z.object({ name: z.string(), change: z.unknown() });

const MAX_DETAIL_REFERENCE_CHARS = 300;
/** `proposal_detail` publishes this projection under a bounded schema, so values outside it are dropped or cut here rather than failing the read. */
const detailReference = (reference: unknown): Record<string, string | boolean | null> => {
  if (!reference || typeof reference !== "object" || Array.isArray(reference)) return {};
  return Object.fromEntries(Object.entries(reference).flatMap(([key, value]): Array<[string, string | boolean | null]> => {
    if (typeof value === "string") return [[key, value.slice(0, MAX_DETAIL_REFERENCE_CHARS)]];
    return typeof value === "boolean" || value === null ? [[key, value]] : [];
  }));
};

/**
 * Ray stores a contributed proposal's payload as the card's fields beside the adapter's change
 * (`{ name, summary, presentation, removesTarget?, change }`), so neither can overwrite the other.
 * This hands the adapter back only its change, and gives the preview the card's own label.
 */
const asProposalAdapter = (adapter: CopilotContributedProposalAdapter): CopilotProposalAdapter => ({
  targetType: adapter.targetType,
  readVersionToken: (workspaceId, targetRef, payload) =>
    adapter.readVersionToken(workspaceId, targetRef, contributedPayloadSchema.parse(payload).change),
  preview: async (workspaceId, targetRef, payload) => {
    const stored = contributedPayloadSchema.parse(payload);
    const { current, proposed } = await adapter.preview(workspaceId, targetRef, stored.change);
    return { targetLabel: stored.name, current, proposed };
  },
  applyIfVersionMatches: (workspaceId, targetRef, payload, versionToken, context) =>
    adapter.applyIfVersionMatches(workspaceId, targetRef, contributedPayloadSchema.parse(payload).change, versionToken, context),
  canRetryAfterInterruptedApply: (targetRef, payload) =>
    adapter.canRetryAfterInterruptedApply(targetRef, contributedPayloadSchema.parse(payload).change),
  proposalDetailTargetRef: (targetRef) => detailReference(adapter.proposalDetailTargetRef?.(targetRef)),
});

/**
 * Assembles the target-type set from the first-party list and the contributions, refusing any
 * contribution that would shadow another adapter or skip the apply fence.
 */
export const resolveCopilotProposalContributions = (
  contributions: ReadonlyArray<CopilotProposalAdapterContribution>,
): ResolvedCopilotProposalContributions => {
  const claimed = new Map<string, string>();
  for (const contribution of contributions) assertContribution(contribution, claimed);
  return {
    targetTypes: contributions.length === 0
      ? firstPartyCopilotProposalTargetTypes
      : createTargetTypeSet(contributions.map(({ adapter }) => adapter)),
    adapters: contributions.map(({ adapter }) => asProposalAdapter(adapter)),
    contributions,
  };
};

/** A deployment no module contributes a proposal to: the first-party target types and no contributed adapter. */
export const noContributedCopilotProposals: ResolvedCopilotProposalContributions = resolveCopilotProposalContributions([]);
