/** @deprecated Import request-audit context from shared observability code. */
export {
  runWithRequestAuditContext,
  setRequestAuditPrincipal,
  requestAuditMetadata,
} from "../../shared/observability/requestAuditContext.js";
export type { RequestAuditPrincipal } from "../../shared/observability/requestAuditContext.js";
