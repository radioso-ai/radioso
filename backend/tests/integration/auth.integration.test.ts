import request from "supertest";
import { describe, expect, it } from "vitest";

import { createTestApp, issueTestSession } from "../support/testApp.js";
import type { InMemoryAuditService } from "../support/fakes.js";
import { WorkspaceService } from "../../src/modules/workspace/services/workspaceService.js";
import {
  createAuditService,
  InMemoryAccountRepository,
  InMemoryWorkspaceRepository,
} from "../support/fakes.js";
import type {
  OrganizationCreationGuard,
  OrganizationCreationRequest,
  OrganizationCreationReservation,
} from "../../src/shared/domain/organizationCreationGuard.js";

class RecordingOrganizationCreationGuard implements OrganizationCreationGuard {
  readonly requests: OrganizationCreationRequest[] = [];

  async reserve(input: OrganizationCreationRequest): Promise<OrganizationCreationReservation> {
    this.requests.push(input);
    return { async commit() {}, async release() {} };
  }

  async isSignupAvailable(): Promise<boolean> {
    return true;
  }
}

class OssAdditionalOrganizationGuard implements OrganizationCreationGuard {
  async reserve(input: OrganizationCreationRequest): Promise<OrganizationCreationReservation> {
    if (input.intent === "additional") {
      throw {
        statusCode: 403,
        code: "forbidden",
        message: "Additional organizations require Enterprise Edition.",
      };
    }
    return { async commit() {}, async release() {} };
  }

  async isSignupAvailable(): Promise<boolean> {
    return true;
  }
}

describe("auth integration", () => {
  it("rejects direct OSS additional-organization requests without mutation", async () => {
    const { app } = createTestApp({ organizationCreationGuard: new OssAdditionalOrganizationGuard() });
    const session = await issueTestSession(app, "oss-direct-additional@example.com");
    const before = await request(app).get("/api/v1/account/accounts").set("Cookie", session.cookie);

    const response = await request(app)
      .post("/api/v1/account/accounts")
      .set("Cookie", session.cookie)
      .send({ organizationName: "Forbidden second organization" });
    const after = await request(app).get("/api/v1/account/accounts").set("Cookie", session.cookie);

    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({
      code: "forbidden",
      message: "Additional organizations require Enterprise Edition.",
    });
    expect(after.body).toEqual(before.body);
  });

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
    expect(response.body.workspacePublicRouteKey).toMatch(/^\d{10}$/);
    expect(response.body.workspaceId).toBeDefined();
    expect(response.body.token).toBeUndefined();
    expect(response.body.requiresEmailVerification).toBe(true);
    expect(response.headers["set-cookie"]).toBeUndefined();
  });

  it("supports multi-workspace session flows without exposing a shared workspace token", async () => {
    const { app } = createTestApp();
    const register = await issueTestSession(app, "repeat@example.com");
    const cookie = register.cookie;
    const defaultWorkspaceId = register.workspaceId;

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
    expect(tokenRoute.status).toBe(404);
  });

  it("creates additional workspaces without consulting organization creation policy", async () => {
    const organizationCreationGuard = new RecordingOrganizationCreationGuard();
    const { app } = createTestApp({ organizationCreationGuard });
    const registration = await issueTestSession(app, "workspace-policy-isolation@example.com");
    organizationCreationGuard.requests.length = 0;

    const created = await request(app)
      .post("/api/v1/workspace")
      .set("Cookie", registration.cookie)
      .send({ name: "Second workspace" });

    expect(created.status).toBe(201);
    expect(organizationCreationGuard.requests).toEqual([]);
  });

  it("does not expose removed shared workspace-token routes", async () => {
    const { app } = createTestApp();
    const registration = await issueTestSession(app, "rotate-token@example.com");
    const cookie = registration.cookie;
    const tokenRoute = `/api/v1/account/workspaces/${registration.workspaceId}/token`;
    const rotateRoute = `/api/v1/account/workspaces/${registration.workspaceId}/token/rotate`;

    const revealed = await request(app)
      .get(tokenRoute)
      .set("Cookie", cookie);

    const rotated = await request(app)
      .post(rotateRoute)
      .set("Cookie", cookie);

    expect(revealed.status).toBe(404);
    expect(rotated.status).toBe(404);
  });

  it("does not retain validation behavior for removed workspace-token routes", async () => {
    const { app } = createTestApp();
    const registration = await issueTestSession(app, "malformed-workspace-token-id@example.com");

    const reveal = await request(app)
      .get("/api/v1/account/workspaces/not-a-uuid/token")
      .set("Cookie", registration.cookie);
    const rotate = await request(app)
      .post("/api/v1/account/workspaces/not-a-uuid/token/rotate")
      .set("Cookie", registration.cookie);

    expect(reveal.status).toBe(404);
    expect(rotate.status).toBe(404);
  });

  it("keeps removed workspace-token routes absent regardless of legacy secret configuration", async () => {
    const { app } = createTestApp({
      envOverrides: {
        WORKSPACE_TOKEN_SECRET: undefined,
      },
    });

    const register = await issueTestSession(app, "missing-workspace-token-secret@example.com");

    const response = await request(app)
      .get(`/api/v1/account/workspaces/${register.workspaceId}/token`)
      .set("Cookie", register.cookie);

    expect(response.status).toBe(404);
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

    const registration = await issueTestSession(app, "multi-workspace@example.com");
    const cookie = registration.cookie;
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
    expect(response.body.accountId).toBe(registration.accountId);
    expect(response.body.organizationName).toBe("Multi Workspace Organization");
    expect(response.body.workspaceId).toBe(created.body.id);
    expect(response.body.workspaceName).toBe("Research");
    expect(response.body.workspacePublicRouteKey).toMatch(/^\d{10}$/);
    expect(response.body.token).toBeUndefined();
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
  });

  it("lets an invited user access the shared account workspaces", async () => {
    const organizationCreationGuard = new RecordingOrganizationCreationGuard();
    const { app } = createTestApp({ organizationCreationGuard });

    const owner = await issueTestSession(app, "owner-shared@example.com");
    organizationCreationGuard.requests.length = 0;
    const ownerCookie = owner.cookie;

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
      expect.arrayContaining([owner.workspaceId, createdWorkspace.body.id]),
    );
    expect(organizationCreationGuard.requests).toEqual([]);
  });

  it("creates a new organization for the signed-in user and switches the session to it", async () => {
    const { app } = createTestApp();

    const registration = await issueTestSession(app, "multi-org@example.com");

    const response = await request(app)
      .post("/api/v1/account/accounts")
      .set("Cookie", registration.cookie)
      .send({ organizationName: "Second Organization" });

    expect(response.status).toBe(201);
    expect(response.body.userId).toBe(registration.userId);
    expect(response.body.accountId).not.toBe(registration.accountId);
    expect(response.body.organizationName).toBe("Second Organization");
    expect(response.body.workspaceName).toBe("Default");
    expect(response.body.workspacePublicRouteKey).toMatch(/^\d{10}$/);
    expect(response.headers["set-cookie"]?.[0]).toContain("radioso_session=");
  });

  it("does not leave behind a user when invitation acceptance fails for a new email", async () => {
    const { app, dependencies } = createTestApp();

    const owner = await issueTestSession(app, "owner-expired@example.com");
    const ownerCookie = owner.cookie;

    const invitation = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", ownerCookie)
      .send({ email: "new-user-expired@example.com" });
    const invitationToken = invitation.body.acceptanceUrl.split("/").at(-1);

    const invitationRecord = await dependencies.accountInvitationService["invitationRepository"].findPendingByAccountAndEmail(
      owner.accountId,
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

  it("rate limits invitation password attempts for existing users", async () => {
    const { app } = createTestApp({
      envOverrides: {
        AUTH_RATE_LIMIT_MAX_ATTEMPTS: 1,
      },
    });

    await issueTestSession(app, "existing-invitee@example.com");
    const owner = await issueTestSession(app, "owner-invite-rate-limit@example.com");
    const invitation = await request(app)
      .post("/api/v1/account/invitations")
      .set("Cookie", owner.cookie)
      .send({ email: "existing-invitee@example.com" });
    const invitationToken = invitation.body.acceptanceUrl.split("/").at(-1);

    await request(app)
      .post(`/api/v1/auth/invitations/${invitationToken}/accept`)
      .send({
        email: "existing-invitee@example.com",
        password: "wrong-password-a",
      })
      .expect(401);

    const response = await request(app)
      .post(`/api/v1/auth/invitations/${invitationToken}/accept`)
      .send({
        email: "rotated-invitee@example.com",
        password: "wrong-password-b",
      });

    expect(response.status).toBe(429);
    expect(response.body.error.code).toBe("rate_limit_exceeded");
  });

  it("lets an account owner remove a member and immediately revoke that account access", async () => {
    const { app } = createTestApp();

    const owner = await issueTestSession(app, "owner-remove@example.com");
    const ownerCookie = owner.cookie;

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

    const primaryOwner = await issueTestSession(app, "primary-owner@example.com");
    const primaryOwnerCookie = primaryOwner.cookie;

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

    const secondaryOwner = await issueTestSession(app, "secondary-owner@example.com");
    const secondaryOwnerCookie = secondaryOwner.cookie;

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
        accountId: secondaryOwner.accountId,
        preferredWorkspaceId: secondaryOwner.workspaceId,
      });

    expect(accounts.status).toBe(200);
    expect(accounts.body.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: secondaryOwner.accountId,
        }),
      ]),
    );
    expect(switched.status).toBe(200);
    expect(switched.body.accountId).toBe(secondaryOwner.accountId);
  }, 20_000);

  it("logs a multi-account user into the invited account when no preferred account is provided", async () => {
    const { app } = createTestApp();

    await issueTestSession(app, "multi-account@example.com");

    const invitingAccount = await issueTestSession(app, "owner-second-account@example.com");
    const invitingCookie = invitingAccount.cookie;

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
    expect(login.body.accountId).toBe(invitingAccount.accountId);
    expect(login.body.organizationName).toBe("Owner Second Account Organization");
    expect(login.body.workspaceId).toBe(invitingAccount.workspaceId);
  });

  it("switches the active session to another accessible account", async () => {
    const { app } = createTestApp();

    const primary = await issueTestSession(app, "switcher@example.com");

    const secondary = await issueTestSession(app, "owner-switch-target@example.com");
    const secondaryCookie = secondary.cookie;

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
      .set("Cookie", primary.cookie)
      .send({
        accountId: secondary.accountId,
        preferredWorkspaceId: secondary.workspaceId,
      });

    const switchedCookie = switched.headers["set-cookie"]?.[0];
    const workspaces = await request(app)
      .get("/api/v1/workspace")
      .set("Cookie", switchedCookie);

    expect(switched.status).toBe(200);
    expect(switched.body.accountId).toBe(secondary.accountId);
    expect(switched.body.organizationName).toBe("Owner Switch Target Organization");
    expect(switched.body.workspaceId).toBe(secondary.workspaceId);
    expect(workspaces.status).toBe(200);
    expect(workspaces.body.workspaces.map((workspace: { id: string }) => workspace.id)).toEqual(
      expect.arrayContaining([secondary.workspaceId]),
    );
  });

  it("renames the active organization", async () => {
    const { app } = createTestApp();

    const registration = await issueTestSession(app, "rename-org@example.com");

    const rename = await request(app)
      .patch("/api/v1/account")
      .set("Cookie", registration.cookie)
      .send({ organizationName: "Renamed Org" });

    const accounts = await request(app)
      .get("/api/v1/account/accounts")
      .set("Cookie", registration.cookie);

    expect(rename.status).toBe(200);
    expect(rename.body).toEqual({
      accountId: registration.accountId,
      organizationName: "Renamed Org",
    });
    expect(accounts.body.accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          accountId: registration.accountId,
          organizationName: "Renamed Org",
        }),
      ]),
    );
  });

  it("audits invitation acceptance failures when an existing invited user enters the wrong password", async () => {
    const { app, dependencies } = createTestApp();

    const owner = await issueTestSession(app, "owner-audit@example.com");
    const ownerCookie = owner.cookie;

    await issueTestSession(app, "existing-invitee@example.com");

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
    expect((dependencies.auditService as InMemoryAuditService).events).toContainEqual(
      expect.objectContaining({
        accountId: owner.accountId,
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
