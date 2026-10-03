/**
 * Run the AI Assistance evaluation set (content/help-eval/cases.json).
 *
 *   npm run help:eval                      # tier 2: search quality (database)
 *   npm run help:eval -- --answers         # tier 3: full answers with the real model (database + AI key)
 *   npm run help:eval -- --answers --only people,plans   # cases with these tags or ids
 *   npm run help:eval -- --json report.json              # also write a machine-readable report
 *
 * Exits 1 when a score is below its threshold (--min-search, default 0.9;
 * --min-answers, default 0.85), so it can gate a nightly job or a release.
 * Nothing is written to any workspace: answers run with evalAssistIO.
 */
import { writeFileSync } from "node:fs";
import { prisma } from "../shared/utils/prisma.js";
import { env } from "../config/env.js";
import { initHelpArticles, searchHelpSections, syncHelpSearchIndex } from "../modules/help/help.service.js";
import { evalAssistIO, loadEvalCases, scoreAnswer, scoreRetrieval, validateEvalCases, type EvalCase } from "../modules/help/help.eval.js";
import { assist, retrievalQuery } from "../modules/ai/ai.assist.js";

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(`--${name}`);
const option = (name: string) => {
  const index = args.indexOf(`--${name}`);
  return index === -1 ? undefined : args[index + 1];
};

async function inBatches<T, R>(items: T[], size: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = [];
  for (let i = 0; i < items.length; i += size) results.push(...(await Promise.all(items.slice(i, i + size).map(run))));
  return results;
}

async function main() {
  initHelpArticles();
  const only = option("only")?.split(",").map((value) => value.trim()).filter(Boolean);
  const all = loadEvalCases();
  const problems = validateEvalCases(all);
  if (problems.length) throw new Error(`Invalid eval cases:\n${problems.join("\n")}`);
  const cases = only ? all.filter((item) => only.includes(item.id) || item.tags.some((tag) => only.includes(tag))) : all;

  console.log(`Syncing the help index…`);
  const sync = await syncHelpSearchIndex();
  console.log(sync.skipped ? "Another instance is syncing; using the index as is." : `Index: ${sync.chunks} sections (${sync.embedded} embedded now).`);
  if (!env.OPENROUTER_API_KEY) console.log("No OPENROUTER_API_KEY: search is keyword-only.");

  // ── Tier 2: search ──
  const searchCases = cases.filter((item) => item.expect.articles && !item.expect.instant && !item.expect.notSure);
  const search = await inBatches(searchCases, 4, async (item) => {
    const hits = await searchHelpSections(retrievalQuery(item.question, item.history ?? []), { role: item.role, plan: "FREE" }, item.route, 5);
    return { item, ...scoreRetrieval(item, hits) };
  });
  const searchScore = search.length ? search.filter((result) => result.pass).length / search.length : 1;
  console.log(`\nSearch: ${search.filter((r) => r.pass).length}/${search.length} found an expected article in the top 5 (${Math.round(searchScore * 100)}%)`);
  for (const result of search.filter((r) => !r.pass)) {
    console.log(`  ✗ ${result.item.id}: "${result.item.question}" expected [${result.item.expect.articles!.join(", ")}], got [${result.got.join(", ")}]`);
  }

  // ── Tier 3: answers ──
  let answers: Array<{ item: EvalCase; failures: string[]; answer: string }> = [];
  if (flag("answers")) {
    if (!env.OPENROUTER_API_KEY) throw new Error("--answers needs OPENROUTER_API_KEY");
    answers = await inBatches(cases, 3, async (item) => {
      try {
        const response = await assist(
          { message: item.question, route: item.route, workspaceId: "eval", userId: "eval", userRole: item.role } as never,
          { io: evalAssistIO(item) },
        );
        return { item, failures: scoreAnswer(item, response), answer: response.answer };
      } catch (error) {
        return { item, failures: [`threw: ${error instanceof Error ? error.message : String(error)}`], answer: "" };
      }
    });
    const passed = answers.filter((result) => result.failures.length === 0).length;
    console.log(`\nAnswers: ${passed}/${answers.length} passed (${Math.round((passed / answers.length) * 100)}%)`);
    const byTag = new Map<string, { pass: number; total: number }>();
    for (const result of answers) for (const tag of result.item.tags) {
      const entry = byTag.get(tag) ?? { pass: 0, total: 0 };
      entry.total += 1;
      if (result.failures.length === 0) entry.pass += 1;
      byTag.set(tag, entry);
    }
    console.log(`  by tag: ${[...byTag].map(([tag, { pass, total }]) => `${tag} ${pass}/${total}`).join(", ")}`);
    for (const result of answers.filter((r) => r.failures.length)) {
      console.log(`  ✗ ${result.item.id}: ${result.failures.join("; ")}\n      answer: ${result.answer.replace(/\s+/g, " ").slice(0, 160)}`);
    }
  }

  const answerScore = answers.length ? answers.filter((r) => r.failures.length === 0).length / answers.length : 1;
  const minSearch = Number(option("min-search") ?? 0.9);
  const minAnswers = Number(option("min-answers") ?? 0.85);
  const jsonPath = option("json");
  if (jsonPath) {
    writeFileSync(jsonPath, JSON.stringify({
      ranAt: new Date().toISOString(),
      search: { score: searchScore, results: search.map((r) => ({ id: r.item.id, pass: r.pass, got: r.got })) },
      answers: { score: answerScore, results: answers.map((r) => ({ id: r.item.id, failures: r.failures, answer: r.answer })) },
    }, null, 2));
    console.log(`\nReport written to ${jsonPath}`);
  }

  if (searchScore < minSearch || answerScore < minAnswers) {
    console.error(`\nBelow threshold (search ${Math.round(searchScore * 100)}% vs ${minSearch * 100}%, answers ${Math.round(answerScore * 100)}% vs ${minAnswers * 100}%).`);
    process.exitCode = 1;
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
