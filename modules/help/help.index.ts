/**
 * Help search index: help articles split into sections, searchable by keyword
 * (Postgres full text) and by meaning (pgvector), merged into one ranking.
 *
 * Sections, not whole articles: a question like "how do I revoke an invite"
 * should land on the "Manage members" part, not a whole page. Each section is
 * stored with its article's title, category and summary in front of it
 * ("contextual retrieval"), so a bare section like "## Manage" still says what
 * it is about to both search methods. The context is built from the article
 * itself rather than written by a model: deterministic, free, and good enough
 * for short, structured articles.
 *
 * The index is rebuilt from the Markdown at startup (`syncHelpIndex`): only
 * changed sections are re-embedded, sections that no longer exist are deleted,
 * and a Postgres advisory lock keeps two instances from doing it at once.
 * Embeddings are optional: without them (no provider, provider down), keyword
 * search still works, and the next sync fills them in.
 *
 * ponytail: two instances starting together can both embed the same new
 *   sections (the lock covers the writes, not the slow embedding step). That
 *   costs a fraction of a cent once per deploy; claim rows before embedding
 *   if the article count grows by orders of magnitude.
 */
import { createHash } from "node:crypto";
import { env } from "../../config/env.js";
import { prisma } from "../../shared/utils/prisma.js";
import { Prisma } from "../../app/generated/prisma/client.js";
import { createEmbedding, EMBEDDING_MODEL_DEFAULT } from "../ai/ai.provider.js";
import { logAiWarn } from "../ai/ai.observability.js";
import type { HelpArticle, HelpRole } from "./help.content.js";

export interface HelpChunk {
  id: string;
  articleId: string;
  ordinal: number;
  sectionTitle: string;
  roles: string[];
  plans: string[];
  content: string;
  contentHash: string;
  /** Text for keyword search by weight: A = title and keywords, B = section heading, D = body. */
  weighted: { a: string; b: string; d: string };
}

export interface HelpSearchHit {
  chunkId: string;
  articleId: string;
  sectionTitle: string;
  /** Section text without the context header, for showing and for the model. */
  text: string;
  score: number;
  matchedBy: "keyword" | "meaning" | "both";
}

const MAX_SECTION_CHARS = 2_400;
const CANDIDATES_PER_METHOD = 20;
const RRF_K = 60;
/** Lifts the current page's article about two places at most: it breaks near-ties, it can't jump better matches. */
const PAGE_BOOST = 1 / (RRF_K + 1) - 1 / (RRF_K + 3);
const MAX_SECTIONS_PER_ARTICLE = 2;
const MIN_SIMILARITY = 0.2;
const MAX_QUERY_CHARS = 300;
/**
 * Bump when the way sections are indexed changes (not their text), so every
 * section is rewritten on the next sync.
 * v2: weighted keyword index (title and keywords > heading > body).
 */
const INDEX_VERSION = "v2";
/** Any stable number unique to this job; Postgres advisory locks are keyed by bigint. */
const SYNC_LOCK_KEY = 72_101_003;

// ─── Chunking ────────────────────────────────────────────────────────────────

function splitLongSection(title: string, text: string): Array<{ title: string; text: string }> {
  if (text.length <= MAX_SECTION_CHARS) return [{ title, text }];

  const parts: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (current && current.length + paragraph.length + 2 > MAX_SECTION_CHARS) {
      parts.push(current);
      current = "";
    }
    current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) parts.push(current);
  return parts.map((part, index) => ({ title: index === 0 ? title : `${title} (continued)`, text: part }));
}

/** One chunk per `##` section; text before the first heading is the "Overview". */
export function chunkHelpArticle(article: HelpArticle, embeddingModel = EMBEDDING_MODEL_DEFAULT): HelpChunk[] {
  const sections: Array<{ title: string; text: string }> = [];
  const pieces = article.body.split(/^## +/m);
  const intro = pieces.shift()?.trim();
  if (intro) sections.push({ title: "Overview", text: intro });
  for (const piece of pieces) {
    const newline = piece.indexOf("\n");
    const title = (newline === -1 ? piece : piece.slice(0, newline)).trim();
    const text = (newline === -1 ? "" : piece.slice(newline + 1)).trim();
    if (text) sections.push(...splitLongSection(title, text));
  }

  return sections.map((section, ordinal) => {
    const content = [
      `Article: ${article.title}`,
      `Category: ${article.category}`,
      `About: ${article.summary}`,
      `Keywords: ${article.keywords.join(", ")}`,
      `Section: ${section.title}`,
      "",
      section.text,
    ].join("\n");
    return {
      id: `${article.id}#${ordinal}`,
      articleId: article.id,
      ordinal,
      sectionTitle: section.title,
      roles: article.roles,
      plans: article.plans,
      content,
      // The model and index version are part of the hash, so changing either rebuilds everything.
      contentHash: createHash("sha256").update(`${INDEX_VERSION}\n${embeddingModel}\n${content}`).digest("hex"),
      weighted: { a: `${article.title} ${article.keywords.join(" ")}`, b: section.title, d: section.text },
    };
  });
}

const sectionTextOf = (content: string) => content.slice(content.indexOf("\n\n") + 2);

// ─── Sync ────────────────────────────────────────────────────────────────────

const vectorLiteral = (embedding: number[]) =>
  `[${embedding.map((value) => (Number.isFinite(value) ? value : 0)).join(",")}]`;

export interface HelpIndexSyncResult {
  skipped: boolean;
  chunks: number;
  written: number;
  deleted: number;
  embedded: number;
  embedFailed: number;
}

export async function syncHelpIndex(
  articles: HelpArticle[],
  options: { embed?: (text: string) => Promise<{ embedding: number[]; model: string }> } = {},
): Promise<HelpIndexSyncResult> {
  const embed = options.embed ?? createEmbedding;
  const chunks = articles.flatMap((article) => chunkHelpArticle(article));
  const result: HelpIndexSyncResult = { skipped: false, chunks: chunks.length, written: 0, deleted: 0, embedded: 0, embedFailed: 0 };

  // Step 1, short and locked: write changed sections and delete removed ones.
  // A transaction-level advisory lock means only one instance does this at a time,
  // and the lock is released with the transaction.
  const toEmbed = await prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<Array<{ locked: boolean }>>`SELECT pg_try_advisory_xact_lock(${SYNC_LOCK_KEY}::bigint) AS locked`;
    if (!rows[0]?.locked) return null;

    const existing = await tx.$queryRaw<Array<{ id: string; contentHash: string; embedded: boolean }>>`
      SELECT "id", "contentHash", "embedding" IS NOT NULL AS "embedded" FROM "HelpChunk"`;
    const existingById = new Map(existing.map((row) => [row.id, row]));
    const wanted = new Set(chunks.map((chunk) => chunk.id));

    for (const chunk of chunks) {
      if (existingById.get(chunk.id)?.contentHash === chunk.contentHash) continue;
      await tx.$executeRaw`
        INSERT INTO "HelpChunk" ("id", "articleId", "ordinal", "sectionTitle", "roles", "plans", "content", "contentHash", "searchVector", "embedding", "model", "updatedAt")
        VALUES (${chunk.id}, ${chunk.articleId}, ${chunk.ordinal}, ${chunk.sectionTitle}, ${chunk.roles}, ${chunk.plans}, ${chunk.content}, ${chunk.contentHash},
                setweight(to_tsvector('english', ${chunk.weighted.a}), 'A')
                  || setweight(to_tsvector('english', ${chunk.weighted.b}), 'B')
                  || setweight(to_tsvector('english', ${chunk.weighted.d}), 'D'),
                NULL, NULL, NOW())
        ON CONFLICT ("id") DO UPDATE SET
          "articleId" = EXCLUDED."articleId", "ordinal" = EXCLUDED."ordinal", "sectionTitle" = EXCLUDED."sectionTitle",
          "roles" = EXCLUDED."roles", "plans" = EXCLUDED."plans", "content" = EXCLUDED."content",
          "contentHash" = EXCLUDED."contentHash", "searchVector" = EXCLUDED."searchVector",
          "embedding" = NULL, "model" = NULL, "updatedAt" = NOW()`;
      existingById.set(chunk.id, { id: chunk.id, contentHash: chunk.contentHash, embedded: false });
      result.written += 1;
    }

    const stale = existing.filter((row) => !wanted.has(row.id)).map((row) => row.id);
    if (stale.length > 0) {
      result.deleted = await tx.$executeRaw`DELETE FROM "HelpChunk" WHERE "id" = ANY(${stale})`;
    }
    return chunks.filter((chunk) => !existingById.get(chunk.id)?.embedded);
  });

  if (toEmbed === null) return { ...result, skipped: true };

  // Step 2, outside any transaction (provider calls are slow): embed what's missing.
  // Each update only lands if the section hasn't changed since, so a newer sync
  // can never be overwritten with an old vector.
  for (const chunk of toEmbed) {
    try {
      const { embedding, model } = await embed(chunk.content);
      await prisma.$executeRaw`
        UPDATE "HelpChunk" SET "embedding" = ${vectorLiteral(embedding)}::vector, "model" = ${model}
        WHERE "id" = ${chunk.id} AND "contentHash" = ${chunk.contentHash}`;
      result.embedded += 1;
    } catch (error) {
      result.embedFailed = toEmbed.length - result.embedded;
      // One failure usually means the provider is down or not configured; stop
      // instead of failing every section. Keyword search still works, and the
      // next sync picks up whatever is missing.
      logAiWarn("help_index_embed_failed", {
        feature: "help",
        success: false,
        errorCode: "HELP_INDEX_EMBED_FAILED",
        errorMessage: error instanceof Error ? error.message : "Embedding failed",
      });
      break;
    }
  }
  return result;
}

// ─── Search ──────────────────────────────────────────────────────────────────

type Row = { id: string; articleId: string; sectionTitle: string; content: string };

/** Ranks in two lists merged with Reciprocal Rank Fusion: robust without tuning score scales. */
export function fuseRankings(
  keyword: Row[],
  meaning: Row[],
  boostArticleIds: ReadonlySet<string> = new Set(),
): HelpSearchHit[] {
  const hits = new Map<string, HelpSearchHit & { inKeyword: boolean; inMeaning: boolean }>();
  const add = (rows: Row[], method: "keyword" | "meaning") =>
    rows.forEach((row, index) => {
      const hit = hits.get(row.id) ?? {
        chunkId: row.id,
        articleId: row.articleId,
        sectionTitle: row.sectionTitle,
        text: sectionTextOf(row.content),
        score: 0,
        matchedBy: method,
        inKeyword: false,
        inMeaning: false,
      };
      hit.score += 1 / (RRF_K + index + 1);
      if (method === "keyword") hit.inKeyword = true;
      else hit.inMeaning = true;
      hits.set(row.id, hit);
    });
  add(keyword, "keyword");
  add(meaning, "meaning");

  // Every hit here matched the question; the page someone is on breaks ties
  // between matches. It never lifts an article that didn't match (asking
  // "how do I invite someone" on the Dashboard is not about the Dashboard).
  const ranked = [...hits.values()]
    .map(({ inKeyword, inMeaning, ...hit }) => ({
      ...hit,
      score: hit.score + (boostArticleIds.has(hit.articleId) ? PAGE_BOOST : 0),
      matchedBy: inKeyword && inMeaning ? ("both" as const) : inKeyword ? ("keyword" as const) : ("meaning" as const),
    }))
    .sort((a, b) => b.score - a.score || a.chunkId.localeCompare(b.chunkId));

  // At most two sections per article, so one long article can't crowd out the others.
  const perArticle = new Map<string, number>();
  return ranked.filter((hit) => {
    const count = perArticle.get(hit.articleId) ?? 0;
    perArticle.set(hit.articleId, count + 1);
    return count < MAX_SECTIONS_PER_ARTICLE;
  });
}

const routeMatches = (articleRoute: string, currentRoute: string) =>
  new RegExp(`^${articleRoute.replace(/:[a-zA-Z]+/g, "[^/]+")}$`).test(currentRoute);

/** Articles about the page the user is on. */
export function articlesForRoute(articles: HelpArticle[], route: string | undefined): Set<string> {
  if (!route) return new Set();
  const path = route.split(/[?#]/)[0]!;
  // An exact page beats a pattern: on /issues/my, boost My issues, not the issue page article.
  const exact = articles.filter((article) => article.route === path);
  const matching = exact.length ? exact : articles.filter((article) => article.route && routeMatches(article.route, path));
  return new Set(matching.map((article) => article.id));
}

// Query embeddings are reused for a few minutes: people retype and page through results.
const queryEmbeddingCache = new Map<string, { embedding: number[]; expires: number }>();
const QUERY_CACHE_TTL_MS = 10 * 60_000;
const QUERY_CACHE_MAX = 500;

// Provider errors are logged at most once a minute: when it is down, every search fails the same way.
let lastEmbedWarnAt = 0;

async function embedQuery(query: string): Promise<number[] | null> {
  // No key configured (e.g. local dev): keyword search only, quietly.
  if (!env.OPENROUTER_API_KEY) return null;
  const key = query.toLowerCase();
  const cached = queryEmbeddingCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.embedding;
  try {
    const { embedding } = await createEmbedding(query);
    if (queryEmbeddingCache.size >= QUERY_CACHE_MAX) queryEmbeddingCache.delete(queryEmbeddingCache.keys().next().value!);
    queryEmbeddingCache.set(key, { embedding, expires: Date.now() + QUERY_CACHE_TTL_MS });
    return embedding;
  } catch (error) {
    if (Date.now() - lastEmbedWarnAt < 60_000) return null;
    lastEmbedWarnAt = Date.now();
    logAiWarn("help_search_embed_failed", {
      feature: "help",
      success: false,
      errorCode: "HELP_SEARCH_EMBED_FAILED",
      errorMessage: error instanceof Error ? error.message : "Embedding failed",
    });
    return null;
  }
}

/**
 * Keyword search ranked like a search engine (BM25-style): each word of the
 * question scores by how rare it is across all sections (IDF) times how it
 * appears in the section (Postgres ts_rank: title and keywords count most,
 * then the heading, then the body). Scores add up over the matching words.
 *
 * So in "where can I see team velocity", "velocity" (in 2 sections) outweighs
 * "team" (in 24), and in "how do I invite someone" the missing word "someone"
 * just doesn't count. Rarity comes from the live index, so it adjusts as
 * articles change.
 */
function keywordSearchSql(query: string, role: string) {
  return Prisma.sql`
    WITH words AS (
      SELECT DISTINCT lexeme FROM unnest(tsvector_to_array(to_tsvector('english', ${query}))) AS lexeme
    ),
    total AS (SELECT count(*)::float8 AS n FROM "HelpChunk"),
    weighted AS (
      SELECT to_tsquery('english', quote_literal(w.lexeme)) AS query,
             ln((total.n + 1) / (coalesce(s.ndoc, 0)::float8 + 0.5)) AS idf
      FROM words w
      CROSS JOIN total
      LEFT JOIN ts_stat('SELECT "searchVector" FROM "HelpChunk"') s ON s.word = w.lexeme
    )
    SELECT c."id", c."articleId", c."sectionTitle", c."content"
    FROM "HelpChunk" c
    JOIN weighted ON c."searchVector" @@ weighted.query
    WHERE ${role} = ANY(c."roles")
    GROUP BY c."id"
    ORDER BY sum(weighted.idf * ts_rank(c."searchVector", weighted.query)) DESC, c."id"
    LIMIT ${CANDIDATES_PER_METHOD}`;
}

/**
 * Best help sections for a question, for one viewer. Only sections of articles
 * their role may read are considered. Falls back to keyword-only search when
 * the embedding provider is unavailable, so search never goes down with it.
 */
export async function searchHelpIndex(input: {
  query: string;
  role: HelpRole;
  articles: HelpArticle[];
  route?: string | undefined;
  limit?: number | undefined;
}): Promise<HelpSearchHit[]> {
  const query = input.query.replace(/\s+/g, " ").trim().slice(0, MAX_QUERY_CHARS);
  if (query.length < 2) return [];

  const [keyword, embedding] = await Promise.all([
    prisma.$queryRaw<Row[]>(keywordSearchSql(query, input.role)),
    embedQuery(query),
  ]);

  const meaning = embedding
    ? await prisma.$queryRaw<Row[]>`
        SELECT "id", "articleId", "sectionTitle", "content"
        FROM "HelpChunk"
        WHERE "embedding" IS NOT NULL AND ${input.role} = ANY("roles")
          AND 1 - ("embedding" <=> ${vectorLiteral(embedding)}::vector) >= ${MIN_SIMILARITY}
        ORDER BY "embedding" <=> ${vectorLiteral(embedding)}::vector, "id"
        LIMIT ${CANDIDATES_PER_METHOD}`
    : [];

  return fuseRankings(keyword, meaning, articlesForRoute(input.articles, input.route)).slice(0, input.limit ?? 6);
}
