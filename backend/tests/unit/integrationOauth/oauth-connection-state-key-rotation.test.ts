import { describe, expect, it } from "vitest";

import {
  OauthConnectionService,
  StaticOauthProviderRegistry,
} from "../../../src/modules/integrationOauth/services/oauthConnectionService.js";
import type { FieldEncryptionKeyRing } from "../../../src/shared/infra/crypto/fieldEncryption.js";
import { InMemoryOauthConnectionRepository } from "../../support/inMemoryOauthConnections.js";

const OLD_KEY = Buffer.alloc(32, 0x0a).toString("base64");
const NEW_KEY = Buffer.alloc(32, 0x0b).toString("base64");
const WORKSPACE_ID = "workspace-1";

const provider = {
  id: "example",
  authorizationEndpoint: "https://auth.example.com/authorize",
  tokenEndpoint: "https://auth.example.com/token",
  clientId: "client-1",
  defaultScopes: ["read"],
};

const tokenEndpoint = async () => ({
  ok: true,
  status: 200,
  json: async () => ({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600 }),
});

const serviceWith = (repository: InMemoryOauthConnectionRepository, encryptionKey: FieldEncryptionKeyRing) =>
  new OauthConnectionService({
    repository,
    providers: new StaticOauthProviderRegistry([provider]),
    encryptionKey,
    appBaseUrl: "https://app.example.com",
    fetchImpl: tokenEndpoint,
  });

/** Starts a consent flow before a key rotation deploy and returns the state the provider echoes back. */
const startBeforeRotation = async (repository: InMemoryOauthConnectionRepository): Promise<string> => {
  const started = await serviceWith(repository, { current: OLD_KEY, previous: [] })
    .create(WORKSPACE_ID, { provider: provider.id, displayName: "Example" });
  const state = new URL(started.authorizationUrl).searchParams.get("state");
  if (!state) throw new Error("the authorization URL carries no state");
  return state;
};

describe("OAuth consent flows across a credential key rotation", () => {
  it("completes a flow started under the key that the rotation moved to the previous keys", async () => {
    const repository = new InMemoryOauthConnectionRepository();
    const state = await startBeforeRotation(repository);

    const completed = await serviceWith(repository, { current: NEW_KEY, previous: [OLD_KEY] })
      .completeCallback(provider.id, { code: "code-1", state });

    expect(completed.connection.status).toBe("authorized");
  });

  it("rejects a state signed under a key the ring no longer holds", async () => {
    const repository = new InMemoryOauthConnectionRepository();
    const state = await startBeforeRotation(repository);

    await expect(
      serviceWith(repository, { current: NEW_KEY, previous: [] }).completeCallback(provider.id, { code: "code-1", state }),
    ).rejects.toThrow(/Invalid OAuth state/);
  });
});
