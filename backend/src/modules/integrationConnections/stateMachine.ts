import type { IntegrationConnectionStatus } from "./domain.js";

const allowedTransitions: Record<IntegrationConnectionStatus, ReadonlySet<IntegrationConnectionStatus>> = {
  authorized: new Set(["authorized", "disabled", "needs_reauth", "error"]),
  needs_reauth: new Set(["needs_reauth", "authorized", "error"]),
  disabled: new Set(["disabled", "authorized", "needs_reauth", "error"]),
  error: new Set(["error"]),
};

export const canTransitionIntegrationConnectionStatus = (
  from: IntegrationConnectionStatus,
  to: IntegrationConnectionStatus,
): boolean => allowedTransitions[from].has(to);

export const assertIntegrationConnectionStatusTransition = (
  from: IntegrationConnectionStatus,
  to: IntegrationConnectionStatus,
): void => {
  if (!canTransitionIntegrationConnectionStatus(from, to)) {
    throw new Error(`Invalid integration connection status transition: ${from} -> ${to}`);
  }
};
