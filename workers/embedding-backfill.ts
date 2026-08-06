/**
 * Embedding backfill runner.
 *
 * Indexes existing entities that predate the on-write indexing hooks. Run once
 * after deploying those hooks, and again after any change to how embedding
 * content is rendered (a content-shape change invalidates every stored vector,
 * because vectors built from differently-shaped text are not comparable).
 *
 *   npm run backfill:embeddings -- --dry-run
 *   npm run backfill:embeddings
 *   npm run backfill:embeddings -- --workspace <id> --types ISSUE,COMMENT
 *
 * Safe to re-run and safe to interrupt: unchanged content is skipped without an
 * API call, and progress is cursor-based rather than held in one transaction.
 */

import { prisma } from "../shared/utils/prisma.js";
import { runEmbeddingBackfill } from "../modules/ai/ai.backfill.js";
import { INDEXABLE_ENTITY_TYPES, type IndexableEntityType } from "../modules/ai/ai.embedding-content.js";

function parseArgs(argv: string[]) {
  const args = new Map<string, string | boolean>();
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      args.set(key, next);
      i += 1;
    } else {
      args.set(key, true);
    }
  }
  return args;
}

function parseEntityTypes(value: string | boolean | undefined): IndexableEntityType[] | undefined {
  if (typeof value !== "string") return undefined;

  const requested = value
    .split(",")
    .map((entry) => entry.trim().toUpperCase())
    .filter(Boolean);

  const invalid = requested.filter(
    (entry) => !(INDEXABLE_ENTITY_TYPES as readonly string[]).includes(entry),
  );
  if (invalid.length > 0) {
    throw new Error(
      `Unknown entity type(s): ${invalid.join(", ")}. Valid: ${INDEXABLE_ENTITY_TYPES.join(", ")}`,
    );
  }

  return requested as IndexableEntityType[];
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const dryRun = args.get("dry-run") === true;
  const workspaceId = typeof args.get("workspace") === "string" ? (args.get("workspace") as string) : undefined;
  const entityTypes = parseEntityTypes(args.get("types"));
  const concurrency = typeof args.get("concurrency") === "string" ? Number(args.get("concurrency")) : undefined;

  console.log("Embedding backfill");
  console.log(`  mode:        ${dryRun ? "dry run (no API calls, no writes)" : "live"}`);
  console.log(`  workspace:   ${workspaceId ?? "all"}`);
  console.log(`  types:       ${entityTypes?.join(", ") ?? "all"}`);
  console.log("");

  const seen = new Set<string>();

  const result = await runEmbeddingBackfill({
    ...(workspaceId ? { workspaceId } : {}),
    ...(entityTypes ? { entityTypes } : {}),
    ...(concurrency && Number.isFinite(concurrency) ? { concurrency } : {}),
    dryRun,
    onProgress: (progress) => {
      // One line per entity type per workspace, rewritten as it advances, so a
      // long run shows movement without flooding the terminal.
      const key = `${progress.workspaceId}:${progress.entityType}`;
      const prefix = seen.has(key) ? "" : "\n";
      seen.add(key);
      process.stdout.write(
        `${prefix}\r  ${progress.entityType.padEnd(11)} scanned=${progress.scanned} new=${progress.indexed} unchanged=${progress.unchanged} skipped=${progress.skipped} failed=${progress.failed}   `,
      );
    },
  });

  console.log("\n");
  console.log("Done.");
  console.log(`  scanned:   ${result.scanned}`);
  console.log(`  embedded:  ${result.indexed}   (fresh vectors — billed)`);
  console.log(`  unchanged: ${result.unchanged}   (content hash matched — no API call)`);
  console.log(`  skipped:   ${result.skipped}   (nothing embeddable)`);
  console.log(`  failed:    ${result.failed}`);
  console.log(`  took:      ${(result.durationMs / 1000).toFixed(1)}s`);

  if (result.failed > 0) {
    console.log("\nSome rows failed — see embedding_backfill_row_failed in the logs.");
  }

  // Non-zero exit on failures so CI or a deploy step can react.
  process.exitCode = result.failed > 0 ? 1 : 0;
}

main()
  .catch((error: unknown) => {
    console.error("Backfill failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
