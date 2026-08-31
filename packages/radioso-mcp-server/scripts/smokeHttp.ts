import { runWorkspaceCredentialRejectionSmoke } from "../testing/remoteSmokeHarness.js";

const main = async () => {
  const summary = await runWorkspaceCredentialRejectionSmoke({
    step(message) {
      console.info(`[smoke:http] ${message}`);
    },
  });

  console.info("[smoke:http] completed");
  console.info(
    JSON.stringify(
      {
        code: summary.code,
        status: summary.status,
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
