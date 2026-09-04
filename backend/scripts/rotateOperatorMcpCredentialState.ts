import { createHash } from "node:crypto";

import { OperatorMcpAuthorizationRepository } from "../src/db/repositories/operatorMcpAuthorizationRepository.js";
import { Database } from "../src/shared/infra/database.js";
import { loadEnvFileIfPresent } from "../src/runtime/loadEnv.js";

const requireValue = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const requireEpoch = (name: string): string => {
  const value = requireValue(name);
  if (!/^[1-9][0-9]*$/.test(value)) throw new Error(`${name} must be a canonical positive decimal integer`);
  return value;
};

const main = async (): Promise<void> => {
  loadEnvFileIfPresent();
  const currentEpoch = requireEpoch("OPERATOR_MCP_PREVIOUS_CREDENTIAL_EPOCH");
  const credentialEpoch = requireEpoch("OPERATOR_MCP_CREDENTIAL_EPOCH");
  if (BigInt(credentialEpoch) <= BigInt(currentEpoch)) {
    throw new Error("OPERATOR_MCP_CREDENTIAL_EPOCH must be greater than OPERATOR_MCP_PREVIOUS_CREDENTIAL_EPOCH");
  }

  const database = new Database(requireValue("DATABASE_URL"), {
    applicationName: "operator-mcp-credential-rotation",
    poolMax: 1,
  });
  try {
    const advanced = await new OperatorMcpAuthorizationRepository(database.kysely)
      .advanceDeploymentCredentialState({
        resource: requireValue("OPERATOR_MCP_RESOURCE_URL"),
        currentCredentialEpoch: currentEpoch,
        credentialEpoch,
        keyFingerprint: createHash("sha256").update(requireValue("OPERATOR_MCP_INTERNAL_SECRET")).digest("hex"),
        now: new Date(),
      });
    if (!advanced) throw new Error("credential state did not match the expected resource and previous epoch");
    process.stdout.write(`Operator MCP credential state advanced to epoch ${credentialEpoch}.\n`);
  } finally {
    await database.close();
  }
};

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Operator MCP credential rotation failed"}\n`);
  process.exitCode = 1;
});
