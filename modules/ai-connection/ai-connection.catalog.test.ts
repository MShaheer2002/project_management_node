import test from "node:test";
import assert from "node:assert/strict";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import {
  assertAiConnectionAuthMethodSupported,
  listAiConnectionCatalog,
} from "./ai-connection.catalog.js";

test("AI connection catalog exposes both PAT and OAuth as implemented", () => {
  const catalog = listAiConnectionCatalog();

  assert.equal(catalog.clients.length, 9);
  assert.equal(catalog.authMethods.some((method) => method.type === "pat" && method.implemented), true);
  assert.equal(catalog.authMethods.some((method) => method.type === "oauth" && method.implemented), true);
});

test("PAT connections remain supported for current clients", () => {
  assert.doesNotThrow(() => assertAiConnectionAuthMethodSupported("codex", "pat"));
  assert.doesNotThrow(() => assertAiConnectionAuthMethodSupported("claude_desktop", "pat"));
});

test("OAuth isn't created through the token-generation form — clear redirect error", () => {
  assert.throws(
    () => assertAiConnectionAuthMethodSupported("codex", "oauth"),
    (error: unknown) =>
      error instanceof AppError &&
      error.code === ERROR_CODES.AI_CONNECTION_AUTH_UNSUPPORTED &&
      error.message.includes("your AI client"),
  );
});
