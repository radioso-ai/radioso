import type { Db } from "../../../src/shared/infra/kysely/types.js";
import { describe, expect, it, vi } from "vitest";

import { PostgresRealtimeSessionStore } from "../../../src/modules/realtime/http/postgresRealtimeSessionStore.js";
import { RealtimeSessionAuthenticator } from "../../../src/modules/realtime/http/realtimeSessionAuthenticator.js";
import type { RealtimeSessionAuthError } from "../../../src/modules/realtime/http/realtimeSessionAuthenticator.js";

const workspaceId = "4d7293c8-d241-4f8f-a4db-3df5b88da44c";
const independentWorkspaceId = "9d3e5cc4-a0b1-49d0-86b4-06e4db5f7a10";
const foreignAccountId = "08d5575a-e1f0-4d3a-8c91-e0f1f83bd345";
const accountId = "a5f6d0d3-98e8-4d1e-8c76-2b4f1d1de9a1";

type ProjectedSessionRow = {
  session_id: string;
  account_id: string;
  user_id: string;
  expires_at: Date;
  membership_status: "active" | "inactive" | null;
  matched_workspace_id: string | null;
  matched_workspace_account_id: string | null;
};

const sessionRow: ProjectedSessionRow = {
  session_id: "session",
  account_id: accountId,
  user_id: "user-42",
  expires_at: new Date("2026-08-26T00:00:00.000Z"),
  membership_status: "active",
  matched_workspace_id: workspaceId,
  matched_workspace_account_id: accountId,
};

const queryFixture = (row: ProjectedSessionRow | undefined) => {
  const query = {
    innerJoin: vi.fn().mockReturnThis(),
    leftJoin: vi.fn().mockReturnThis(),
    select: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    executeTakeFirst: vi.fn().mockResolvedValue(row),
  };
  const db = { selectFrom: vi.fn(() => query) } as unknown as Db;
  return { db, query };
};

const canonicalInput = {
  sessionToken: "session-token",
  requestedWorkspaceId: workspaceId,
  signal: new AbortController().signal,
};

const typedForbiddenStatus: RealtimeSessionAuthError["statusCode"] = 403;

describe("Postgres realtime session store", () => {
  it("maps projected membership/workspace aliases to active and owned true/true", async () => {
    const { db, query } = queryFixture(sessionRow);
    const store = new PostgresRealtimeSessionStore(db);
    const touchLastSeen = vi.spyOn(store, "touchLastSeen");

    await expect(store.lookup({ sessionToken: "session-token", workspaceId })).resolves.toMatchObject({
      sessionId: "session",
      accountId,
      userId: "user-42",
      workspaceId,
      sessionActive: true,
      accountMembershipActive: true,
      workspaceOwned: true,
      credentialType: "dashboard_session",
    });
    expect(query.select.mock.calls[0]?.[0]).toEqual(expect.arrayContaining([
      "sessions.id as session_id",
      "sessions.account_id",
      "sessions.user_id",
      "account_memberships.status as membership_status",
      "workspaces.id as matched_workspace_id",
      "workspaces.account_id as matched_workspace_account_id",
    ]));
    expect(query.where).toHaveBeenCalledTimes(3);
    expect(query.where).toHaveBeenCalledWith("sessions.session_token_hash", "=", expect.any(String));
    expect(query.where).toHaveBeenCalledWith("sessions.revoked_at", "is", null);
    expect(query.where).toHaveBeenCalledWith("sessions.expires_at", ">", expect.anything());
    expect(query.executeTakeFirst).toHaveBeenCalledOnce();
    expect(touchLastSeen).not.toHaveBeenCalled();
  });

  it.each([
    [
      "inactive membership",
      { ...sessionRow, membership_status: "inactive" as const },
      false,
      true,
    ],
    [
      "missing workspace",
      { ...sessionRow, matched_workspace_id: null, matched_workspace_account_id: null },
      true,
      false,
    ],
    [
      "foreign workspace",
      { ...sessionRow, matched_workspace_id: independentWorkspaceId, matched_workspace_account_id: foreignAccountId },
      true,
      false,
    ],
  ] as const)("maps %s aliases without hardcoded authorization flags", async (_label, row, expectedMembership, expectedOwned) => {
    const { db, query } = queryFixture(row);
    const store = new PostgresRealtimeSessionStore(db);
    const mapped = await store.lookup({ sessionToken: "session-token", workspaceId });
    expect(mapped).toMatchObject({ accountMembershipActive: expectedMembership, workspaceOwned: expectedOwned });
    expect(query.leftJoin).toHaveBeenCalledTimes(2);
    expect(query.innerJoin).not.toHaveBeenCalled();

    const touchLastSeen = vi.fn().mockResolvedValue(undefined);
    const authenticator = new RealtimeSessionAuthenticator({
      store: { lookup: async () => mapped, touchLastSeen },
      now: () => Date.parse("2026-08-25T00:00:00.000Z"),
    });
    await expect(authenticator.authenticate(canonicalInput)).rejects.toMatchObject(expect.objectContaining({
      statusCode: typedForbiddenStatus,
      reason: expect.any(String),
    }));
    expect(touchLastSeen).not.toHaveBeenCalled();
  });

  it("returns no row for missing/revoked/expired/token lookups without invoking last_seen", async () => {
    const { db } = queryFixture(undefined);
    const store = new PostgresRealtimeSessionStore(db);
    const touchLastSeen = vi.spyOn(store, "touchLastSeen");

    await expect(store.lookup({ sessionToken: "missing-or-revoked-or-expired-or-token", workspaceId })).resolves.toBeNull();
    expect(touchLastSeen).not.toHaveBeenCalled();
  });
});
