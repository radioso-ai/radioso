import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp } from "../support/testApp.js";
import { AccountAccessService } from "../../src/modules/account/services/accountAccessService.js";
import { AccountInvitationService } from "../../src/modules/account/services/accountInvitationService.js";
import { AuthService } from "../../src/modules/auth/services/authService.js";
import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import {
  createAuditService,
  InMemoryAccountRepository,
  InMemoryAccountInvitationRepository,
  InMemoryAccountMembershipRepository,
  InMemoryUserRepository,
  InMemoryWorkspaceRepository,
  InMemoryWorkspaceTokenRepository,
  InMemorySessionRepository,
} from "../support/fakes.js";
import { createTestEnv } from "../support/testApp.js";

describe("auth integration", () => {
  it("rejects duplicate registrations", async () => {
    const { app } = createTestApp();

    await request(app).post("/api/v1/auth/register").send({
      email: "duplicate@example.com",
      password: "verysecurepassword",
    });

    const response = await request(app).post("/api/v1/auth/register").send({
      email: "duplicate@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe("conflict");
  });

  it("rejects invalid login credentials", async () => {
    const { app } = createTestApp();

    await request(app).post("/api/v1/auth/register").send({
      email: "login@example.com",
      password: "verysecurepassword",
    });

    const response = await request(app).post("/api/v1/auth/login").send({
      email: "login@example.com",
      password: "wrong-password",
    });

    expect(response.status).toBe(401);
    expect(response.body.error.code).toBe("unauthorized");
  });

  it("returns the default workspace bootstrap data from registration", async () => {
    const { app } = createTestApp();

    const response = await request(app).post("/api/v1/auth/register").send({
      email: "bootstrap@example.com",
      password: "verysecurepassword",
    });

    expect(response.status).toBe(201);
    expect(response.body.accountId).toBeDefined();
    expect(response.body.organizationName).toBe("Bootstrap Organization");
    expect(response.body.workspaceName).toBe("Default");
    expect(response.body.workspaceId).toBeDefined();
    expect(response.body.token).toBeUndefined();
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
  });

  it("supports multi-workspace session flows and explicit token reveal", async () => {
    const { app } = createTestApp();
    const register = await request(app).post("/api/v1/auth/register").send({
      email: "repeat@example.com",
      password: "verysecurepassword",
    });
    const cookie = register.headers["set-cookie"][0] as string;
    const defaultWorkspaceId = register.body.workspaceId as string;

    const created = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", cookie)
      .send({ name: "Research" });

    const login = await request(app).post("/api/v1/auth/login").send({
      email: "repeat@example.com",
      password: "verysecurepassword",
      preferredWorkspaceId: created.body.id,
    });

    const loginCookie = login.headers["set-cookie"]?.[0] as string;
    const preferredSettings = await request(app)
      .get("/api/v1/settings/general")
      .set("Cookie", loginCookie)
      .set("X-Workspace-Id", created.body.id);
    const defaultSettings = await request(app)
      .get("/api/v1/settings/general")
      .set("Cookie", loginCookie)
      .set("X-Workspace-Id", defaultWorkspaceId);
    const tokenRoute = await request(app)
      .get(`/api/v1/account/workspaces/${created.body.id}/token`)
      .set("Cookie", loginCookie);

    expect(login.status).toBe(200);
    expect(login.body.workspaceId).toBe(created.body.id);
    expect(login.body.token).toBeUndefined();
    expect(preferredSettings.status).toBe(200);
    expect(defaultSettings.status).toBe(200);
    expect(tokenRoute.status).toBe(200);
    expect(tokenRoute.body.token).toMatch(/^sk_proj_[a-f0-9]+$/);
  });

  it("rotates an unreadable stored token instead of failing", async () => {
    const env = createTestEnv();
    const auditService = createAuditService();
    const accountRepository = new InMemoryAccountRepository();
    const userRepository = new InMemoryUserRepository();
    const accountMembershipRepository = new InMemoryAccountMembershipRepository();
    accountMembershipRepository.setUserRepository(userRepository);
    const accountAccessService = new AccountAccessService(accountMembershipRepository, auditService);
    const accountInvitationService = new AccountInvitationService(
      new InMemoryAccountInvitationRepository(),
      userRepository,
      accountAccessService,
      auditService,
    );
    const sessionRepository = new InMemorySessionRepository();
    const workspaceTokenRepository = new InMemoryWorkspaceTokenRepository();
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspaceService = new WorkspaceService(workspaceRepository, auditService);
    const authService = new AuthService({
      env,
      auditService,
      accountRepository,
      userRepository,
      sessionRepository,
      workspaceTokenRepository,
      workspaceService,
      accountAccessService,
      accountInvitationService,
    });

    const account = await accountRepository.create({
      name: "Rotate Organization",
      email: "rotate@example.com",
      passwordHash: "hash",
    });
    await userRepository.create({
      id: account.id,
      email: account.email,
      passwordHash: account.passwordHash,
    });
    await accountAccessService.ensureMembership({
      accountId: account.id,
      userId: account.id,
      role: "owner",
    });
    const workspace = await workspaceService.createDefault(account.id);

    await workspaceTokenRepository.save({
      workspaceId: workspace.id,
      accountId: account.id,
      tokenPrefix: "sk_proj_",
      tokenHash: "stale-hash",
      encryptedToken: "not:a:valid-token",
    });

    const result = await authService.getTokenForWorkspace(workspace.id, account.id);

    expect(result.token).toMatch(/^sk_proj_[a-f0-9]+$/);
    expect(auditService.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          eventType: "auth.token.read",
          eventStatus: "failure",
        }),
        expect.objectContaining({
          eventType: "auth.token.create",
          eventStatus: "success",
        }),
      ]),
    );
  });

  it("does not create a second default workspace for the same account", async () => {
    const auditService = createAuditService();
    const workspaceRepository = new InMemoryWorkspaceRepository();
    const workspaceService = new WorkspaceService(workspaceRepository, auditService);
    const accountRepository = new InMemoryAccountRepository();
    const account = await accountRepository.create({
      name: "Default Workspace Organization",
      email: "default-workspace@example.com",
      passwordHash: "hash",
    });

    const first = await workspaceService.createDefault(account.id);
    const second = await workspaceService.createDefault(account.id);
    const workspaces = await workspaceRepository.listByAccountId(account.id);

    expect(second.id).toBe(first.id);
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0]?.name).toBe("Default");
  });

  it("returns the preferred workspace on login when the account already has multiple workspaces", async () => {
    const { app } = createTestApp();

    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "multi-workspace@example.com",
      password: "verysecurepassword",
    });

    const cookie = registration.headers["set-cookie"]?.[0];
    const created = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", cookie)
      .send({ name: "Research" });

    const response = await request(app).post("/api/v1/auth/login").send({
      email: "multi-workspace@example.com",
      password: "verysecurepassword",
      preferredWorkspaceId: created.body.id,
    });

    expect(response.status).toBe(200);
    expect(response.body.accountId).toBe(registration.body.accountId);
    expect(response.body.organizationName).toBe("Multi Workspace Organization");
    expect(response.body.workspaceId).toBe(created.body.id);
    expect(response.body.workspaceName).toBe("Research");
    expect(response.body.token).toBeUndefined();
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
  });

  it("lets an invited user access the shared account workspaces", async () => {
    const { app } = createTestApp();

    const owner = await request(app).post("/api/v1/auth/register").send({
      email: "owner-shared@example.com",
      password: "verysecurepassword",
    });
    const ownerCookie = owner.headers["set-cookie"]?.[0];

    const createdWorkspace = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", ownerCookie)
      .send({ name: "Shared Workspace" });

    const invitation = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", ownerCookie)
      .send({ email: "teammate-shared@example.com" });
    const invitationToken = invitation.body.acceptanceUrl.split("/").at(-1);

    const accepted = await request(app)
      .post(`/api/v1/auth/invitations/${invitationToken}/accept`)
      .send({
        email: "teammate-shared@example.com",
        password: "verysecurepassword",
      });

    const invitedCookie = accepted.headers["set-cookie"]?.[0];
    const workspaces = await request(app)
      .get("/api/v1/workspace")
      .set("Cookie", invitedCookie);

    expect(workspaces.status).toBe(200);
    expect(workspaces.body.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual(
      expect.arrayContaining([owner.body.workspaceId, createdWorkspace.body.id]),
    );
  });

  it("creates a new organization for the signed-in user and switches the session to it", async () => {
    const { app } = createTestApp();

    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "multi-org@example.com",
      password: "verysecurepassword",
    });

    const response = await request(app)
      .post("/api/v1/account/accounts")
      .set("Cookie", registration.headers["set-cookie"]?.[0])
      .send({ organizationName: "Second Organization" });

    expect(response.status).toBe(201);
    expect(response.body.userId).toBe(registration.body.userId);
    expect(response.body.accountId).not.toBe(registration.body.accountId);
    expect(response.body.organizationName).toBe("Second Organization");
    expect(response.body.workspaceName).toBe("Default");
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
  });

  it("does not leave behind a user when invitation acceptance fails for a new email", async () => {
    const { app, dependencies } = createTestApp();

    const owner = await request(app).post("/api/v1/auth/register").send({
      email: "owner-expired@example.com",
      password: "verysecurepassword",
    });
    const ownerCookie = owner.headers["set-cookie"]?.[0];

    const invitation = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", ownerCookie)
      .send({ email: "new-user-expired@example.com" });
    const invitationToken = invitation.body.acceptanceUrl.split("/").at(-1);

    const invitationRecord = await dependencies.accountInvitationService["invitationRepository"].findPendingByAccountAndEmail(
      owner.body.accountId,
      "new-user-expired@example.com",
    );
    if (!invitationRecord) {
      throw new Error("Expected invitation record");
    }
    await dependencies.accountInvitationService["invitationRepository"].update({
      id: invitationRecord.id,
      status: "revoked",
    });

    const accepted = await request(app)
      .post(`/api/v1/auth/invitations/${invitationToken}/accept`)
      .send({
        email: "new-user-expired@example.com",
        password: "verysecurepassword",
      });

    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "new-user-expired@example.com",
      password: "verysecurepassword",
    });

    expect(accepted.status).toBe(409);
    expect(registration.status).toBe(201);
  });

  it("lets an account owner remove a member and immediately revoke that account access", async () => {
    const { app } = createTestApp();

    const owner = await request(app).post("/api/v1/auth/register").send({
      email: "owner-remove@example.com",
      password: "verysecurepassword",
    });
    const ownerCookie = owner.headers["set-cookie"]?.[0];

    const invitation = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", ownerCookie)
      .send({ email: "member-remove@example.com" });
    const invitationToken = invitation.body.acceptanceUrl.split("/").at(-1);

    const accepted = await request(app)
      .post(`/api/v1/auth/invitations/${invitationToken}/accept`)
      .send({
        email: "member-remove@example.com",
        password: "verysecurepassword",
      });
    const memberCookie = accepted.headers["set-cookie"]?.[0];

    const beforeRemoval = await request(app)
      .get("/api/v1/account/users")
      .set("Cookie", ownerCookie);
    const memberEntry = beforeRemoval.body.users.find((user: { email: string }) => user.email === "member-remove@example.com");

    const removed = await request(app)
      .delete(`/api/v1/account/users/${memberEntry.membershipId}`)
      .set("Cookie", ownerCookie);

    const memberAccess = await request(app)
      .get("/api/v1/workspace")
      .set("Cookie", memberCookie);

    expect(removed.status).toBe(204);
    expect(memberAccess.status).toBe(401);
  });

  it("still lets a removed user list and switch to other accessible accounts from the same session", async () => {
    const { app } = createTestApp();

    const primaryOwner = await request(app).post("/api/v1/auth/register").send({
      email: "primary-owner@example.com",
      password: "verysecurepassword",
    });
    const primaryOwnerCookie = primaryOwner.headers["set-cookie"]?.[0];

    const memberInvite = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", primaryOwnerCookie)
      .send({ email: "multi-account-member@example.com" });
    const primaryInvitationToken = memberInvite.body.acceptanceUrl.split("/").at(-1);

    const acceptedPrimary = await request(app)
      .post(`/api/v1/auth/invitations/${primaryInvitationToken}/accept`)
      .send({
        email: "multi-account-member@example.com",
        password: "verysecurepassword",
      });
    const memberCookie = acceptedPrimary.headers["set-cookie"]?.[0];

    const secondaryOwner = await request(app).post("/api/v1/auth/register").send({
      email: "secondary-owner@example.com",
      password: "verysecurepassword",
    });
    const secondaryOwnerCookie = secondaryOwner.headers["set-cookie"]?.[0];

    const secondaryInvite = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", secondaryOwnerCookie)
      .send({ email: "multi-account-member@example.com" });
    const secondaryInvitationToken = secondaryInvite.body.acceptanceUrl.split("/").at(-1);

    await request(app)
      .post(`/api/v1/auth/invitations/${secondaryInvitationToken}/accept`)
      .send({
        email: "multi-account-member@example.com",
        password: "verysecurepassword",
      })
      .expect(200);

    const beforeRemoval = await request(app)
      .get("/api/v1/account/users")
      .set("Cookie", primaryOwnerCookie);
    const memberEntry = beforeRemoval.body.users.find((user: { email: string }) => user.email === "multi-account-member@example.com");

    await request(app)
      .delete(`/api/v1/account/users/${memberEntry.membershipId}`)
      .set("Cookie", primaryOwnerCookie)
      .expect(204);

    const accounts = await request(app)
      .get("/api/v1/account/accounts")
      .set("Cookie", memberCookie);

    const switched = await request(app)
      .post("/api/v1/account/switch")
      .set("Cookie", memberCookie)
      .send({
        accountId: secondaryOwner.body.accountId,
        preferredWorkspaceId: secondaryOwner.body.workspaceId,
      });

    expect(accounts.status).toBe(200);
    expect(accounts.body.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: secondaryOwner.body.accountId,
        }),
      ]),
    );
    expect(switched.status).toBe(200);
    expect(switched.body.accountId).toBe(secondaryOwner.body.accountId);
  });

  it("logs a multi-account user into the invited account when no preferred account is provided", async () => {
    const { app } = createTestApp();

    const existingAccount = await request(app).post("/api/v1/auth/register").send({
      email: "multi-account@example.com",
      password: "verysecurepassword",
    });

    const invitingAccount = await request(app).post("/api/v1/auth/register").send({
      email: "owner-second-account@example.com",
      password: "verysecurepassword",
    });
    const invitingCookie = invitingAccount.headers["set-cookie"]?.[0];

    const invitation = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", invitingCookie)
      .send({ email: "multi-account@example.com" });
    const invitationToken = invitation.body.acceptanceUrl.split("/").at(-1);

    const accepted = await request(app)
      .post(`/api/v1/auth/invitations/${invitationToken}/accept`)
      .send({
        email: "multi-account@example.com",
        password: "verysecurepassword",
      });

    const login = await request(app).post("/api/v1/auth/login").send({
      email: "multi-account@example.com",
      password: "verysecurepassword",
    });

    expect(accepted.status).toBe(200);
    expect(login.status).toBe(200);
    expect(login.body.accountId).toBe(invitingAccount.body.accountId);
    expect(login.body.organizationName).toBe(invitingAccount.body.organizationName);
    expect(login.body.workspaceId).toBe(invitingAccount.body.workspaceId);
  });

  it("switches the active session to another accessible account", async () => {
    const { app } = createTestApp();

    const primary = await request(app).post("/api/v1/auth/register").send({
      email: "switcher@example.com",
      password: "verysecurepassword",
    });

    const secondary = await request(app).post("/api/v1/auth/register").send({
      email: "owner-switch-target@example.com",
      password: "verysecurepassword",
    });
    const secondaryCookie = secondary.headers["set-cookie"]?.[0];

    const invitation = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", secondaryCookie)
      .send({ email: "switcher@example.com" });
    const invitationToken = invitation.body.acceptanceUrl.split("/").at(-1);

    await request(app)
      .post(`/api/v1/auth/invitations/${invitationToken}/accept`)
      .send({
        email: "switcher@example.com",
        password: "verysecurepassword",
      })
      .expect(200);

    const switched = await request(app)
      .post("/api/v1/account/switch")
      .set("Cookie", primary.headers["set-cookie"]?.[0])
      .send({
        accountId: secondary.body.accountId,
        preferredWorkspaceId: secondary.body.workspaceId,
      });

    const switchedCookie = switched.headers["set-cookie"]?.[0];
    const workspaces = await request(app)
      .get("/api/v1/workspace")
      .set("Cookie", switchedCookie);

    expect(switched.status).toBe(200);
    expect(switched.body.accountId).toBe(secondary.body.accountId);
    expect(switched.body.organizationName).toBe(secondary.body.organizationName);
    expect(switched.body.workspaceId).toBe(secondary.body.workspaceId);
    expect(workspaces.status).toBe(200);
    expect(workspaces.body.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual(
      expect.arrayContaining([secondary.body.workspaceId]),
    );
  });

  it("renames the active organization", async () => {
    const { app } = createTestApp();

    const registration = await request(app).post("/api/v1/auth/register").send({
      email: "rename-org@example.com",
      password: "verysecurepassword",
      organizationName: "Original Org",
    });

    const rename = await request(app)
      .patch("/api/v1/account")
      .set("Cookie", registration.headers["set-cookie"]?.[0])
      .send({ organizationName: "Renamed Org" });

    const accounts = await request(app)
      .get("/api/v1/account/accounts")
      .set("Cookie", registration.headers["set-cookie"]?.[0]);

    expect(rename.status).toBe(200);
    expect(rename.body).toEqual({
      accountId: registration.body.accountId,
      organizationName: "Renamed Org",
    });
    expect(accounts.body.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: registration.body.accountId,
          organizationName: "Renamed Org",
        }),
      ]),
    );
  });

  it("audits invitation acceptance failures when an existing invited user enters the wrong password", async () => {
    const { app, dependencies } = createTestApp();

    const owner = await request(app).post("/api/v1/auth/register").send({
      email: "owner-audit@example.com",
      password: "verysecurepassword",
    });
    const ownerCookie = owner.headers["set-cookie"]?.[0];

    await request(app).post("/api/v1/auth/register").send({
      email: "existing-invitee@example.com",
      password: "correct-password",
    });

    const invitation = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", ownerCookie)
      .send({ email: "existing-invitee@example.com" });
    const invitationToken = invitation.body.acceptanceUrl.split("/").at(-1);

    const accepted = await request(app)
      .post(`/api/v1/auth/invitations/${invitationToken}/accept`)
      .send({
        email: "existing-invitee@example.com",
        password: "wrong-password",
      });

    expect(accepted.status).toBe(401);
    expect(dependencies.auditService.events).toContainEqual(
      expect.objectContaining({
        accountId: owner.body.accountId,
        eventType: "account.invitation.accept",
        eventStatus: "failure",
        metadata: expect.objectContaining({
          email: "existing-invitee@example.com",
          reason: "invalid_password",
        }),
      }),
    );
  });
});
