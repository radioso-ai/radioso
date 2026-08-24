/** Which process a log line or span came from. Shared by logging and tracing, owned by neither. */
export type RuntimeRole =
  | "api"
  | "document-worker"
  | "document-worker-task-server"
  | "crawler-worker"
  | "crawler-worker-task-server";
