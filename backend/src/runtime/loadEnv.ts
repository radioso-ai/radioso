import { existsSync } from "node:fs";

export const loadEnvFileIfPresent = () => {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }
};
