import { spawn } from "node:child_process";
import net from "node:net";

export const runCommand = (command, args = [], options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      resolve({ ok: false, code: null, stdout, stderr, error });
    });

    child.on("close", (code) => {
      resolve({ ok: code === 0, code, stdout, stderr });
    });
  });

export const spawnInherited = (command, args = [], options = {}) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("close", (code, signal) =>
      resolve({
        code: code ?? 1,
        signal: signal ?? null,
      }),
    );
  });

export const isPortAvailable = (port, host = "127.0.0.1") =>
  new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.on("error", () => resolve(false));
    server.listen(port, host, () => {
      server.close(() => resolve(true));
    });
  });

export const sleep = (ms) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
