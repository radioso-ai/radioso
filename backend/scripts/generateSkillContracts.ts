// First: Zod 4 gives `.openapi()` only to schemas built after this runs.
import "../src/app/http/openapi/zodOpenApiExtension.js";
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
        "Run `pnpm run generate:skills` from backend/.",
    );
    process.exitCode = 1;
  }
} else {
  await writeRetrievalAnswerGeneratedContract();
  console.log(`Wrote ${retrievalAnswerGeneratedContractPath}`);
}
