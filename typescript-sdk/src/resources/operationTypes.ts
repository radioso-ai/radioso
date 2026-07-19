import type { operations } from "../generated/types.js";

/**
 * Type helpers for endpoints whose request/response bodies are declared inline in
 * the OpenAPI document (no named `components.schemas` entry). openapi-typescript
 * emits those under the `operations` map keyed by operationId, so we extract the
 * JSON request body and the 2xx JSON response shape from there.
 */
export type OperationId = keyof operations;

type JsonContent<T> = T extends { content: { "application/json": infer J } } ? J : never;

/** JSON request body type for an operation, or `never` when it takes no body. */
export type RequestBodyOf<Id extends OperationId> =
  operations[Id] extends { requestBody: { content: { "application/json": infer B } } } ? B : never;

/** Query parameter type for an operation, or `never` when it takes no query parameters. */
export type QueryParamsOf<Id extends OperationId> =
  operations[Id] extends { parameters: { query: infer Q } } ? Q : never;

/** JSON success (200/201) response type for an operation, or `never` for no-content responses. */
export type OkResponseOf<Id extends OperationId> =
  operations[Id] extends { responses: infer R }
    ? { [Status in keyof R & (200 | 201)]: JsonContent<R[Status]> }[keyof R & (200 | 201)]
    : never;
