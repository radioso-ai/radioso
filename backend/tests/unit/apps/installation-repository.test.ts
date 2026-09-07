import { describe, expect, it } from "vitest";

import { AppInstallationRepository, AppsError } from "../../../src/modules/apps/public.js";
import type { Db } from "../../../src/shared/infra/kysely/types.js";

/**
 * Two different plans for the same App can both pass the service's `findLiveByAppId`
 * pre-check before either writes, because that read and this insert are not atomic. The
 * partial unique index on (workspace_id, app_id) WHERE state <> 'removed' (migration 167)
 * is what actually decides the race; the loser must see a domain `installation_conflict`,
 * not a raw Postgres error.
 */
const uniqueViolation = (): Error & { code: string; constraint: string } =>
  Object.assign(new Error("duplicate key value violates unique constraint \"idx_app_installations_workspace_app_live\""), {
    code: "23505",
    constraint: "idx_app_installations_workspace_app_live",
  });

const fakeDbThatThrowsOnInsert = (error: unknown): Db => ({
  insertInto: () => ({
    values: () => ({
      returning: () => ({
        executeTakeFirstOrThrow: () => { throw error; },
      }),
    }),
  }),
} as unknown as Db);

describe("AppInstallationRepository.create", () => {
  it("translates a live-installation unique violation into installation_conflict", async () => {
    const repository = new AppInstallationRepository(fakeDbThatThrowsOnInsert(uniqueViolation()));

    await expect(repository.create({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      appId: "ai.radioso.wordpress",
      candidateReleaseId: "33333333-3333-4333-8333-333333333333",
      configuration: {},
    })).rejects.toMatchObject({ reason: "installation_conflict" });
  });

  it("lets an unrelated database error pass through unchanged", async () => {
    const repository = new AppInstallationRepository(fakeDbThatThrowsOnInsert(new Error("connection reset")));

    await expect(repository.create({
      workspaceId: "22222222-2222-4222-8222-222222222222",
      appId: "ai.radioso.wordpress",
      candidateReleaseId: "33333333-3333-4333-8333-333333333333",
      configuration: {},
    })).rejects.not.toBeInstanceOf(AppsError);
  });
});
