import test from "node:test";
import assert from "node:assert/strict";
import { encryptSecret, decryptSecret, decryptSecretOrLegacy, isEncryptedSecret } from "./secret-box.js";

const TOKENS = [
  "gho_16C7e42F292c6912E7710c838347Ae178B4a",  // GitHub OAuth
  "xoxb-1234567890-1234567890123-abcdefghijklmnop", // Slack bot
  "figd_AbCdEfGhIjKlMnOpQrStUvWxYz-0123456789",  // Figma
];

test("a token round-trips", () => {
  for (const token of TOKENS) {
    assert.equal(decryptSecret(encryptSecret(token)), token);
  }
});

test("ciphertext does not contain the plaintext, and differs every time", () => {
  const token = TOKENS[0]!;
  const a = encryptSecret(token);
  const b = encryptSecret(token);
  assert.equal(a.includes(token), false, "plaintext leaked into ciphertext");
  assert.notEqual(a, b, "same output twice means the IV is not random");
  assert.equal(decryptSecret(b), token);
});

test("real provider tokens are never mistaken for ciphertext (F-15 legacy rows)", () => {
  // This is what lets pre-encryption plaintext rows keep working without a
  // migration flag — if a real token ever matched, it would be fed to the
  // decipher and throw instead.
  for (const token of TOKENS) {
    assert.equal(isEncryptedSecret(token), false, `${token} looks like ciphertext`);
    assert.equal(decryptSecretOrLegacy(token), token);
  }
  assert.equal(isEncryptedSecret(encryptSecret(TOKENS[0]!)), true);
});

test("tampering with the ciphertext is rejected, not silently accepted", () => {
  // GCM is authenticated: flipping a byte must fail, not decrypt to garbage.
  const [iv, body, tag] = encryptSecret(TOKENS[0]!).split(":") as [string, string, string];
  const flipped = body.startsWith("a") ? `b${body.slice(1)}` : `a${body.slice(1)}`;
  assert.throws(() => decryptSecret(`${iv}:${flipped}:${tag}`));
});
