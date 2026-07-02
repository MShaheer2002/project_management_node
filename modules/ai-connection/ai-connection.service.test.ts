import test from "node:test";
import assert from "node:assert/strict";
import {
  buildClaudeDesktopConfig,
  buildCodexConfig,
  buildCursorConfig,
  buildGenericSetup,
  resolveCodexMcpUrl,
  resolveMcpBaseUrl,
  toConnectionStatus,
} from "./ai-connection.service.js";
import { AiConnectionStatus } from "../../app/generated/prisma/client.js";

test("resolveMcpBaseUrl points at the remote MCP endpoint", () => {
  assert.match(resolveMcpBaseUrl(), /\/mcp$/);
});

test("resolveCodexMcpUrl appends the token as api_key for Codex compatibility", () => {
  const url = resolveCodexMcpUrl("lin_test_abc123");
  assert.match(url, /\?api_key=lin_test_abc123$/);
});

test("buildCodexConfig emits a minimal MCP toml block", () => {
  const config = buildCodexConfig("lin_test_abc123");
  assert.match(config, /\[mcp_servers\.trussen\]/);
  assert.match(config, /api_key=lin_test_abc123/);
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
