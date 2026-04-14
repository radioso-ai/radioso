#!/usr/bin/env node

import { resolveProfileExecution, listProfiles } from "./lib/profiles.mjs";
import { parseCliArgs, resolveArtifactPath, writeArtifact, formatRunSummary } from "./lib/reporting.mjs";
import { runBenchmarkProfile } from "./lib/runner.mjs";

const printHelp = () => {
  console.log(`Usage: node scripts/performance/runProfile.mjs --profile <id> [options]

Options:
  --list                     List available benchmark profiles
  --profile <id>             Profile id to execute
  --environment <class>      Environment class (default: local)
  --backend-url <url>        Backend base URL (default: http://127.0.0.1:8080)
  --database-url <url>       Database URL for queue metrics
  --email <email>            Benchmark account email for authenticated profiles
  --password <password>      Benchmark account password for authenticated profiles
  --workspace-id <uuid>      Preferred workspace id for authenticated profiles
  --provision-account        Register the account if login fails
  --allow-restricted         Allow restricted stress or soak profiles
  --output <path>            Write the result artifact to this path
  --json                     Print the full artifact JSON after execution
  --help                     Show this help message
`);
};

const args = parseCliArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

if (args.list) {
  for (const profile of listProfiles()) {
    console.log(`${profile.id}\t${profile.family}\t${profile.safetyTier}\t${profile.allowedEnvironmentClasses.join(",")}`);
  }
  process.exit(0);
}

if (!args.profile) {
  printHelp();
  process.exit(1);
}

const profile = resolveProfileExecution({
  profileId: args.profile,
  environmentClass: args.environment ?? "local",
  allowRestricted: Boolean(args["allow-restricted"]),
});

const artifact = await runBenchmarkProfile({
  profile,
  environmentClass: args.environment ?? "local",
  backendBaseUrl: args["backend-url"] ?? "http://127.0.0.1:8080",
  databaseUrl: args["database-url"] ?? null,
  email: args.email ?? null,
  password: args.password ?? null,
  workspaceId: args["workspace-id"] ?? null,
  provisionAccount: Boolean(args["provision-account"]),
});

const outputPath = await resolveArtifactPath({
  profileId: profile.id,
  outputPath: args.output,
});

await writeArtifact({ artifact, outputPath });

console.log(formatRunSummary(artifact));
console.log(`Artifact: ${outputPath}`);

if (args.json) {
  console.log(JSON.stringify(artifact, null, 2));
}
