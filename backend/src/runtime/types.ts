import type { Server } from "node:http";

export interface RuntimeHandle {
  server?: Server;
  shutdown(signal: string): Promise<void>;
}
