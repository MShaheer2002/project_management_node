/**
 * AI Assistance evaluation set: real questions with what a good answer must
 * contain (content/help-eval/cases.json).
 *
 * Three tiers:
 *  1. `npm test`: the case file is valid, and every instant-answer case is
 *     answered correctly without a model (help.eval.test.ts).
 *  2. `npm run help:eval`: search quality. For each question, an expected
 *     article must be in the top 5 sections (needs the database index).
 *  3. `npm run help:eval -- --answers`: every question through the full
 *     assistant with the real model, scored (needs the database and an AI key;
 *     meant to run nightly or before releases).
 *
 * Tiers 2 and 3 never touch a workspace: assist() runs with `evalAssistIO`.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { AssistIO } from "../ai/ai.assist.js";
import type { AiAssistResponse } from "../ai/ai.schemas.js";
import type { AssistContext } from "../ai/ai.assist-context.js";
import { allHelpArticles } from "./help.service.js";
import type { HelpSearchHit } from "./help.index.js";

const roleSchema = z.enum(["OWNER", "ADMIN", "MEMBER", "GUEST"]);

const caseSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]+$/),
  question: z.string().min(2).max(500),
  role: roleSchema,
  route: z.string().regex(/^\/[A-Za-z0-9/_-]*$/),
  tags: z.array(z.string()),
  history: z.array(z.object({ role: z.enum(["user", "assistant"]), content: z.string() })).optional(),
  expect: z
    .object({
      /** At least one of these must be among the sources (and in the top 5 search results). */
      articles: z.array(z.string()).min(1).optional(),
      /** Answered locally, without the model. */
      instant: z.boolean().optional(),
      navigation: z.string().optional(),
      noNavigation: z.boolean().optional(),
      /** The assistant should decline ("not sure"). */
      notSure: z.boolean().optional(),
      mustMention: z.array(z.string()).optional(),
      mustNotMention: z.array(z.string()).optional(),
    })
    .refine((expect) => expect.articles || expect.notSure || expect.navigation || expect.noNavigation, "expect needs at least one check"),
});

export type EvalCase = z.infer<typeof caseSchema>;

export const EVAL_CASES_PATH = path.join(process.cwd(), "content", "help-eval", "cases.json");

export function loadEvalCases(file = EVAL_CASES_PATH): EvalCase[] {
  const parsed = z.object({ version: z.literal(1), cases: z.array(caseSchema).min(1) }).parse(JSON.parse(readFileSync(file, "utf8")));
  const ids = new Set<string>();
  for (const item of parsed.cases) {
    if (ids.has(item.id)) throw new Error(`Duplicate eval case id ${item.id}`);
    ids.add(item.id);
  }
  return parsed.cases;
}

/** Problems in the case file itself: unknown articles, or articles the case's role can't read. */
export function validateEvalCases(cases: EvalCase[]): string[] {
  const byId = new Map(allHelpArticles().map((article) => [article.id, article]));
  const problems: string[] = [];
  for (const item of cases) {
    for (const id of item.expect.articles ?? []) {
      const article = byId.get(id);
      if (!article) problems.push(`${item.id}: unknown article ${id}`);
      else if (!article.roles.includes(item.role)) problems.push(`${item.id}: ${item.role} can't read ${id}`);
    }
  }
  return problems;
}

/** Tier 2: an expected article must be among the top results. */
export function scoreRetrieval(item: EvalCase, hits: HelpSearchHit[], k = 5): { pass: boolean; got: string[] } {
  const got = [...new Set(hits.map((hit) => hit.articleId))].slice(0, k);
  const expected = item.expect.articles ?? [];
  return { pass: expected.length === 0 || expected.some((id) => got.includes(id)), got };
}

/** Tier 3 (and the instant cases in tier 1): what the answer must and must not do. */
export function scoreAnswer(item: EvalCase, response: AiAssistResponse & { usage?: { model: string } }): string[] {
  const failures: string[] = [];
  const expect = item.expect;
  const sources = (response.sources ?? []).map((source) => source.articleId);
  const text = `${response.title ?? ""}\n${response.answer}`.toLowerCase();

  // Instant answers are local AND never carry a grounding verdict (the "AI unavailable" fallback is local too, but has one).
  if (expect.instant && (response.usage?.model !== "local" || response.grounded !== undefined)) failures.push("expected an instant answer, but it went to the model");
  if (expect.notSure) {
    if (response.grounded !== false) failures.push("expected 'not sure', but it answered");
  } else if (expect.articles && !expect.articles.some((id) => sources.includes(id))) {
    failures.push(`expected a source from [${expect.articles.join(", ")}], got [${sources.join(", ") || "none"}]`);
  }
  if (expect.navigation && response.navigation?.route !== expect.navigation) {
    failures.push(`expected a link to ${expect.navigation}, got ${response.navigation?.route ?? "none"}`);
  }
  if (expect.noNavigation && response.navigation) failures.push(`expected no page link, got ${response.navigation.route}`);
  for (const phrase of expect.mustMention ?? []) {
    if (!text.includes(phrase.toLowerCase())) failures.push(`should mention "${phrase}"`);
  }
  for (const phrase of expect.mustNotMention ?? []) {
    if (text.includes(phrase.toLowerCase())) failures.push(`must not mention "${phrase}"`);
  }
  return failures;
}

/** A plausible workspace for the case's role, so plan and usage questions have facts. */
function evalContext(role: EvalCase["role"]): AssistContext {
  const isAdmin = role === "OWNER" || role === "ADMIN";
  return {
    role,
    plan: "FREE",
    ...(isAdmin ? { members: { count: 6, pendingInvites: 1, cap: 10 }, storage: { usedBytes: 50 * 1024 ** 2, limitBytes: 2 * 1024 ** 3 } } : {}),
    ...(role !== "GUEST" ? { integrations: ["Slack"], driveConnected: false } : {}),
  };
}

/** assist() dependencies for evaluation: nothing is read from or written to a workspace. */
export function evalAssistIO(item: EvalCase): AssistIO {
  return {
    checkAccess: async () => {},
    countOpenAssigned: async () => 3,
    loadHistory: async () => item.history ?? [],
    loadContext: async () => evalContext(item.role),
    recordAnswer: async () => null,
    saveTurn: async () => {},
    recordUsage: async () => {},
  };
}
