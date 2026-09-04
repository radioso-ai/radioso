import { describe, expect, it, vi } from "vitest";
import { createOperatorMcpClientMetadataService } from "../../../src/modules/operatorMcpAuthorization/clientMetadataService.js";

const clientId = "https://client.example/.well-known/radioso-client.json";
const metadata = {
  application_type: "web",
  client_id: clientId,
  client_name: "Example client",
  client_uri: "https://client.example/app",
  grant_types: ["authorization_code"],
  redirect_uris: ["https://client.example/oauth/callback"],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};

const response = (body: unknown, init: ResponseInit = {}): Response => new Response(JSON.stringify(body), {
  headers: { "content-type": "application/json", ...init.headers },
  status: 200,
  ...init,
});

describe("operator MCP client metadata", () => {
  it("fetches bounded CIMD, validates exact identity/redirects, and returns an immutable digest snapshot", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response(metadata));
    const service = createOperatorMcpClientMetadataService({ fetchImpl, now: () => new Date("2026-09-04T00:00:00Z") });
    const resolved = await service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] });
    expect(resolved.clientId).toBe(clientId);
    expect(resolved.redirectUris).toEqual(metadata.redirect_uris);
    expect(resolved.metadataDigest).toMatch(/^[a-f0-9]{64}$/u);
    expect(resolved.clientMetadataSnapshotId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(Object.isFrozen(resolved.redirectUris)).toBe(true);
    expect(Object.isFrozen(resolved.normalizedMetadata)).toBe(true);
    expect(resolved.normalizedMetadata).toMatchObject({
      clientId, clientUri: metadata.client_uri, grantTypes: ["authorization_code"], responseTypes: ["code"],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("accepts the refresh token grant advertised by the authorization server", async () => {
    const withRefresh = { ...metadata, grant_types: ["authorization_code", "refresh_token"] };
    const service = createOperatorMcpClientMetadataService({
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response(withRefresh)),
    });

    await expect(service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] })).resolves.toMatchObject({
      normalizedMetadata: { grantTypes: ["authorization_code", "refresh_token"] },
    });
  });

  it("rejects self-mutation, unsafe redirects, unsupported clients, and oversized metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(response({ ...metadata, client_id: "https://other.example/client" }));
    const service = createOperatorMcpClientMetadataService({ fetchImpl });
    await expect(service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] })).rejects.toThrow(/client_id|metadata/i);

    fetchImpl.mockResolvedValue(response({ ...metadata, redirect_uris: ["http://localhost/callback"] }));
    await expect(service.resolve({ clientId, redirectUri: "http://localhost/callback" })).rejects.toThrow(/redirect|loopback|localhost/i);

    fetchImpl.mockResolvedValue(response({ ...metadata, response_types: ["token"] }));
    await expect(service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] })).rejects.toThrow(/response|grant/i);

    fetchImpl.mockResolvedValue(response({ ...metadata, grant_types: ["authorization_code", "client_credentials"] }));
    await expect(service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] })).rejects.toThrow(/response|grant/i);

    fetchImpl.mockResolvedValue(response({ ...metadata, grant_types: ["refresh_token"] }));
    await expect(service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] })).rejects.toThrow(/response|grant/i);

    fetchImpl.mockResolvedValue(new Response("x".repeat(70_000), { headers: { "content-length": "70000" }, status: 200 }));
    await expect(service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] })).rejects.toThrow(/size|large/i);
  });

  it("follows at most three validated public redirects and passes an abort signal", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { location: "https://client.example/one" }, status: 302 }))
      .mockResolvedValueOnce(new Response(null, { headers: { location: "https://client.example/two" }, status: 302 }))
      .mockResolvedValueOnce(new Response(null, { headers: { location: "https://client.example/three" }, status: 302 }))
      .mockResolvedValueOnce(response(metadata));
    const service = createOperatorMcpClientMetadataService({ fetchImpl, timeoutMs: 1000 });
    await expect(service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] })).resolves.toMatchObject({ clientId });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).redirect).toBe("manual");
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit).signal).toEqual(expect.any(AbortSignal));

    fetchImpl.mockReset().mockResolvedValueOnce(new Response(null, { headers: { location: "http://client.example/downgrade" }, status: 302 }));
    await expect(service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] })).rejects.toThrow(/redirect/i);

    fetchImpl.mockReset().mockResolvedValueOnce(new Response(null, { headers: { location: "https://client.example/one" }, status: 302 }));
    fetchImpl.mockResolvedValueOnce(new Response(null, { headers: { location: "https://client.example/two" }, status: 302 }));
    fetchImpl.mockResolvedValueOnce(new Response(null, { headers: { location: "https://client.example/three" }, status: 302 }));
    fetchImpl.mockResolvedValueOnce(new Response(null, { headers: { location: "https://client.example/four" }, status: 302 }));
    await expect(service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] })).rejects.toThrow(/redirect/i);
  });

  it("pins every redirect hop through the public URL policy and times out stalled metadata", async () => {
    const assertPublicUrl = vi.fn<(url: string) => void>((url) => {
      if (url.endsWith("/private")) throw new Error("private destination");
    });
    const redirecting = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { headers: { location: "https://client.example/private" }, status: 302 }));
    const service = createOperatorMcpClientMetadataService({ assertPublicUrl, fetchImpl: redirecting });
    await expect(service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] })).rejects.toThrow(/private|public/i);
    expect(assertPublicUrl).toHaveBeenCalledTimes(2);

    const stalled = vi.fn<typeof fetch>().mockImplementation((_input, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "AbortError")), { once: true });
    }));
    await expect(createOperatorMcpClientMetadataService({ fetchImpl: stalled, timeoutMs: 1 }).resolve({ clientId, redirectUri: metadata.redirect_uris[0] })).rejects.toMatchObject({ code: "metadata_unavailable" });
  });

  it("allows only literal native loopback redirects and supports immutable preregistration", async () => {
    const native = { ...metadata, application_type: "native", redirect_uris: ["http://127.0.0.1:43123/oauth/callback"] };
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => response(native));
    await expect(createOperatorMcpClientMetadataService({ fetchImpl }).resolve({ clientId, redirectUri: native.redirect_uris[0] })).resolves.toMatchObject({ applicationType: "native" });
    await expect(createOperatorMcpClientMetadataService({ fetchImpl }).resolve({ clientId, redirectUri: "http://127.0.0.1:54131/oauth/callback" })).resolves.toMatchObject({ applicationType: "native" });
    fetchImpl.mockResolvedValue(response({ ...native, redirect_uris: ["http://localhost:43123/oauth/callback"] }));
    await expect(createOperatorMcpClientMetadataService({ fetchImpl }).resolve({ clientId, redirectUri: "http://localhost:43123/oauth/callback" })).rejects.toThrow(/redirect|native/i);

    const preregistered = Object.freeze({
      applicationType: "native" as const, clientId: "com.example.app", clientMetadataSnapshotId: "snapshot-1", clientVersion: "1",
      displayName: "Pre-registered", expiresAt: null, id: "snapshot-1", metadataDigest: "d".repeat(64),
      normalizedMetadata: Object.freeze({ clientId: "com.example.app", redirectUris: ["com.example.app:/oauth/callback"] }),
      redirectUris: Object.freeze(["com.example.app:/oauth/callback"]), source: "preregistered" as const,
      validatedAt: new Date("2026-09-04T00:00:00Z"),
    });
    const registered = createOperatorMcpClientMetadataService({ preregisteredClients: new Map([[preregistered.clientId, preregistered]]) });
    await expect(registered.resolve({ clientId: preregistered.clientId, redirectUri: preregistered.redirectUris[0] })).resolves.toMatchObject({ source: "preregistered" });
    await expect(registered.resolve({ clientId: preregistered.clientId, redirectUri: "com.example.other:/callback" })).rejects.toThrow(/redirect/i);
  });

  it("keeps a validated snapshot stable when a later resolution returns mutated metadata", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(response(metadata)).mockResolvedValueOnce(response({ ...metadata, client_name: "Mutated client" }));
    const service = createOperatorMcpClientMetadataService({ fetchImpl });
    const first = await service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] });
    const second = await service.resolve({ clientId, redirectUri: metadata.redirect_uris[0] });
    expect(first.displayName).toBe("Example client");
    expect(second.displayName).toBe("Mutated client");
    expect(first.metadataDigest).not.toBe(second.metadataDigest);
  });
});
