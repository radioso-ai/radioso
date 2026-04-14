import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const DEFAULT_QUERY = `
SELECT
  COUNT(*) FILTER (WHERE status = 'queued' AND available_at <= NOW()) AS queued_job_count,
  COUNT(*) FILTER (WHERE status = 'processing') AS processing_job_count,
  TO_CHAR(MIN(created_at) FILTER (WHERE status = 'queued' AND available_at <= NOW()) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS oldest_queued_job_created_at
FROM document_processing_jobs;
`.trim();

const defaultSpawnQuery = async ({ databaseUrl, query }) => {
  const { stdout } = await execFileAsync("psql", ["-d", databaseUrl, "-At", "-F", "|", "-c", query], {
    env: process.env,
  });
  return stdout.trim();
};

export const createQueueSnapshotCollector = ({
  databaseUrl,
  spawnQuery = defaultSpawnQuery,
  now = () => new Date(),
}) => {
  if (!databaseUrl) {
    throw new Error("Queue snapshot collector requires a database URL.");
  }

  return {
    name: "queue-snapshot",
    async sample() {
      const output = await spawnQuery({ databaseUrl, query: DEFAULT_QUERY });
      const [queuedJobCount, processingJobCount, oldestCreatedAt] = output.split("|");
      const oldestQueuedAgeMs = oldestCreatedAt
        ? Math.max(0, now().getTime() - new Date(oldestCreatedAt).getTime())
        : null;

      return {
        queuedJobCount: Number(queuedJobCount ?? 0),
        processingJobCount: Number(processingJobCount ?? 0),
        oldestQueuedAgeMs,
      };
    },
  };
};
