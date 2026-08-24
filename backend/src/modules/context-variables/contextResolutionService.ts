import type { StagedContext } from "@radioso/conversation-contract";

import type {
  ContextFragment,
  PageContextFragment,
  VariableContextFragment,
} from "./contextBlockRenderer.js";
import { redactSnapshot, type ContextVariableSnapshot, type SnapshotEntry } from "./redaction.js";

/**
 * Structural page-context input owned by this module so context-variables does not depend on
 * the (broader) chat module. `AssistantPageContext` is structurally assignable to this.
 */
export type PageContextInput = Omit<PageContextFragment, "kind">;

export type ContextVariableSurfacing = "always" | "on_reference" | "operator_only";

/**
 * A host-defined context variable already resolved to a value for this turn (from the value
 * store, a pushed API value, or a resolver). Slice 1 only resolves page context, so callers
 * pass an empty list; Slice 2 wiring supplies these from the repository.
 */
export interface ResolvedVariableInput {
  name: string;
  description?: string | null;
  value: unknown;
  surfacing: ContextVariableSurfacing;
  sensitive?: boolean;
  trust?: "unverified" | "verified";
}

export interface ResolvedTurnContext {
  /** Every resolved fragment (page + variables), regardless of surfacing. */
  fragments: ContextFragment[];
  /** Fragments to render into the answer prompt (surfacing `always`). */
  renderFragments: ContextFragment[];
  /** Staged entries for the directive matcher / routine binding — all resolved variables. */
  staged: StagedContext[];
  /** Redacted snapshot to persist per turn (all resolved variables, sensitive values masked). */
  snapshot: ContextVariableSnapshot;
}

/** Snapshot/staged key for the built-in page-context variable. */
export const PAGE_CONTEXT_VARIABLE_NAME = "page_context";

const EMPTY_TURN_CONTEXT: ResolvedTurnContext = {
  fragments: [],
  renderFragments: [],
  staged: [],
  snapshot: {},
};

const usableString = (value: string | null | undefined): string | undefined => {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
};

const buildPageContextFragment = (
  pageContext: PageContextInput | null | undefined,
): PageContextFragment | null => {
  if (!pageContext) {
    return null;
  }

  const fragment: PageContextFragment = { kind: "page_context" };
  const pageUrl = usableString(pageContext.pageUrl);
  const pageTitle = usableString(pageContext.pageTitle);
  const pageLocale = usableString(pageContext.pageLocale);
  const browserLocale = usableString(pageContext.browserLocale);
  const content = usableString(pageContext.content);

  if (pageUrl) {
    fragment.pageUrl = pageUrl;
  }
  if (pageTitle) {
    fragment.pageTitle = pageTitle;
  }
  if (pageLocale) {
    fragment.pageLocale = pageLocale;
  }
  if (browserLocale) {
    fragment.browserLocale = browserLocale;
  }
  if (content) {
    fragment.content = content;
  }

  return pageUrl || pageTitle || pageLocale || browserLocale || content ? fragment : null;
};

const stagedFor = (
  id: string,
  fragment: ContextFragment,
  metadata: Record<string, unknown>,
): StagedContext => ({ kind: "context_variable", id, data: fragment, metadata });

/**
 * Resolve all context variables for a turn into render fragments, staged entries, and a
 * redacted snapshot. Resolution is independent of surfacing (per spec FR-004): every variable
 * is staged (so the directive matcher / routines see it) and snapshotted (redacted), while
 * only `always`-surfaced variables are added to `renderFragments` for the prompt.
 * `operator_only` variables are staged and snapshotted but never rendered.
 */
export const resolveContextForTurn = (
  pageContext: PageContextInput | null | undefined,
  variables: readonly ResolvedVariableInput[] = [],
): ResolvedTurnContext => {
  const fragments: ContextFragment[] = [];
  const renderFragments: ContextFragment[] = [];
  const staged: StagedContext[] = [];
  const snapshotEntries: SnapshotEntry[] = [];

  const pageFragment = buildPageContextFragment(pageContext);
  if (pageFragment) {
    fragments.push(pageFragment);
    renderFragments.push(pageFragment); // page context is always-surfaced
    staged.push(
      stagedFor(PAGE_CONTEXT_VARIABLE_NAME, pageFragment, {
        variableName: PAGE_CONTEXT_VARIABLE_NAME,
        trustTier: "unverified",
      }),
    );
    snapshotEntries.push({ name: PAGE_CONTEXT_VARIABLE_NAME, value: pageFragment });
  }

  for (const variable of variables) {
    const name = usableString(variable.name);
    if (!name) {
      continue;
    }
    const fragment: VariableContextFragment = {
      kind: "variable",
      name,
      description: variable.description ?? null,
      value: variable.value,
      trust: variable.trust ?? "unverified",
    };
    fragments.push(fragment);
    if (variable.surfacing === "always") {
      renderFragments.push(fragment);
    }
    staged.push(
      stagedFor(name, fragment, {
        variableName: name,
        surfacing: variable.surfacing,
        trustTier: fragment.trust,
        sensitive: variable.sensitive ?? false,
      }),
    );
    snapshotEntries.push({ name, value: variable.value, sensitive: variable.sensitive });
  }

  if (fragments.length === 0) {
    return EMPTY_TURN_CONTEXT;
  }

  return {
    fragments,
    renderFragments,
    staged,
    snapshot: redactSnapshot(snapshotEntries),
  };
};

export class ContextResolutionService {
  resolve(
    pageContext: PageContextInput | null | undefined,
    variables: readonly ResolvedVariableInput[] = [],
  ): ResolvedTurnContext {
    return resolveContextForTurn(pageContext, variables);
  }
}
