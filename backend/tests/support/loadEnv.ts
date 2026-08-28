import { existsSync } from "node:fs";
import { createRequire } from "node:module";

type TestServer = ReturnType<typeof import("node:http").createServer>;

type SupertestTest = {
  _server?: TestServer;
};

type SupertestTestPrototype = SupertestTest & {
  __radiosoIpv6Loopback?: boolean;
  serverAddress: (app: TestServer, path: string) => string;
};

const require = createRequire(import.meta.url);
const { Test } = require("supertest") as {
  Test: { prototype: SupertestTestPrototype };
};

const installIpv6SupertestLoopback = (): void => {
  if (Test.prototype.__radiosoIpv6Loopback) {
    return;
  }

  const originalServerAddress = Test.prototype.serverAddress;
  Test.prototype.serverAddress = function serverAddress(app, path) {
    if (!app.address()) {
      this._server = app.listen(0);
    }
    const address = app.address();
    if (!address || typeof address === "string") {
      return originalServerAddress.call(this, app, path);
    }

    // Node binds Supertest's ephemeral server on IPv6 by default. Sending the
    // request to ::1 avoids local IPv4 loopback routing interference.
    return `http://[::1]:${address.port}${path}`;
  };
  Test.prototype.__radiosoIpv6Loopback = true;
};

installIpv6SupertestLoopback();

if (existsSync(".env")) {
  process.loadEnvFile(".env");
} else if (existsSync("../.env")) {
  process.loadEnvFile("../.env");
}
