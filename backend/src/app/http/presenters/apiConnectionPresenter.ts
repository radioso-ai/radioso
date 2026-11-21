import type { ApiConnection } from "../../../modules/apiRequestSkills/public.js";

/** A connection as the API returns it: the credential only as its masked tail, never in full. */
export const presentApiConnection = (connection: ApiConnection) => ({
  id: connection.id,
  name: connection.name,
  baseUrl: connection.baseUrl,
  authScheme: connection.authScheme,
  authHeaderName: connection.authHeaderName,
  credentialMask: connection.credentialMask,
  defaultHeaders: connection.defaultHeaders,
  createdAt: connection.createdAt.toISOString(),
  updatedAt: connection.updatedAt.toISOString(),
});
