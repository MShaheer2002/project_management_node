import test from "node:test";
import assert from "node:assert/strict";
import { clerkUserSchema } from "./auth.schemas.js";
import { verifiedEmailOf } from "./auth.service.js";

const user = (emails: Array<[string, string, string | null]>, primary: string | null) => clerkUserSchema.parse({
  id: "user_1", first_name: "A", last_name: null, image_url: null, primary_email_address_id: primary,
  email_addresses: emails.map(([id, email_address, status]) => ({ id, email_address, verification: status ? { status } : null })),
});

test("stores the verified primary email, not the first one (N-02)", () => {
  const data = user([["e1", "boss@victim.com", "unverified"], ["e2", "Me@Mine.com", "verified"]], "e2");
  assert.equal(verifiedEmailOf(data), "me@mine.com");
});

test("an unverified address never becomes the account email", () => {
  assert.equal(verifiedEmailOf(user([["e1", "boss@victim.com", "unverified"], ["e2", "me@mine.com", "verified"]], "e1")), "me@mine.com",
    "unverified primary falls back to a verified address");
  assert.equal(verifiedEmailOf(user([["e1", "boss@victim.com", "unverified"]], "e1")), "user_1@unverified.invalid",
    "no verified address: placeholder that matches no invitation");
  assert.equal(verifiedEmailOf(user([["e1", "boss@victim.com", null]], "e1")), "user_1@unverified.invalid", "missing status counts as unverified");
});

test("older payloads without a primary id still use a verified address", () => {
  assert.equal(verifiedEmailOf(user([["e1", "x@unverified.com", "unverified"], ["e2", "ok@mine.com", "verified"]], null)), "ok@mine.com");
});
