import { randomUUID } from "node:crypto";

import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import type { VoiceRecordingLeftAtVendor, VoiceRecordingsLeftAtVendorReader } from "../../src/modules/voiceChannel/public.js";
import { createTestApp, issueTestSession, issueTestToken } from "../support/testApp.js";

const failedAt = new Date("2026-10-25T09:30:00.000Z");

/**
 * `GET /api/v1/account/voice-recordings/left-at-vendor`: an organization's owners and admins read
 * the call recordings its deletions left at the voice vendor, and nobody reads another
 * organization's. The reader stands in for the backlog, which the integration test covers.
 */
describe("the organization's recordings left at the vendor", () => {
  const appWithLeftovers = () => {
    const leftovers = new Map<string, VoiceRecordingLeftAtVendor[]>();
    // Pages its organization's list by position; the cursor is opaque to the route either way.
    const reader = {
      listForAccount: vi.fn<VoiceRecordingsLeftAtVendorReader["listForAccount"]>(async ({ accountId, limit, cursor }) => {
        const all = leftovers.get(accountId) ?? [];
        const start = cursor ? Number(cursor.replace("after-", "")) : 0;
        const page = all.slice(start, start + limit);
        const end = start + page.length;
        return { total: all.length, recordings: page, nextCursor: end < all.length ? `after-${end}` : null };
      }),
    };
    return { ...createTestApp({ voiceRecordingsLeftAtVendor: reader }), reader, leftovers };
  };

  const inviteMember = async (app: ReturnType<typeof createTestApp>["app"], ownerCookie: string) => {
    const email = `member-${randomUUID()}@example.com`;
    const invitation = await request(app).post("/api/v1/account/invitations").set("Cookie", ownerCookie).send({ email });
    expect(invitation.status).toBe(201);
    const token = String(invitation.body.acceptanceUrl).split("/").at(-1);
    const accepted = await request(app).post(`/api/v1/auth/invitations/${token}/accept`).send({ email, password: "verysecurepassword" });
    expect(accepted.status).toBe(200);
    const cookie = accepted.headers["set-cookie"]?.[0];
    if (!cookie) throw new Error("Expected invitation acceptance to create a session");
    return cookie;
  };

  it("lists the caller's organization's recordings, newest first, with the vendor's id and why each was left", async () => {
    const { app, reader, leftovers } = appWithLeftovers();
    const owner = await issueTestSession(app, `owner-${randomUUID()}@example.com`);
    const conversationId = randomUUID();
    const recording = (index: number): VoiceRecordingLeftAtVendor => ({
      vendor: "elevenlabs",
      vendorRegion: "eu",
      vendorConversationId: `conv_${index}`,
      conversationId: index === 0 ? conversationId : null,
      workspaceId: owner.workspaceId,
      reason: "vendor_rejected",
      failedAt,
    });
    leftovers.set(owner.accountId, [0, 1, 2].map(recording));

    const response = await request(app).get("/api/v1/account/voice-recordings/left-at-vendor?limit=1").set("Cookie", owner.cookie);

    expect(response.status).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body).toEqual({
      total: 3,
      recordings: [{
        vendor: "elevenlabs",
        vendorRegion: "eu",
        vendorConversationId: "conv_0",
        conversationId,
        workspaceId: owner.workspaceId,
        reason: "vendor_rejected",
        failedAt: failedAt.toISOString(),
      }],
      nextCursor: "after-1",
    });
    expect(reader.listForAccount).toHaveBeenCalledWith({ accountId: owner.accountId, limit: 1 });

    await request(app).get("/api/v1/account/voice-recordings/left-at-vendor").set("Cookie", owner.cookie).expect(200);
    expect(reader.listForAccount).toHaveBeenLastCalledWith({ accountId: owner.accountId, limit: 100 });
    await request(app).get("/api/v1/account/voice-recordings/left-at-vendor?limit=0").set("Cookie", owner.cookie).expect(400);
    await request(app).get("/api/v1/account/voice-recordings/left-at-vendor?limit=501").set("Cookie", owner.cookie).expect(400);
  });

  it("pages past one response with the cursor it returns: no recording twice, none skipped", async () => {
    const { app, reader, leftovers } = appWithLeftovers();
    const owner = await issueTestSession(app, `owner-${randomUUID()}@example.com`);
    leftovers.set(owner.accountId, [0, 1, 2, 3, 4].map((index) => ({
      vendor: "elevenlabs",
      vendorRegion: "us",
      vendorConversationId: `conv_${index}`,
      conversationId: null,
      workspaceId: owner.workspaceId,
      reason: "credential_missing",
      failedAt,
    })));

    const first = await request(app).get("/api/v1/account/voice-recordings/left-at-vendor?limit=3").set("Cookie", owner.cookie).expect(200);
    const second = await request(app)
      .get(`/api/v1/account/voice-recordings/left-at-vendor?limit=3&cursor=${encodeURIComponent(first.body.nextCursor as string)}`)
      .set("Cookie", owner.cookie)
      .expect(200);

    const ids = (body: { recordings: Array<{ vendorConversationId: string }> }) => body.recordings.map((entry) => entry.vendorConversationId);
    expect(ids(first.body)).toEqual(["conv_0", "conv_1", "conv_2"]);
    expect(ids(second.body)).toEqual(["conv_3", "conv_4"]);
    expect(second.body.nextCursor).toBeNull();
    expect(reader.listForAccount).toHaveBeenLastCalledWith({ accountId: owner.accountId, limit: 3, cursor: first.body.nextCursor });
  });

  it("reads only the caller's own organization", async () => {
    const { app, leftovers } = appWithLeftovers();
    const owner = await issueTestSession(app, `owner-${randomUUID()}@example.com`);
    const stranger = await issueTestSession(app, `stranger-${randomUUID()}@example.com`);
    leftovers.set(owner.accountId, []);

    const response = await request(app).get("/api/v1/account/voice-recordings/left-at-vendor").set("Cookie", stranger.cookie);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ total: 0, recordings: [], nextCursor: null });
  });

  it("refuses a member, a machine credential, and a caller with no session", async () => {
    const { app, reader } = appWithLeftovers();
    const owner = await issueTestToken(app, `owner-${randomUUID()}@example.com`);
    const memberCookie = await inviteMember(app, owner.cookie);

    await request(app).get("/api/v1/account/voice-recordings/left-at-vendor").set("Cookie", memberCookie).expect(403);
    const machine = await request(app).get("/api/v1/account/voice-recordings/left-at-vendor").set("Authorization", `Bearer ${owner.token}`);
    expect([401, 403]).toContain(machine.status);
    await request(app).get("/api/v1/account/voice-recordings/left-at-vendor").expect(401);
    expect(reader.listForAccount).not.toHaveBeenCalled();
  });
});
