#!/usr/bin/env node

import { getProfileById } from "./lib/profiles.mjs";
import { buildBaselineComparisonReport, loadResultArtifact } from "./lib/budgets.mjs";
import { formatComparisonSummary, parseCliArgs } from "./lib/reporting.mjs";

const printHelp = () => {
  console.log(`Usage: node scripts/performance/compareBaseline.mjs --baseline <path> --candidate <path> [--json]
`);
};

const args = parseCliArgs(process.argv.slice(2));

if (args.help || !args.baseline || !args.candidate) {
  printHelp();
  process.exit(args.help ? 0 : 1);
}

const baselineArtifact = await loadResultArtifact(args.baseline);
const candidateArtifact = await loadResultArtifact(args.candidate);
const profile = getProfileById(candidateArtifact.profileId);

const comparison = buildBaselineComparisonReport({
  baselineArtifact,
  candidateArtifact,
  budgets: profile.budgets ?? [],
});

console.log(formatComparisonSummary(comparison));

if (args.json) {
  console.log(JSON.stringify(comparison, null, 2));
}
