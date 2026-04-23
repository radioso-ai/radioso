import { runSingleNodeSmoke } from "../testing/remoteSmokeHarness.js";

const main = async () => {
  const summary = await runSingleNodeSmoke({
    step(message) {
      console.info(`[smoke:http] ${message}`);
    },
  });

  console.info("[smoke:http] completed");
  console.info(
    JSON.stringify(
      {
        answer: summary.answer,
        documentId: summary.documentId,
        workspaceId: summary.workspaceId,
      },
      null,
      2,
    ),
  );
};

main().catch((error) => {
  console.error("[smoke:http] failed");
  console.error(error);
  process.exit(1);
});
