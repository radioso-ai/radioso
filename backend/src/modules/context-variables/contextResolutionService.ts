import type { StagedContext } from "@radioso/conversation-contract";

import type { ContextFragment, PageContextFragment } from "./contextBlockRenderer.js";
import { redactSnapshot, type ContextVariableSnapshot } from "./redaction.js";

/**
 * Structural page-context input owned by this module so context-variables does not depend on
 * the (broader) chat module. `AssistantPageContext` is structurally assignable to this.
 */
export type PageContextInput = Omit<PageContextFragment, "kind">;

export interface ResolvedTurnContext {
  fragments: ContextFragment[];
  staged: StagedContext[];
  snapshot: ContextVariableSnapshot;
}

const PAGE_CONTEXT_VARIABLE_NAME = "page_context";

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

  const fragment: PageContextFragment = {
    kind: "page_context",
  };
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

export const resolveContextForTurn = (
  pageContext: PageContextInput | null | undefined,
): ResolvedTurnContext => {
  const fragment = buildPageContextFragment(pageContext);
  if (!fragment) {
    return {
      fragments: [],
      staged: [],
      snapshot: {},
    };
  }

  return {
    fragments: [fragment],
    staged: [{
      kind: "context_variable",
      id: PAGE_CONTEXT_VARIABLE_NAME,
      data: fragment,
      metadata: {
        variableName: PAGE_CONTEXT_VARIABLE_NAME,
        trustTier: "unverified",
      },
    }],
    snapshot: redactSnapshot({
      [PAGE_CONTEXT_VARIABLE_NAME]: fragment,
    }),
  };
};

export class ContextResolutionService {
  resolve(pageContext: PageContextInput | null | undefined): ResolvedTurnContext {
    return resolveContextForTurn(pageContext);
  }
}
