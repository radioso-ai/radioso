import type {
  AssistantClientContextCapabilities,
  AssistantPageContext,
} from "../../types/assistantApi.js";
import {
  PAGE_READ_OPERATIONS,
  type PageReadCapability,
  type PageReadOperation,
} from "./pageReadDecision.js";

const usableString = (value: string | null | undefined): boolean =>
  typeof value === "string" && value.trim().length > 0;

const capabilityFromPayload = (
  pageContext: AssistantPageContext | null | undefined,
): PageReadCapability | null => {
  if (!pageContext) {
    return null;
  }
  if (usableString(pageContext.content)) {
    return {
      available: true,
      mode: "content",
      supportedOperations: [...PAGE_READ_OPERATIONS],
    };
  }
  if ([
    pageContext.pageUrl,
    pageContext.pageTitle,
    pageContext.pageLocale,
    pageContext.browserLocale,
  ].some(usableString)) {
    return {
      available: true,
      mode: "metadata",
      supportedOperations: ["metadata"],
    };
  }
  return null;
};

const unavailableCapability = (): PageReadCapability => ({
  available: false,
  mode: null,
  supportedOperations: [],
});

export const pageReadCapabilityFromRequest = (
  clientContextCapabilities: AssistantClientContextCapabilities | undefined,
  pageContext: AssistantPageContext | null | undefined,
): PageReadCapability | null => {
  const advertised = clientContextCapabilities?.["page.read"];
  const supplied = capabilityFromPayload(pageContext);
  if (!advertised) {
    return supplied;
  }
  if (!advertised.available || advertised.mode === null || !supplied) {
    return unavailableCapability();
  }

  const effectiveMode =
    advertised.mode === "content" && supplied.mode === "content"
      ? "content"
      : "metadata";
  const operationsAllowedByMode: readonly PageReadOperation[] =
    effectiveMode === "content" ? PAGE_READ_OPERATIONS : ["metadata"];
  const supportedOperations = PAGE_READ_OPERATIONS.filter((operation) =>
    operationsAllowedByMode.includes(operation) &&
    advertised.supportedOperations.includes(operation) &&
    supplied.supportedOperations.includes(operation),
  );
  if (supportedOperations.length === 0) {
    return unavailableCapability();
  }
  return {
    available: true,
    mode: effectiveMode,
    supportedOperations,
  };
};
