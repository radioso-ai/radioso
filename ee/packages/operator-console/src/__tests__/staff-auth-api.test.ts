import { afterEach, describe, expect, it, vi } from "vitest";

import { StaffApiError, staffAuthApi } from "../lib/staff-auth-api";

const jsonResponse = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("staff auth api", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("posts login with included credentials", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      staff: {
        id: "staff-1",
        email: "owner@example.com",
        name: "Owner",
        role: "owner",
        status: "active",
        lastLoginAt: null,
      },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await staffAuthApi.login({ email: "owner@example.com", password: "password-123" });

    expect(result.staff.role).toBe("owner");
    expect(fetchMock).toHaveBeenCalledWith("/backend/api/v1/ee/operator-console/auth/login", expect.objectContaining({
      method: "POST",
      credentials: "include",
      body: JSON.stringify({ email: "owner@example.com", password: "password-123" }),
    }));
    const firstCall = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = firstCall[1].headers as Headers;
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("builds organization query parameters", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({
      rows: [],
      pageInfo: { limit: 25, offset: 0, nextOffset: null, hasMore: false },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await staffAuthApi.listOrganizations({ limit: 25, offset: 50, search: " Alpha " });

    expect(fetchMock).toHaveBeenCalledWith(
      "/backend/api/v1/ee/operator-console/organizations?limit=25&offset=50&search=Alpha",
      expect.objectContaining({ credentials: "include" }),
    );
  });

  it("throws typed errors from api error bodies", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      error: { code: "forbidden", message: "Forbidden" },
    }, { status: 403 })));

    await expect(staffAuthApi.listStaff()).rejects.toMatchObject({
      name: "StaffApiError",
      status: 403,
      code: "forbidden",
      message: "Forbidden",
    } satisfies Partial<StaffApiError>);
  });
});
