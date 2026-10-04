/**
 * Serves help articles to the app and (next) to AI Assistance.
 *
 * Articles are loaded once per process (they only change on deploy) and
 * checked at startup by `initHelpArticles()`, so a broken article fails the
 * deploy instead of a user's request.
 *
 * Visibility: an article is shown only to the roles it lists, so a member is
 * never told how to use billing or settings they can't open. Plans are NOT a
 * filter: Free users should be able to read what Premium adds. Each summary
 * says whether it is on the viewer's plan instead.
 */
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { HELP_CATEGORIES, loadHelpArticles, type HelpArticle, type HelpPlan, type HelpRole } from "./help.content.js";
import { searchHelpIndex, syncHelpIndex, type HelpIndexSyncResult, type HelpSearchHit } from "./help.index.js";

export interface HelpViewer {
  role: HelpRole;
  plan: HelpPlan;
}

let cache: { list: HelpArticle[]; byId: Map<string, HelpArticle> } | null = null;

function articles() {
  if (!cache) {
    const list = loadHelpArticles();
    cache = { list, byId: new Map(list.map((article) => [article.id, article])) };
  }
  return cache;
}

/** Load and validate every article now. Called at startup so a bad article stops the deploy. */
export function initHelpArticles(): number {
  return articles().list.length;
}

/** Test hook: forget the loaded articles. */
export function resetHelpArticlesForTests() {
  cache = null;
}

const visibleTo = (article: HelpArticle, viewer: HelpViewer) => article.roles.includes(viewer.role);

function toSummary(article: HelpArticle, viewer: HelpViewer) {
  return {
    id: article.id,
    title: article.title,
    category: article.category,
    route: article.route,
    plans: article.plans,
    onYourPlan: article.plans.includes(viewer.plan),
    keywords: article.keywords,
    summary: article.summary,
  };
}

export function listHelpArticles(viewer: HelpViewer) {
  const order = new Map<string, number>(HELP_CATEGORIES.map((category, index) => [category, index]));
  const visible = articles()
    .list.filter((article) => visibleTo(article, viewer))
    .sort((a, b) => order.get(a.category)! - order.get(b.category)! || a.title.localeCompare(b.title));

  return {
    categories: HELP_CATEGORIES.filter((category) => visible.some((article) => article.category === category)),
    articles: visible.map((article) => toSummary(article, viewer)),
  };
}

export function getHelpArticle(id: string, viewer: HelpViewer) {
  const article = articles().byId.get(id);
  // Same 404 whether it doesn't exist or isn't for this role, so ids don't leak what other roles can do.
  if (!article || !visibleTo(article, viewer)) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND, "Help article not found");
  }
  return { ...toSummary(article, viewer), body: article.body };
}

/** All articles a viewer may see, with full text. For AI Assistance (step 2 onward). */
export function helpArticlesFor(viewer: HelpViewer): HelpArticle[] {
  return articles().list.filter((article) => visibleTo(article, viewer));
}

/** Rebuild the search index from the loaded articles. Safe to run on every start. */
export function syncHelpSearchIndex(): Promise<HelpIndexSyncResult> {
  return syncHelpIndex(articles().list);
}

/**
 * Best sections for a question, for this viewer (role-filtered), with the
 * current page's article ranked higher. Used by AI Assistance.
 */
export function searchHelpSections(query: string, viewer: HelpViewer, route?: string, limit?: number): Promise<HelpSearchHit[]> {
  return searchHelpIndex({ query, role: viewer.role, articles: articles().list, route, limit });
}

/** Help page search: one result per article, best section first. */
export async function searchHelpArticles(query: string, viewer: HelpViewer, route?: string) {
  const hits = await searchHelpSections(query, viewer, route, 20);
  const seen = new Set<string>();
  const results = [];
  for (const hit of hits) {
    const article = articles().byId.get(hit.articleId);
    // Re-check visibility in memory too: the index could lag the deployed articles.
    if (!article || !visibleTo(article, viewer) || seen.has(article.id)) continue;
    seen.add(article.id);
    results.push({
      ...toSummary(article, viewer),
      section: hit.sectionTitle === "Overview" ? null : hit.sectionTitle,
      snippet: hit.text.replace(/[#*`|>_]/g, "").replace(/\s+/g, " ").trim().slice(0, 220),
    });
    if (results.length === 8) break;
  }
  return results;
}

const routePattern = (articleRoute: string) => new RegExp(`^${articleRoute.replace(/:[a-zA-Z]+/g, "[^/]+")}$`);

/**
 * The article about the page someone is on: its main article if they may read
 * it, otherwise another article about that page they may read, otherwise null.
 */
export function helpPageArticle(route: string | undefined, viewer: HelpViewer): HelpArticle | null {
  if (!route) return null;
  const path = route.split(/[?#]/)[0]!;
  // An exact page beats a pattern: /issues/my is My issues, not an issue called "my".
  const exact = articles().list.filter((article) => article.route === path && visibleTo(article, viewer));
  const onPage = exact.length
    ? exact
    : articles().list.filter((article) => article.route && routePattern(article.route).test(path) && visibleTo(article, viewer));
  return onPage.find((article) => article.primary) ?? onPage[0] ?? null;
}

export function helpArticleById(id: string): HelpArticle | null {
  return articles().byId.get(id) ?? null;
}

/**
 * One role's row from the "Roles and permissions" article, so the instant
 * "what is my role" answer says exactly what the article says.
 */
export function roleSummaryFromArticle(role: HelpRole): string | null {
  const article = articles().byId.get("roles-and-permissions");
  const name = role.charAt(0) + role.slice(1).toLowerCase();
  const row = article?.body.split("\n").find((line) => line.startsWith(`| **${name}** |`));
  return row ? row.split("|")[2]!.trim() : null;
}

/** Every loaded article, whatever the role. For staff tools only, never for members. */
export function allHelpArticles(): HelpArticle[] {
  return articles().list;
}
