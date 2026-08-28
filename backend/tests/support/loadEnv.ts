import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { Server as TlsServer } from "node:tls";

type TestServer = ReturnType<typeof import("node:http").createServer>;

type SupertestTest = {
  _server?: TestServer;
};

type SupertestTestPrototype = SupertestTest & {
  __radiosoListenerAddress?: boolean;
  serverAddress: (app: TestServer, path: string) => string;
};

const require = createRequire(import.meta.url);
const { Test } = require("supertest") as {
  Test: { prototype: SupertestTestPrototype };
};

const installSupertestListenerAddress = (): void => {
  if (Test.prototype.__radiosoListenerAddress) {
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

    const listenerHost = address.address === "::"
      ? "::1"
      : address.address === "0.0.0.0"
        ? "127.0.0.1"
        : address.address;
    const urlHost = listenerHost.includes(":") ? `[${listenerHost}]` : listenerHost;
    const protocol = app instanceof TlsServer ? "https" : "http";
    return `${protocol}://${urlHost}:${address.port}${path}`;
  };
  Test.prototype.__radiosoListenerAddress = true;
};

installSupertestListenerAddress();

if (existsSync(".env")) {
  process.loadEnvFile(".env");
} else if (existsSync("../.env")) {
  process.loadEnvFile("../.env");
}
