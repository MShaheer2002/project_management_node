/**
 * Rebuild the help search index (HelpChunk) from content/help/*.md.
 *
 * The server does this on every start; run it by hand after editing articles
 * locally, or to fill in embeddings that failed during a deploy. Safe to run
 * any time: only changed sections are rewritten and re-embedded.
 *
 *   npm run help:reindex
 */
import { prisma } from "../shared/utils/prisma.js";
import { initHelpArticles, syncHelpSearchIndex } from "../modules/help/help.service.js";

async function main() {
  console.log(`Loaded ${initHelpArticles()} help articles.`);
  const result = await syncHelpSearchIndex();
  console.log(result.skipped ? "Another instance is syncing right now; try again in a minute." : result);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
