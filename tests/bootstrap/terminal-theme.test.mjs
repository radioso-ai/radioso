import test from "node:test";
import assert from "node:assert/strict";

import { renderHeader, formatMessage } from "../../scripts/bootstrap/terminal-theme.mjs";

test("renderHeader includes sun label in fallback mode", () => {
  const header = renderHeader({ enabled: false, width: 80 });
  assert.match(header, /SUN/);
  assert.match(header, /Radioso local start/);
});

test("renderHeader includes ansi escapes when styling is enabled", () => {
  const header = renderHeader({ enabled: true, width: 80 });
  assert.match(header, /\u001b\[/);
});

test("formatMessage leaves plain text untouched without ansi", () => {
  assert.equal(formatMessage("success", "ok", { enabled: false }), "ok");
});
