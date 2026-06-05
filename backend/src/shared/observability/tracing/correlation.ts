import type { Attributes } from "@opentelemetry/api";

import { safeTraceAttributes } from "./attributePolicy.js";

export interface TraceCorrelationFields {
  accountId?: string;
  conversationId?: string;
  documentId?: string;
  jobId?: string;
  method?: string;
  requestId?: string;
  route?: string;
  runtimeRole?: string;
  status?: number;
  workspaceId?: string;
}

export interface ActiveTraceCorrelation {
  sampled: boolean;
  spanId: string;
  traceId: string;
}

export const correlationAttributes = (fields: TraceCorrelationFields | undefined): Attributes => {
  if (!fields) {
    return {};
  }

  return safeTraceAttributes({
    "http.request.method": fields.method,
    "http.response.status_code": fields.status,
    "http.route": fields.route,
    "radioso.account_id": fields.accountId,
    "radioso.conversation_id": fields.conversationId,
    "radioso.document_id": fields.documentId,
    "radioso.job_id": fields.jobId,
    "radioso.request_id": fields.requestId,
    "radioso.runtime_role": fields.runtimeRole,
    "radioso.workspace_id": fields.workspaceId,
  });
};
