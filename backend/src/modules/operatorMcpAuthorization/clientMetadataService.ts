import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";

import type { OperatorMcpClientSnapshot } from "./contracts.js";
import { assertPublicHttpUrl } from "../../shared/infra/http/publicUrlFetch.js";
import { fetchPublicUrl } from "../../shared/infra/http/publicUrlFetch.js";

const MAX_METADATA_BYTES = 64 * 1024;
const MAX_REDIRECTS = 3;
const DEFAULT_TIMEOUT_MS = 5_000;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/u;

const metadataSchema = z.object({
  application_type: z.enum(["web", "native"]),
  client_id: z.string().min(1).max(2_048),
  client_name: z.string().min(1).max(256),
  client_uri: z.string().url().max(2_048).optional(),
  client_version: z.string().min(1).max(64).optional(),
  grant_types: z.array(z.string()).min(1).max(8),
  redirect_uris: z.array(z.string().url().max(2_048)).min(1).max(32),
  response_types: z.array(z.string()).min(1).max(8),
  token_endpoint_auth_method: z.string().min(1).max(64),
}).passthrough();

export class OperatorMcpClientMetadataError extends Error {
  constructor(readonly code: "invalid_client_metadata" | "metadata_unavailable" | "metadata_too_large", message: string) {
    super(message);
    this.name = "OperatorMcpClientMetadataError";
  }
}

export interface OperatorMcpClientMetadataServiceOptions {
  fetchImpl?: typeof fetch;
  assertPublicUrl?: (url: string) => void | Promise<void>;
  preregisteredClients?: ReadonlyMap<string, OperatorMcpClientMetadataSnapshot>;
  timeoutMs?: number;
  now?: () => Date;
}

export interface ResolveOperatorMcpClientMetadataInput {
  clientId: string;
  redirectUri?: string;
}

export interface OperatorMcpClientMetadataService {
  resolve(input: ResolveOperatorMcpClientMetadataInput): Promise<OperatorMcpClientMetadataSnapshot>;
}

export type OperatorMcpClientMetadataSnapshot = OperatorMcpClientSnapshot & {
  clientMetadataSnapshotId: string;
};

const canonicalJson = (value: unknown): string => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(",")}}`;
};

const safeText = (value: string, field: string, max: number): string => {
  if (value.length === 0 || value.length > max || CONTROL_CHARACTERS.test(value)) {
    throw new OperatorMcpClientMetadataError("invalid_client_metadata", `Invalid ${field}`);
  }
  return value;
};

const assertClientId = (clientId: string): void => {
  let url: URL;
  try { url = new URL(clientId); } catch { throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Invalid client metadata URL"); }
  if (url.protocol !== "https:" || url.pathname === "/" || url.search || url.hash || url.username || url.password) {
    throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Invalid client metadata URL");
  }
};

const assertRedirect = (uri: string, applicationType: "web" | "native"): string => {
  let url: URL;
  try { url = new URL(uri); } catch { throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Invalid redirect URI"); }
  if (url.username || url.password || url.hash || CONTROL_CHARACTERS.test(uri)) {
    throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Invalid redirect URI");
  }
  if (applicationType === "web" && url.protocol !== "https:") {
    throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Invalid web redirect URI");
  }
  if (applicationType === "native" && (url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname))) {
    throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Invalid native redirect URI");
  }
  return uri;
};

const readBoundedText = async (response: Response): Promise<string> => {
  const declaredLength = response.headers.get("content-length");
  if (declaredLength && Number.isFinite(Number(declaredLength)) && Number(declaredLength) > MAX_METADATA_BYTES) {
    throw new OperatorMcpClientMetadataError("metadata_too_large", "Client metadata is too large");
  }
  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > MAX_METADATA_BYTES) throw new OperatorMcpClientMetadataError("metadata_too_large", "Client metadata is too large");
    return text;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_METADATA_BYTES) throw new OperatorMcpClientMetadataError("metadata_too_large", "Client metadata is too large");
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
};

export const createOperatorMcpClientMetadataService = (options: OperatorMcpClientMetadataServiceOptions = {}): OperatorMcpClientMetadataService => {
  const fetchImpl = options.fetchImpl ?? fetchPublicUrl;
  const assertPublicUrl = options.assertPublicUrl ?? ((url: string) => assertPublicHttpUrl(url));
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? (() => new Date());

  const fetchMetadata = async (clientId: string): Promise<Record<string, unknown>> => {
    let current = clientId;
    for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
      try {
        if (new URL(current).protocol !== "https:") throw new OperatorMcpClientMetadataError("metadata_unavailable", "Client metadata redirect is invalid");
      } catch (error) {
        if (error instanceof OperatorMcpClientMetadataError) throw error;
        throw new OperatorMcpClientMetadataError("metadata_unavailable", "Client metadata redirect is invalid");
      }
      await assertPublicUrl(current);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetchImpl(current, { redirect: "manual", signal: controller.signal });
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get("location");
          if (!location || redirects === MAX_REDIRECTS) throw new OperatorMcpClientMetadataError("metadata_unavailable", "Client metadata redirect is invalid");
          try { current = new URL(location, current).toString(); } catch { throw new OperatorMcpClientMetadataError("metadata_unavailable", "Client metadata redirect is invalid"); }
          continue;
        }
        if (!response.ok) throw new OperatorMcpClientMetadataError("metadata_unavailable", "Client metadata is unavailable");
        const body = await readBoundedText(response);
        let parsed: unknown;
        try { parsed = JSON.parse(body); } catch { throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Client metadata is invalid"); }
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Client metadata is invalid");
        return parsed as Record<string, unknown>;
      } catch (error) {
        if (error instanceof OperatorMcpClientMetadataError) throw error;
        throw new OperatorMcpClientMetadataError("metadata_unavailable", "Client metadata is unavailable");
      } finally {
        clearTimeout(timer);
      }
    }
    throw new OperatorMcpClientMetadataError("metadata_unavailable", "Client metadata is unavailable");
  };

  return {
    async resolve(input) {
      const preregistered = options.preregisteredClients?.get(input.clientId);
      if (preregistered) {
        if (input.redirectUri && !preregistered.redirectUris.includes(input.redirectUri)) throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Redirect URI is not registered");
        return Object.freeze({
          ...preregistered,
          redirectUris: Object.freeze([...preregistered.redirectUris]),
          validatedAt: new Date(preregistered.validatedAt),
        });
      }
      assertClientId(input.clientId);
      const parsed = metadataSchema.safeParse(await fetchMetadata(input.clientId));
      if (!parsed.success) throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Client metadata is invalid");
      const metadata = parsed.data;
      if (metadata.client_id !== input.clientId) throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Client metadata identity mismatch");
      safeText(metadata.client_name, "client name", 256);
      if (metadata.client_version) safeText(metadata.client_version, "client version", 64);
      const supportedGrantTypes = new Set(["authorization_code", "refresh_token"]);
      if (
        metadata.response_types.some((type) => type !== "code")
        || !metadata.grant_types.includes("authorization_code")
        || metadata.grant_types.some((type) => !supportedGrantTypes.has(type))
        || metadata.token_endpoint_auth_method !== "none"
      ) {
        throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Client metadata response or grant type is incompatible");
      }
      if (metadata.client_uri) {
        const uri = new URL(metadata.client_uri);
        if (uri.protocol !== "https:" || uri.hash || uri.search || uri.username || uri.password) throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Invalid client URI");
        await assertPublicUrl(metadata.client_uri);
      }
      const redirectUris = metadata.redirect_uris.map((uri) => assertRedirect(uri, metadata.application_type));
      if (input.redirectUri && !redirectUris.includes(input.redirectUri)) throw new OperatorMcpClientMetadataError("invalid_client_metadata", "Redirect URI is not registered");
      const normalized = Object.freeze({
        applicationType: metadata.application_type,
        clientId: metadata.client_id,
        clientUri: metadata.client_uri,
        displayName: metadata.client_name,
        clientVersion: metadata.client_version ?? "1",
        grantTypes: Object.freeze([...metadata.grant_types].sort()),
        redirectUris: Object.freeze([...redirectUris].sort()),
        responseTypes: Object.freeze([...metadata.response_types].sort()),
        tokenEndpointAuthMethod: metadata.token_endpoint_auth_method,
      });
      const metadataDigest = createHash("sha256").update(canonicalJson(normalized)).digest("hex");
      const snapshotId = randomUUID();
      const snapshot: OperatorMcpClientMetadataSnapshot = {
        applicationType: normalized.applicationType,
        clientId: normalized.clientId,
        clientVersion: normalized.clientVersion,
        displayName: normalized.displayName,
        expiresAt: null,
        id: snapshotId,
        clientMetadataSnapshotId: snapshotId,
        metadataDigest,
        normalizedMetadata: normalized,
        redirectUris: Object.freeze([...normalized.redirectUris]),
        source: "metadata_document",
        validatedAt: now(),
      };
      return Object.freeze(snapshot);
    },
  };
};
