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
      .patch("/api/v1/account")
      .set("Cookie", member.cookie)
      .send({ organizationName: "Member Rename" })
    ).resolves.toMatchObject({ status: 403 });
  });

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
  });
});
