import { describe, expect, it, vi } from "vitest";

import { validateWorkspaceTokenWithFallback } from "../src/http/validateWorkspaceToken.js";
import { RadiosoApiError } from "../src/radiosoApiAdapter.js";

describe("validateWorkspaceTokenWithFallback", () => {
  it("returns workspace MCP context when the backend supports it", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          apiVersion: "0.1.0",
          mcpContextVersion: "2026-04-22",
          supportedTools: ["describe_capabilities"],
          workspaceId: "3f3caef3-050c-46a7-8fd7-2fa48f17fe98",
          workspaceName: "Default",
        }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );

    await expect(
      validateWorkspaceTokenWithFallback(
        {
          baseUrl: "http://localhost:8080",
          requestTimeoutMs: 30_000,
          serverName: "radioso-test",
        },
        "sk_proj_test",
        fetchMock,
      ),
    ).resolves.toMatchObject({
      workspaceId: "3f3caef3-050c-46a7-8fd7-2fa48f17fe98",
      workspaceName: "Default",
    });
  });

  it("falls back to listDocuments only when the MCP context route is unsupported", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "not_found", message: "Missing route" } }), {
          headers: { "content-type": "application/json" },
          status: 404,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ documents: [] }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );

    await expect(
      validateWorkspaceTokenWithFallback(
        {
          baseUrl: "http://localhost:8080",
          requestTimeoutMs: 30_000,
          serverName: "radioso-test",
        },
        "sk_proj_test",
        fetchMock,
      ),
    ).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "http://localhost:8080/api/v1/document?limit=1",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer sk_proj_test",
        }),
      }),
    );
  });

  it("fails closed when the MCP context route rejects the token", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({
          error: {
            code: "forbidden",
            message: "Workspace token no longer resolves to an active workspace.",
          },
        }), {
          headers: { "content-type": "application/json" },
          status: 403,
        }),
      );

    await expect(
      validateWorkspaceTokenWithFallback(
        {
          baseUrl: "http://localhost:8080",
          requestTimeoutMs: 30_000,
          serverName: "radioso-test",
        },
        "sk_proj_test",
        fetchMock,
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    } satisfies Partial<RadiosoApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
