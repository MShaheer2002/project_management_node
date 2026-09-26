import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeDesktopConfig,
  buildCodexConfig,
  buildCursorConfig,
  evaluateAiConnectionHealth,
  buildGenericSetup,
  resolveMcpBaseUrl,
  toConnectionStatus,
} from "./ai-connection.service.js";
import { AiConnectionStatus } from "../../app/generated/prisma/client.js";

test("resolveMcpBaseUrl points at the remote MCP endpoint", () => {
  assert.match(resolveMcpBaseUrl(), /\/mcp$/);
});

test("buildCodexConfig emits a minimal MCP toml block", () => {
  const config = buildCodexConfig("lin_test_abc123");
  assert.match(config, /\[mcp_servers\.trussen\]/);
  assert.match(config, /http_headers = \{ Authorization = "Bearer lin_test_abc123" \}/);
});

test("no client config puts the token in a URL (F-14)", () => {
  // A PAT in a query string leaks into every upstream proxy/CDN/tunnel access
  // log, shell history and Referer header. Codex used to be generated that way.
  const token = "lin_test_abc123";
  for (const [name, config] of [
    ["codex", buildCodexConfig(token)],
    ["claudeDesktop", buildClaudeDesktopConfig(token)],
    ["cursor", buildCursorConfig(token)],
  ] as const) {
    assert.equal(config.includes("api_key="), false, `${name} config embeds api_key in a URL`);
    assert.equal(config.includes(`?${token}`), false, `${name} config puts the token in a query string`);
    assert.match(config, /Authorization/, `${name} config does not use header auth`);
  }
});

test("the Codex block is valid TOML shape — key = value per line, token not in the url", () => {
  const lines = buildCodexConfig("lin_test_abc123").split("\n");
  const urlLine = lines.find((line) => line.startsWith("url = "));
  assert.ok(urlLine, "no url line");
  assert.equal(urlLine!.includes("lin_test_abc123"), false, "token leaked into the url line");
});

test("desktop-style clients use bearer auth config", () => {
  const claudeConfig = buildClaudeDesktopConfig("lin_test_abc123");
  const cursorConfig = buildCursorConfig("lin_test_abc123");

  assert.match(claudeConfig, /Authorization/);
  assert.match(cursorConfig, /Authorization/);
  assert.match(claudeConfig, /Bearer lin_test_abc123/);
  assert.match(cursorConfig, /Bearer lin_test_abc123/);
});

test("generic MCP setup exposes endpoint and auth header guidance", () => {
  const setup = buildGenericSetup("lin_test_abc123");

  assert.match(setup.endpoint, /\/mcp$/);
  assert.equal(setup.authHeaderName, "Authorization");
  assert.equal(setup.authHeaderValue, "Bearer lin_test_abc123");
  assert.equal(setup.steps.length, 3);
});

test("connection status resolves active, expired, and revoked correctly", () => {
  assert.equal(
    toConnectionStatus({
      status: AiConnectionStatus.ACTIVE,
      apiKeyId: "key_1",
      apiKeyExpiresAt: new Date(Date.now() + 60_000),
    }),
    "active",
  );

  assert.equal(
    toConnectionStatus({
      status: AiConnectionStatus.ACTIVE,
      apiKeyId: "key_1",
      apiKeyExpiresAt: new Date(Date.now() - 60_000),
    }),
    "expired",
  );

  assert.equal(
    toConnectionStatus({
      status: AiConnectionStatus.REVOKED,
      apiKeyId: null,
      apiKeyExpiresAt: null,
    }),
    "revoked",
  );
});

test("connection health reports ready for active HTTPS PAT connections", () => {
  const health = evaluateAiConnectionHealth({
    endpointUrl: "https://example.ngrok-free.dev/mcp",
    lifecycleStatus: "active",
    authType: "pat",
    availableAuthMethods: ["pat"],
  });

  assert.equal(health.status, "ready");
  assert.equal(health.canConnect, true);
});

test("connection health warns when the endpoint is local-only", () => {
  const health = evaluateAiConnectionHealth({
    endpointUrl: "https://localhost:8000/mcp",
    lifecycleStatus: "active",
    authType: "pat",
    availableAuthMethods: ["pat"],
  });

  assert.equal(health.status, "warning");
  assert.equal(health.canConnect, true);
});

test("connection health fails for expired or incompatible connections", () => {
  const expired = evaluateAiConnectionHealth({
    endpointUrl: "https://example.ngrok-free.dev/mcp",
    lifecycleStatus: "expired",
    authType: "pat",
    availableAuthMethods: ["pat"],
  });
  const incompatible = evaluateAiConnectionHealth({
    endpointUrl: "https://example.ngrok-free.dev/mcp",
    lifecycleStatus: "active",
    authType: "pat",
    availableAuthMethods: ["oauth"],
  });

  assert.equal(expired.status, "error");
  assert.equal(expired.canConnect, false);
  assert.equal(incompatible.status, "error");
  assert.equal(incompatible.canConnect, false);
});
