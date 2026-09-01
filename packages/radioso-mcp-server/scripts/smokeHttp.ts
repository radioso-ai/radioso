import { runConverseGrantSmoke } from "../testing/remoteSmokeHarness.js";

const main = async () => {
  const summary = await runConverseGrantSmoke({
    step(message) {
      console.info(`[smoke:http] ${message}`);
    },
  });

  console.info("[smoke:http] completed");
  console.info(
    JSON.stringify(
      {
        agentId: summary.agentId,
        answerLength: summary.answer.length,
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
