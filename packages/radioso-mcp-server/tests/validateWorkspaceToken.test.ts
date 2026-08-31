import { describe, expect, it, vi } from "vitest";

import { validateWorkspaceToken } from "../src/http/validateWorkspaceToken.js";
import { RadiosoApiError } from "../src/radiosoApiAdapter.js";

describe("validateWorkspaceToken", () => {
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
      validateWorkspaceToken(
        {
          baseUrl: "http://localhost:8080",
          requestTimeoutMs: 30_000,
          serverName: "radioso-test",
        },
        "radioso_test",
        fetchMock,
      ),
    ).resolves.toMatchObject({
      workspaceId: "3f3caef3-050c-46a7-8fd7-2fa48f17fe98",
      workspaceName: "Default",
    });
  });

  it("fails when the backend does not expose the MCP context route", async () => {
    const fetchMock = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "not_found", message: "Missing route" } }), {
          headers: { "content-type": "application/json" },
          status: 404,
        }),
      );

    await expect(
      validateWorkspaceToken(
        {
          baseUrl: "http://localhost:8080",
          requestTimeoutMs: 30_000,
          serverName: "radioso-test",
        },
        "radioso_test",
        fetchMock,
      ),
    ).rejects.toMatchObject({
      code: "unsupported_capability",
      status: 404,
    } satisfies Partial<RadiosoApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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
      validateWorkspaceToken(
        {
          baseUrl: "http://localhost:8080",
          requestTimeoutMs: 30_000,
          serverName: "radioso-test",
        },
        "radioso_test",
        fetchMock,
      ),
    ).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    } satisfies Partial<RadiosoApiError>);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["personal_api", "service_account_credential"] as const)(
    "rejects a %s credential even if the context endpoint returns 200",
    async (credentialClass) => {
      const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
        new Response(JSON.stringify({
          apiVersion: "0.1.0",
          credentialClass,
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
        validateWorkspaceToken(
          {
            baseUrl: "http://localhost:8080",
            requestTimeoutMs: 30_000,
            serverName: "radioso-test",
          },
          "radioso_new_credential",
          fetchMock,
        ),
      ).rejects.toMatchObject({
        code: "invalid_access_token",
        status: 401,
      } satisfies Partial<RadiosoApiError>);
    },
  );
});
