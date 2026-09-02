import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { expect, it } from "vitest";

const isolatedIntegrationSuites = new Set([
  "action-request-repository.integration.test.ts",
  "agent-skill-target-cascade.integration.test.ts",
  "approvals/decision-resume.test.ts",
  "approvals/pending-decision-repository.test.ts",
  "approvals/pending-decision-transaction.test.ts",
  "approvals/routine-state-suspend.test.ts",
  "context-variable-enablement-references-migration.integration.test.ts",
  "customerEmail/customer-email-connection-repository.test.ts",
  "customerEmail/email-skill-activity-repository.test.ts",
  "customerEmail/email-skill-definition-repository.test.ts",
  "externalSkills/repositories.test.ts",
  "externalSkills/services.test.ts",
  "handoff/conversation-ownership-repository.test.ts",
  "integrationConnections/integration-connection-repository.test.ts",
  "integrationOauth/oauth-connection-repository.test.ts",
  "machine-access-migration.integration.test.ts",
  "message-grounding-diagnostics-migration.integration.test.ts",
  "message-total-latency-migration.integration.test.ts",
  "migration-compatibility.integration.test.ts",
  "notify-webhook-skill-migration.integration.test.ts",
  "oss-organization-creation-guard.integration.test.ts",
  "quality-eval-learning-loop-migration.integration.test.ts",
  "routine-definition-repository-postgres.integration.test.ts",
  "routine-lineage-lifecycle-migration.integration.test.ts",
  "routine-slot-correction.integration.test.ts",
  "slack/slack-dm-journey.integration.test.ts",
  "slack/slack-installation-repository.integration.test.ts",
  "slack/slack-skill-migration.integration.test.ts",
  "slackSkills/slack-skill-definition-repository.integration.test.ts",
]);

const collectTestFiles = async (directory: string): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry) => {
    const entryPath = path.join(directory, entry.name);
    return entry.isDirectory() ? collectTestFiles(entryPath) : [entryPath];
  }));
  return files.flat().filter((file) => file.endsWith(".test.ts"));
};

const rawSqlLiterals = (source: string): string[] => [
  ...source.matchAll(/`([^`]*)`|"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'/gs),
].map((match) => match[1] ?? match[2] ?? match[3] ?? "");

const unscopedRawSql = (source: string): string[] => rawSqlLiterals(source).flatMap((sql) => {
  const violations: string[] = [];
  if (/\bTRUNCATE\s+(?:TABLE\s+)?(?:ONLY\s+)?["\w]/i.test(sql)) {
    violations.push("TRUNCATE");
  }

  for (const statement of sql.matchAll(/\bDELETE\s+FROM\s+(?:ONLY\s+)?["\w.]+([\s\S]*?)(?:;|$)/gi)) {
    if (!/\bWHERE\b/i.test(statement[1])) {
      violations.push("DELETE FROM without WHERE");
    }
  }
  return violations;
});

const hasUnscopedKyselyDelete = (source: string): boolean =>
  /\.deleteFrom\(\s*["'][^"']+["']\s*\)(?:(?!\.where\s*\()[\s\S]){0,500}?\.execute(?:TakeFirst(?:OrThrow)?|TakeFirst)?\s*\(/.test(source);

it("recognizes multiline raw SQL and directly executed Kysely deletes without a scope", () => {
  expect(unscopedRawSql("await db.query(`DELETE FROM accounts\n`);")).toEqual(["DELETE FROM without WHERE"]);
  expect(unscopedRawSql("await db.execute(`TRUNCATE\n accounts CASCADE`);")).toEqual(["TRUNCATE"]);
  expect(hasUnscopedKyselyDelete('await db.deleteFrom("accounts").execute();')).toBe(true);
  expect(hasUnscopedKyselyDelete('await db.deleteFrom("accounts").where("id", "=", id).execute();')).toBe(false);
});

it("allows unscoped cleanup only in an explicit generated schema or database isolation boundary", async () => {
  const integrationRoot = path.resolve("tests/integration");
  const files = await collectTestFiles(integrationRoot);
  const allowlistProblems: string[] = [];
  const offenders: string[] = [];

  for (const file of files) {
    const source = await readFile(file, "utf8");
    const relativePath = path.relative(integrationRoot, file);
    const isIsolated = isolatedIntegrationSuites.has(relativePath);
    const destructiveOperations = [
      ...unscopedRawSql(source),
      ...(hasUnscopedKyselyDelete(source) ? ["Kysely deleteFrom without where"] : []),
    ];

    if (isIsolated && !(/\bCREATE\s+(?:SCHEMA|DATABASE)\b/i.test(source) && /\bDROP\s+(?:SCHEMA|DATABASE)\b/i.test(source))) {
      allowlistProblems.push(relativePath);
    }
    if (!isIsolated && destructiveOperations.length > 0) {
      offenders.push(`${relativePath}: ${destructiveOperations.join(", ")}`);
    }
  }

  expect(allowlistProblems, "Each isolation allowlist entry must create and drop its generated boundary").toEqual([]);
  expect(
    offenders,
    "Shared-public integration suites must scope raw SQL and Kysely deletes to test-owned fixtures",
  ).toEqual([]);
});
