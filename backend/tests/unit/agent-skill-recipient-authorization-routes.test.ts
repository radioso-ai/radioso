import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";

import { createAgentSkillRoutes } from "../../src/app/http/routes/agentSkillRoutes.js";

type Dependencies = Parameters<typeof createAgentSkillRoutes>[0];

const skillId = "33333333-3333-4333-8333-333333333333";

const createApp = (role: "member" | "admin", skills: unknown[] = []) => {
  const create = vi.fn();
  const update = vi.fn();
  const remove = vi.fn().mockResolvedValue(undefined);
  const list = vi.fn().mockResolvedValue(skills);
  const dependencies = {
    env: { SESSION_COOKIE_NAME: "radioso_session" },
    authService: {
      authenticateApiToken: vi.fn().mockResolvedValue({
        accountId: "account-1",
        workspaceId: "workspace-1",
        principal: { type: "workspace_api_token", tokenId: "token-1", role, workspaceId: "workspace-1" },
      }),
      recordApiTokenUse: vi.fn(),
    },
    accountAccessService: { requirePermission: vi.fn().mockResolvedValue(role) },
    workspaceSessionService: {},
    logger: { info: vi.fn() },
    agentService: { get: vi.fn().mockResolvedValue({ id: "22222222-2222-4222-8222-222222222222" }) },
    agentSkillsService: { create, list, update, remove },
    skillCapabilityRegistry: { list: vi.fn().mockReturnValue([]) },
    operatorNoticeDestinations: { read: vi.fn() },
  } as unknown as Dependencies;
  const app = express();
  app.use(express.json());
  app.use("/api/v1/agents", createAgentSkillRoutes(dependencies));
  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    response.status((error as { statusCode?: number }).statusCode ?? 500).json({});
  });
  return { app, create, remove, update };
};

const input = {
  name: "notify_ops",
  capability: "notify",
  target: { kind: "notify_delivery", id: null },
  config: { delivery: { recipientEmails: ["ops@example.com"], webhook: null } },
  invocationMode: "routine_named",
  enabled: true,
};

describe("agent skill recipient authorization", () => {
  it("rejects a member changing notify recipients", async () => {
    const { app, create } = createApp("member");

    await request(app)
      .post("/api/v1/agents/22222222-2222-4222-8222-222222222222/skills")
      .set("Authorization", "Bearer token")
      .send(input)
      .expect(403);

    expect(create).not.toHaveBeenCalled();
  });

  it("allows an admin to change notify recipients", async () => {
    const { app, create } = createApp("admin");
    create.mockResolvedValue({ id: "33333333-3333-4333-8333-333333333333" });

    await request(app)
      .post("/api/v1/agents/22222222-2222-4222-8222-222222222222/skills")
      .set("Authorization", "Bearer token")
      .send(input)
      .expect(201);

    expect(create).toHaveBeenCalledOnce();
  });

  it("allows a member to create a notify skill with an explicitly empty recipient list", async () => {
    const { app, create } = createApp("member");
    create.mockResolvedValue({ id: skillId });

    await request(app)
      .post("/api/v1/agents/22222222-2222-4222-8222-222222222222/skills")
      .set("Authorization", "Bearer token")
      .send({
        ...input,
        config: { delivery: { recipientEmails: [], webhook: null } },
      })
      .expect(201);

    expect(create).toHaveBeenCalledOnce();
  });

  it("rejects a member deleting a notify skill that has recipients", async () => {
    const { app, remove } = createApp("member", [{
      id: skillId,
      capability: "notify",
      config: { delivery: { recipientEmails: ["ops@example.com"], webhook: null } },
    }]);

    await request(app)
      .delete(`/api/v1/agents/22222222-2222-4222-8222-222222222222/skills/${skillId}`)
      .set("Authorization", "Bearer token")
      .expect(403);

    expect(remove).not.toHaveBeenCalled();
  });

  it("allows a member to delete a notify skill without recipients", async () => {
    const { app, remove } = createApp("member", [{
      id: skillId,
      capability: "notify",
      config: { delivery: { webhook: { url: "https://hooks.example.com/notify" } } },
    }]);

    await request(app)
      .delete(`/api/v1/agents/22222222-2222-4222-8222-222222222222/skills/${skillId}`)
      .set("Authorization", "Bearer token")
      .expect(204);

    expect(remove).toHaveBeenCalledOnce();
  });

  it("rejects a member replacing a notify config when that removes recipients", async () => {
    const { app, update } = createApp("member", [{
      id: skillId,
      capability: "notify",
      config: { delivery: { recipientEmails: ["ops@example.com"], webhook: null } },
    }]);

    await request(app)
      .patch(`/api/v1/agents/22222222-2222-4222-8222-222222222222/skills/${skillId}`)
      .set("Authorization", "Bearer token")
      .send({ replaceConfig: { delivery: { webhook: { url: "https://hooks.example.com/notify" } } } })
      .expect(403);

    expect(update).not.toHaveBeenCalled();
  });
});
