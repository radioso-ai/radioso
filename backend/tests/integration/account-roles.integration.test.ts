import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestSession } from "../support/testApp.js";

const acceptInvite = async (
  app: ReturnType<typeof createTestApp>["app"],
  ownerCookie: string,
  email: string,
  role: "admin" | "member",
) => {
  const invite = await request(app)
    .post("/api/v1/account/invitations")
    .set("Cookie", ownerCookie)
    .send({ email, role });
  expect(invite.status).toBe(201);

  const token = String(invite.body.acceptanceUrl).split("/").at(-1)!;
  const password = "verysecurepassword";
  const accepted = await request(app)
    .post(`/api/v1/auth/invitations/${token}/accept`)
    .send({ email, password });
  expect(accepted.status).toBe(200);

  const login = await request(app)
    .post("/api/v1/auth/login")
    .send({ email, password, preferredAccountId: accepted.body.accountId });
  expect(login.status).toBe(200);

  return {
    cookie: login.headers["set-cookie"][0] as string,
    userId: accepted.body.userId as string,
    accountId: accepted.body.accountId as string,
    workspaceId: accepted.body.workspaceId as string,
  };
};

describe("organization roles", () => {
  it("assigns the selected invitation role and blocks member-only sensitive operations", async () => {
    const { app } = createTestApp();
    const owner = await issueTestSession(app, `owner-${Date.now()}@example.com`);
    const member = await acceptInvite(app, owner.cookie, `member-${Date.now()}@example.com`, "member");

    const users = await request(app).get("/api/v1/account/users").set("Cookie", owner.cookie);
    expect(users.body.users.find((user: { userId: string }) => user.userId === member.userId)).toMatchObject({
      role: "member",
    });

    await expect(request(app)
      .post("/api/v1/workspace")
      .set("Cookie", member.cookie)
      .send({ name: "Blocked Workspace" })
    ).resolves.toMatchObject({ status: 403 });

    const token = await request(app)
      .get(`/api/v1/account/workspaces/${member.workspaceId}/token`)
      .set("Cookie", member.cookie);
    expect(token.status).toBe(200);
    expect(typeof token.body.token).toBe("string");

    await expect(request(app)
      .post(`/api/v1/account/workspaces/${member.workspaceId}/token/rotate`)
      .set("Cookie", member.cookie)
    ).resolves.toMatchObject({ status: 403 });

    await expect(request(app)
      .patch(`/api/v1/workspace/${member.workspaceId}`)
      .set("Cookie", member.cookie)
      .send({ name: "Member Workspace Rename" })
    ).resolves.toMatchObject({ status: 403 });

    await expect(request(app)
      .patch("/api/v1/account")
      .set("Cookie", member.cookie)
      .send({ organizationName: "Member Rename" })
    ).resolves.toMatchObject({ status: 403 });
  }, 20_000);

  it("restricts provider credential and llm-model writes to admin+, but lets members read", async () => {
    const { app } = createTestApp();
    const owner = await issueTestSession(app, `owner-${Date.now()}@example.com`);
    const member = await acceptInvite(app, owner.cookie, `member-${Date.now()}@example.com`, "member");

    const memberHeaders = { Cookie: member.cookie, "X-Workspace-Id": member.workspaceId };
    const ownerHeaders = { Cookie: owner.cookie, "X-Workspace-Id": owner.workspaceId };

    // Members can read credentials (the list is masked).
    const memberCredList = await request(app)
      .get("/api/v1/settings/credentials")
      .set(memberHeaders);
    expect(memberCredList.status).toBe(200);

    // Members cannot store an API key — billing-relevant secret writes are admin+.
    const memberCredWrite = await request(app)
      .put("/api/v1/settings/credentials/openai")
      .set(memberHeaders)
      .send({ apiKey: "sk-from-member" });
    expect(memberCredWrite.status).toBe(403);

    const memberCredDelete = await request(app)
      .delete("/api/v1/settings/credentials/openai")
      .set(memberHeaders);
    expect(memberCredDelete.status).toBe(403);

    // Members can read llm-model preferences but cannot change workspace defaults.
    const memberModelRead = await request(app)
      .get("/api/v1/settings/llm-models")
      .set(memberHeaders);
    expect(memberModelRead.status).toBe(200);

    const memberModelWrite = await request(app)
      .put("/api/v1/settings/llm-models")
      .set(memberHeaders)
      .send({ chat: { provider: "claude", model: "claude-sonnet-4-5" } });
    expect(memberModelWrite.status).toBe(403);

    // Owners (and by extension admins via the role hierarchy) can write both.
    const ownerCredWrite = await request(app)
      .put("/api/v1/settings/credentials/openai")
      .set(ownerHeaders)
      .send({ apiKey: "sk-from-owner" });
    expect(ownerCredWrite.status).toBe(204);

    const ownerModelWrite = await request(app)
      .put("/api/v1/settings/llm-models")
      .set(ownerHeaders)
      .send({ chat: { provider: "claude", model: "claude-sonnet-4-5" } });
    expect(ownerModelWrite.status).toBe(200);
  }, 20_000);

  it("allows admins to manage workspaces and tokens but not remove owners", async () => {
    const { app } = createTestApp();
    const owner = await issueTestSession(app, `owner-${Date.now()}@example.com`);
    const admin = await acceptInvite(app, owner.cookie, `admin-${Date.now()}@example.com`, "admin");

    const createWorkspace = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", admin.cookie)
      .send({ name: "Admin Workspace" });
    expect(createWorkspace.status).toBe(201);

    const token = await request(app)
      .get(`/api/v1/account/workspaces/${admin.workspaceId}/token`)
      .set("Cookie", admin.cookie);
    expect(token.status).toBe(200);

    const users = await request(app).get("/api/v1/account/users").set("Cookie", admin.cookie);
    const ownerMembership = users.body.users.find((user: { role: string }) => user.role === "owner");
    const removeOwner = await request(app)
      .delete(`/api/v1/account/users/${ownerMembership.membershipId}`)
      .set("Cookie", admin.cookie);
    expect(removeOwner.status).toBe(403);
  });

  it("lets managers revoke a pending invitation so it disappears from the member list", async () => {
    const { app } = createTestApp();
    const owner = await issueTestSession(app, `owner-${Date.now()}@example.com`);
    const inviteeEmail = `pending-${Date.now()}@example.com`;

    const invite = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", owner.cookie)
      .send({ email: inviteeEmail, role: "member" });
    expect(invite.status).toBe(201);

    const usersBefore = await request(app).get("/api/v1/account/users").set("Cookie", owner.cookie);
    expect(usersBefore.body.invitations).toContainEqual(expect.objectContaining({
      id: invite.body.id,
      email: inviteeEmail,
      status: "pending",
    }));

    const revoked = await request(app)
      .delete(`/api/v1/account/invitations/${invite.body.id}`)
      .set("Cookie", owner.cookie);
    expect(revoked.status).toBe(204);

    const usersAfter = await request(app).get("/api/v1/account/users").set("Cookie", owner.cookie);
    expect(usersAfter.body.invitations.find((invitation: { id: string }) => invitation.id === invite.body.id)).toMatchObject({
      status: "revoked",
    });
  });

  it("returns 404 when revoking an invitation from another organization", async () => {
    const { app } = createTestApp();
    const accountA = await issueTestSession(app, `owner-a-${Date.now()}@example.com`);
    const accountB = await issueTestSession(app, `owner-b-${Date.now()}@example.com`);

    const invite = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", accountA.cookie)
      .send({ email: `pending-${Date.now()}@example.com`, role: "member" });
    expect(invite.status).toBe(201);

    const response = await request(app)
      .delete(`/api/v1/account/invitations/${invite.body.id}`)
      .set("Cookie", accountB.cookie);
    expect(response.status).toBe(404);
  });

  it("prevents admins from changing their own permissions", async () => {
    const { app } = createTestApp();
    const owner = await issueTestSession(app, `owner-${Date.now()}@example.com`);
    const admin = await acceptInvite(app, owner.cookie, `admin-${Date.now()}@example.com`, "admin");

    const users = await request(app).get("/api/v1/account/users").set("Cookie", admin.cookie);
    const adminMembership = users.body.users.find((user: { userId: string }) => user.userId === admin.userId);
    expect(adminMembership).toBeDefined();

    const selfRoleChange = await request(app)
      .patch(`/api/v1/account/users/${adminMembership.membershipId}`)
      .set("Cookie", admin.cookie)
      .send({ role: "member" });
    expect(selfRoleChange.status).toBe(409);
    expect(selfRoleChange.body.error.message).toBe("Users cannot change their own role");

    const selfWorkspaceGrant = await request(app)
      .put(`/api/v1/account/workspaces/${admin.workspaceId}/grants/${admin.userId}`)
      .set("Cookie", admin.cookie)
      .send({ role: "member" });
    expect(selfWorkspaceGrant.status).toBe(409);
    expect(selfWorkspaceGrant.body.error.message).toBe("Users cannot change their own workspace access");
  });

  it("removes workspace grants when account access is removed", async () => {
    const { app } = createTestApp();
    const owner = await issueTestSession(app, `owner-${Date.now()}@example.com`);
    const member = await acceptInvite(app, owner.cookie, `member-${Date.now()}@example.com`, "member");

    const grant = await request(app)
      .put(`/api/v1/account/workspaces/${owner.workspaceId}/grants/${member.userId}`)
      .set("Cookie", owner.cookie)
      .send({ role: "admin" });
    expect(grant.status).toBe(200);

    const usersBeforeRemove = await request(app).get("/api/v1/account/users").set("Cookie", owner.cookie);
    const memberRecord = usersBeforeRemove.body.users.find((user: { userId: string }) => user.userId === member.userId);
    expect(memberRecord).toBeDefined();
    expect(usersBeforeRemove.body.workspaceGrants).toContainEqual(expect.objectContaining({
      workspaceId: owner.workspaceId,
      userId: member.userId,
      role: "admin",
    }));

    const removed = await request(app)
      .delete(`/api/v1/account/users/${memberRecord.membershipId}`)
      .set("Cookie", owner.cookie);
    expect(removed.status).toBe(204);

    const usersAfterRemove = await request(app).get("/api/v1/account/users").set("Cookie", owner.cookie);
    expect(usersAfterRemove.body.workspaceGrants).not.toContainEqual(expect.objectContaining({
      workspaceId: owner.workspaceId,
      userId: member.userId,
    }));
  });

  it("rejects workspace grant updates for workspaces outside the current organization", async () => {
    const { app } = createTestApp();
    const accountA = await issueTestSession(app, `owner-a-${Date.now()}@example.com`);
    const accountB = await issueTestSession(app, `owner-b-${Date.now()}@example.com`);

    const response = await request(app)
      .put(`/api/v1/account/workspaces/${accountB.workspaceId}/grants/${accountA.userId}`)
      .set("Cookie", accountA.cookie)
      .send({ role: "admin" });

    expect(response.status).toBe(404);
    expect(response.body.error.message).toBe("Workspace not found");
  }, 20_000);

  it("returns 400 for malformed workspace grant route ids", async () => {
    const { app } = createTestApp();
    const owner = await issueTestSession(app, `owner-${Date.now()}@example.com`);

    const update = await request(app)
      .put(`/api/v1/account/workspaces/not-a-uuid/grants/${owner.userId}`)
      .set("Cookie", owner.cookie)
      .send({ role: "admin" });
    const remove = await request(app)
      .delete(`/api/v1/account/workspaces/not-a-uuid/grants/${owner.userId}`)
      .set("Cookie", owner.cookie);

    expect(update.status).toBe(400);
    expect(update.body.error.message).toBe("Invalid workspace grant parameters");
    expect(remove.status).toBe(400);
    expect(remove.body.error.message).toBe("Invalid workspace grant parameters");
  });

  it("does not remove workspace grants across organizations", async () => {
    const { app } = createTestApp();
    const accountA = await issueTestSession(app, `owner-a-${Date.now()}@example.com`);
    const accountB = await issueTestSession(app, `owner-b-${Date.now()}@example.com`);
    const memberB = await acceptInvite(app, accountB.cookie, `member-b-${Date.now()}@example.com`, "member");

    const grant = await request(app)
      .put(`/api/v1/account/workspaces/${accountB.workspaceId}/grants/${memberB.userId}`)
      .set("Cookie", accountB.cookie)
      .send({ role: "admin" });
    expect(grant.status).toBe(200);

    const blockedDelete = await request(app)
      .delete(`/api/v1/account/workspaces/${accountB.workspaceId}/grants/${memberB.userId}`)
      .set("Cookie", accountA.cookie);
    expect(blockedDelete.status).toBe(404);
    expect(blockedDelete.body.error.message).toBe("Workspace not found");

    const users = await request(app).get("/api/v1/account/users").set("Cookie", accountB.cookie);
    expect(users.body.workspaceGrants).toContainEqual(expect.objectContaining({
      workspaceId: accountB.workspaceId,
      userId: memberB.userId,
      role: "admin",
    }));
  }, 20_000);
});
