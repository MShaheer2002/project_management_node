import test from "node:test";
import assert from "node:assert/strict";
import { extractBearerToken, extractMcpAccessToken, extractMcpLogicalSessionHint } from "./mcp.auth.js";

test("extractBearerToken returns the bearer token value", () => {
  assert.equal(extractBearerToken("Bearer lin_test_abc123"), "lin_test_abc123");
});

test("extractMcpAccessToken prefers bearer auth over query params", () => {
  const token = extractMcpAccessToken({
    authorizationHeader: "Bearer lin_test_header",
    query: { api_key: "lin_test_query" },
  });

  assert.equal(token, "lin_test_header");
});

test("extractMcpAccessToken falls back to api_key query param", () => {
  const token = extractMcpAccessToken({
    query: { api_key: "lin_test_query" },
  });

  assert.equal(token, "lin_test_query");
});

test("extractMcpAccessToken falls back to token query param", () => {
  const token = extractMcpAccessToken({
    query: { token: "lin_test_query" },
  });

  assert.equal(token, "lin_test_query");
});

test("extractMcpAccessToken throws when no token is provided", () => {
  assert.throws(
    () => extractMcpAccessToken({}),
    /Missing MCP token/,
  );
});

test("extractMcpLogicalSessionHint uses openai session metadata when available", () => {
  const hint = extractMcpLogicalSessionHint({
    method: "tools/call",
    params: {
      clientInfo: {
        name: "openai-mcp",
        version: "1.0.0",
      },
      _meta: {
        "openai/session": "sess_123",
      },
    },
  });

  assert.deepEqual(hint, {
    sessionKey: "openai:sess_123",
    providerSessionId: "sess_123",
    clientName: "openai-mcp",
    clientVersion: "1.0.0",
  });
});

test("extractMcpLogicalSessionHint falls back to subject grouping when session is absent", () => {
  const hint = extractMcpLogicalSessionHint({
    params: {
      _meta: {
        "openai/subject": "subject_123",
      },
    },
  });

  assert.deepEqual(hint, {
    sessionKey: "openai-subject:subject_123",
  });
});
