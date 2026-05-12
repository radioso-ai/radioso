import {
  isRetrievalAnswerGeneratedContractCurrent,
  retrievalAnswerGeneratedContractPath,
  writeRetrievalAnswerGeneratedContract,
} from "./skillContractArtifacts.js";

if (process.argv.includes("--check")) {
  const current = await isRetrievalAnswerGeneratedContractCurrent();
  if (!current) {
    console.error(
      `Generated skill contract is stale: ${retrievalAnswerGeneratedContractPath}\n` +
        "Run `npm run generate:skills` from backend/.",
    );
    process.exitCode = 1;
  }
} else {
  await writeRetrievalAnswerGeneratedContract();
  console.log(`Wrote ${retrievalAnswerGeneratedContractPath}`);
}
