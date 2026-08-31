import { AsyncLocalStorage } from "node:async_hooks";

export interface RequestAuditPrincipal {
  credentialId: string;
  principalId: string;
  principalKind: "user" | "service";
  role: "member" | "admin";
}

interface RequestAuditContext {
  requestId?: string;
  principal?: RequestAuditPrincipal;
}

const requestAuditStorage = new AsyncLocalStorage<RequestAuditContext>();

export const runWithRequestAuditContext = <T>(
  context: Pick<RequestAuditContext, "requestId">,
  callback: () => T,
): T => requestAuditStorage.run({ ...context }, callback);

export const setRequestAuditPrincipal = (principal: RequestAuditPrincipal): void => {
  const context = requestAuditStorage.getStore();
  if (context) context.principal = principal;
};

export const requestAuditMetadata = (eventType: string): Record<string, unknown> | undefined => {
  const context = requestAuditStorage.getStore();
  if (!context || (!context.principal && !eventType.startsWith("machine_access."))) return undefined;
  const principal = context.principal;
  return {
    ...(context.requestId ? { requestId: context.requestId } : {}),
    ...(principal ? {
      credentialId: principal.credentialId,
      principalId: principal.principalId,
      principalKind: principal.principalKind,
      role: principal.role,
    } : {}),
  };
};
