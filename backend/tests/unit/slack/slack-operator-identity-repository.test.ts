import { describe, expect, it, vi } from "vitest";

import { SlackOperatorIdentityRepository } from "../../../src/modules/slack/persistence/slackOperatorIdentityRepository.js";

const row = {
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  installation_id: "33333333-3333-4333-8333-333333333333",
  slack_user_id: "U123",
  account_id: "44444444-4444-4444-8444-444444444444",
  slack_display_name: "Dana",
  created_at: new Date("2026-06-23T12:00:00.000Z"),
  updated_at: new Date("2026-06-23T12:00:00.000Z"),
};

describe("SlackOperatorIdentityRepository", () => {
  it("finds an identity by installation and Slack user", async () => {
    const queryOptional = vi.fn(async (_text: string, _params?: unknown[]) => row);
    const repository = new SlackOperatorIdentityRepository({
      queryOptional,
      query: vi.fn(),
      queryOne: vi.fn(),
      execute: vi.fn(),
    } as never);

    await expect(repository.findByInstallationAndSlackUser({
      installationId: row.installation_id,
      slackUserId: row.slack_user_id,
    })).resolves.toMatchObject({
      id: row.id,
      workspaceId: row.workspace_id,
      installationId: row.installation_id,
      slackUserId: row.slack_user_id,
      accountId: row.account_id,
      slackDisplayName: "Dana",
    });
    expect(queryOptional.mock.calls[0]![0]).toContain("WHERE installation_id = $1 AND slack_user_id = $2");
    expect(queryOptional.mock.calls[0]![1]).toEqual([row.installation_id, row.slack_user_id]);
  });

  it("upserts by installation and Slack user while refreshing display name", async () => {
    const queryOne = vi.fn(async (_text: string, _params?: unknown[]) => ({ ...row, slack_display_name: "Dana S." }));
    const repository = new SlackOperatorIdentityRepository({
      queryOptional: vi.fn(),
      query: vi.fn(),
      queryOne,
      execute: vi.fn(),
    } as never);

    const saved = await repository.upsert({
      workspaceId: row.workspace_id,
      installationId: row.installation_id,
      slackUserId: row.slack_user_id,
      accountId: row.account_id,
      slackDisplayName: "Dana S.",
    });

    expect(saved.slackDisplayName).toBe("Dana S.");
    expect(queryOne.mock.calls[0]![0]).toContain("ON CONFLICT (installation_id, slack_user_id)");
    expect(queryOne.mock.calls[0]![0]).toContain("updated_at = NOW()");
    expect(queryOne.mock.calls[0]![1]).toEqual([
      expect.any(String),
      row.workspace_id,
      row.installation_id,
      row.slack_user_id,
      row.account_id,
      "Dana S.",
    ]);
  });
});
