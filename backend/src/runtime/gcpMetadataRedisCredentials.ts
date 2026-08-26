import type { RedisCredentialsProvider } from "../modules/realtime/infrastructure/redisInvalidationTransport.js";

const metadataTokenEndpoint = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

/**
 * Resolves the short-lived Memorystore IAM password from the workload identity
 * exposed by Google Compute metadata. The provider deliberately fetches for
 * every node-redis credential request: node-redis calls it at each initial
 * connection and reconnect, so a stale token can never be retained here.
 */
export const createGcpMetadataRedisCredentialsProvider = (): RedisCredentialsProvider => async () => {
  let response: Response;
  try {
    response = await fetch(metadataTokenEndpoint, {
      headers: { "Metadata-Flavor": "Google" },
    });
  } catch {
    throw new Error("Realtime Redis IAM credentials are unavailable");
  }

  if (!response.ok) throw new Error("Realtime Redis IAM credentials are unavailable");

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Realtime Redis IAM credentials are unavailable");
  }

  if (!isMetadataToken(payload)) throw new Error("Realtime Redis IAM credentials are unavailable");
  return { password: payload.access_token };
};

/** A narrow composition seam; disabled environments never resolve a provider. */
export function resolveGcpRedisCredentialsProvider(iamEnabled: true): RedisCredentialsProvider;
export function resolveGcpRedisCredentialsProvider(iamEnabled: false): undefined;
export function resolveGcpRedisCredentialsProvider(iamEnabled: boolean): RedisCredentialsProvider | undefined {
  return iamEnabled ? createGcpMetadataRedisCredentialsProvider() : undefined;
}

const isMetadataToken = (value: unknown): value is { access_token: string } =>
  typeof value === "object"
  && value !== null
  && "access_token" in value
  && typeof value.access_token === "string"
  && value.access_token.length > 0;
