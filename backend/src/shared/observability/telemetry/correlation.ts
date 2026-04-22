export interface CorrelationFields {
  requestId?: string;
  workspaceId?: string;
  accountId?: string;
  conversationId?: string;
  jobId?: string;
  documentId?: string;
  route?: string;
  method?: string;
}

interface HeaderCapable {
  header?(name: string): string | string[] | undefined;
  headers?: Record<string, string | string[] | undefined>;
}

export interface RequestCorrelationSource extends HeaderCapable {
  id?: unknown;
  method?: string;
  originalUrl?: string;
  path?: string;
}

const readHeader = (source: HeaderCapable, name: string): string | undefined => {
  const headerValue = source.header?.(name) ?? source.headers?.[name.toLowerCase()] ?? source.headers?.[name];
  if (Array.isArray(headerValue)) {
    return headerValue[0];
  }
  return typeof headerValue === "string" && headerValue.length > 0 ? headerValue : undefined;
};

export const mergeCorrelation = (...sources: Array<CorrelationFields | undefined>): CorrelationFields => {
  const merged: CorrelationFields = {};

  for (const source of sources) {
    if (!source) {
      continue;
    }

    for (const [key, value] of Object.entries(source)) {
      if (typeof value === "string" && value.length > 0) {
        merged[key as keyof CorrelationFields] = value;
      }
    }
  }

  return merged;
};

export const createRequestCorrelation = (request: RequestCorrelationSource): CorrelationFields =>
  mergeCorrelation({
    requestId:
      request.id === undefined || request.id === null
        ? undefined
        : typeof request.id === "string"
          ? request.id
          : typeof request.id === "number" || typeof request.id === "bigint"
            ? String(request.id)
            : undefined,
    workspaceId: readHeader(request, "x-workspace-id"),
    route: request.originalUrl || request.path,
    method: request.method,
  });
