import { spawn } from "node:child_process";
import net from "node:net";

export const runCommand = (command, args = [], options = {}) =>
  new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeoutMs = options.timeoutMs ?? null;

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let timeoutId = null;

    const finalize = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      resolve(result);
    };

    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      finalize({ ok: false, code: null, stdout, stderr, error, timedOut });
    });

    child.on("close", (code) => {
      finalize({ ok: !timedOut && code === 0, code, stdout, stderr, timedOut });
    });

    if (typeof timeoutMs === "number" && timeoutMs > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        stderr += stderr.endsWith("\n") || stderr.length === 0 ? "" : "\n";
        stderr += `Command timed out after ${timeoutMs}ms`;
        child.kill("SIGTERM");
      }, timeoutMs);
      timeoutId.unref?.();
    }
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
