/**
 * Help articles: the single source of truth for what AI Assistance and the
 * in-app help pages say about Trussen.
 *
 * Articles live in `content/help/*.md` (shipped next to `dist/` in the image).
 * Each starts with a small front-matter block and may use `{{fact}}`
 * placeholders that are filled from the same constants the product code
 * enforces, so a documented limit can never drift from the real one.
 *
 * Loading is strict: one bad article (missing field, duplicate id, unknown
 * placeholder, unknown role or plan) throws, and the server refuses to start
 * rather than serve wrong help.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { env } from "../../config/env.js";
import {
  FREE_PLAN_ALLOWED_INTEGRATIONS,
  FREE_PLAN_MEMBER_CAP,
  FREE_PLAN_TEAM_CAP,
  getEntitlements,
} from "../billing/billing.service.js";
import { INVITE_EXPIRY_DAYS } from "../workspace/invitation.service.js";
import { DEACTIVATION_GRACE_DAYS, DELETION_REMINDER_DAYS_LEFT } from "../workspace/workspace-lifecycle.service.js";
import { DOCUMENT_MAX_BYTES } from "../upload/upload.service.js";
import { DRIVE_UPLOAD_MAX_BYTES } from "../drive/drive.limits.js";
import { MAX_MENTIONS_PER_COMMENT } from "../comment/comment.service.js";

export const HELP_ROLES = ["OWNER", "ADMIN", "MEMBER", "GUEST"] as const;
export const HELP_PLANS = ["FREE", "STANDARD", "PREMIUM"] as const;
export const HELP_CATEGORIES = [
  "Getting started",
  "Issues",
  "Planning",
  "People and access",
  "Workspace",
  "Integrations",
  "AI",
  "Billing",
] as const;

export type HelpRole = (typeof HELP_ROLES)[number];
export type HelpPlan = (typeof HELP_PLANS)[number];

export interface HelpArticle {
  id: string;
  title: string;
  category: (typeof HELP_CATEGORIES)[number];
  route: string | null;
  /** The main article for its page: what "which page am I on" and "Learn more" point to. */
  primary: boolean;
  roles: HelpRole[];
  plans: HelpPlan[];
  keywords: string[];
  /** First paragraph as plain text, for lists and search results. */
  summary: string;
  /** Markdown with every placeholder filled in. */
  body: string;
}

const MAX_ARTICLE_BYTES = 30_000;
const ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const listField = <T extends string>(allowed: readonly T[]) =>
  z
    .string()
    .transform((value) => value.split(",").map((item) => item.trim()).filter(Boolean))
    .pipe(z.array(z.enum(allowed as unknown as [T, ...T[]])).min(1));

const frontMatterSchema = z.object({
  id: z.string().regex(ID_PATTERN, "id must be lowercase words joined by dashes"),
  title: z.string().min(1).max(120),
  category: z.enum(HELP_CATEGORIES),
  // `/issues/:id` style params are allowed; the frontend only links routes without them.
  route: z.string().regex(/^\/[a-z0-9/:-]*$/, "route must be an app path like /issues or /issues/:id").optional(),
  primary: z.literal("true").optional(),
  roles: listField(HELP_ROLES),
  plans: listField(HELP_PLANS),
  keywords: z
    .string()
    .transform((value) => value.split(",").map((item) => item.trim().toLowerCase()).filter(Boolean))
    .pipe(z.array(z.string().max(60)).min(1)),
});

const megabytes = (bytes: number) => String(Math.round(bytes / (1024 * 1024)));
const gigabytes = (bytes: number | null) => (bytes === null ? "Unlimited" : `${Math.round(bytes / 1024 ** 3)} GB`);
const limitText = (value: number | undefined) => (value === undefined ? "No limit" : value.toLocaleString("en-US"));
const listText = (items: readonly string[]) =>
  items.map((item) => item.charAt(0) + item.slice(1).toLowerCase()).join(", ");

/**
 * Every value an article may reference. Prices are the only hand-kept facts:
 * they live in Stripe, not in our code (see docs/feature/billing/stripe-status.md #6).
 */
export function buildHelpFacts(): Record<string, string> {
  return {
    "free.memberCap": String(FREE_PLAN_MEMBER_CAP),
    "free.teamCap": String(FREE_PLAN_TEAM_CAP),
    "free.storage": gigabytes(getEntitlements("FREE").storageLimitBytes),
    "standard.storage": gigabytes(getEntitlements("STANDARD").storageLimitBytes),
    "free.integrations": listText(FREE_PLAN_ALLOWED_INTEGRATIONS),
    "price.standard": "$6",
    "price.premium": "$10",
    "invite.expiryDays": String(INVITE_EXPIRY_DAYS),
    "workspace.graceDays": String(DEACTIVATION_GRACE_DAYS),
    "workspace.reminderDays": [...DELETION_REMINDER_DAYS_LEFT].join(", "),
    "upload.imageMb": megabytes(env.UPLOAD_IMAGE_MAX_BYTES),
    "upload.videoMb": megabytes(env.UPLOAD_VIDEO_MAX_BYTES),
    "upload.documentMb": megabytes(DOCUMENT_MAX_BYTES),
    "drive.uploadMb": megabytes(DRIVE_UPLOAD_MAX_BYTES),
    "comment.maxMentions": String(MAX_MENTIONS_PER_COMMENT),
    "ai.freeDailyRequests": limitText(env.AI_FREE_DAILY_REQUEST_LIMIT),
    "ai.standardDailyRequests": limitText(env.AI_STANDARD_DAILY_REQUEST_LIMIT),
    "ai.premiumDailyRequests": limitText(env.AI_PREMIUM_DAILY_REQUEST_LIMIT),
  };
}

function splitFrontMatter(source: string, file: string): { meta: Record<string, string>; body: string } {
  const normalized = source.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(normalized);
  if (!match) throw new Error(`${file}: missing front matter (--- block at the top)`);

  const meta: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    if (!line.trim()) continue;
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`${file}: bad front matter line "${line}"`);
    const key = line.slice(0, colon).trim();
    if (key in meta) throw new Error(`${file}: duplicate front matter key "${key}"`);
    meta[key] = line.slice(colon + 1).trim();
  }
  return { meta, body: match[2]!.trim() };
}

function fillPlaceholders(body: string, facts: Record<string, string>, file: string): string {
  return body.replace(/\{\{\s*([a-zA-Z.]+)\s*\}\}/g, (_, key: string) => {
    const value = facts[key];
    if (value === undefined) throw new Error(`${file}: unknown placeholder {{${key}}}`);
    return value;
  });
}

function plainText(markdown: string): string {
  return markdown
    .replace(/\*\*|__|`/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The article's opening, as plain text. When the first paragraph introduces a
 * list ("The Inbox collects your notifications:"), the list is included so the
 * summary is a whole sentence.
 */
function summarize(body: string): string {
  const blocks = body.split(/\n\s*\n/).map((block) => block.trim()).filter(Boolean);
  const firstIndex = blocks.findIndex((block) => !block.startsWith("#"));
  if (firstIndex === -1) return "";
  let summary = plainText(blocks[firstIndex]!);

  const next = blocks[firstIndex + 1];
  if (summary.endsWith(":") && next && /^([-*]|\d+\.) /.test(next)) {
    const items = next
      .split("\n")
      .filter((line) => /^([-*]|\d+\.) /.test(line))
      .map((line) => plainText(line.replace(/^([-*]|\d+\.) /, "")).replace(/[.:]$/, ""));
    summary = `${summary} ${items.join(", ")}.`;
  }
  return summary.length > 280 ? `${summary.slice(0, 277).replace(/\s+\S*$/, "")}…` : summary;
}

export function parseHelpArticle(source: string, file: string, facts: Record<string, string>): HelpArticle {
  if (Buffer.byteLength(source) > MAX_ARTICLE_BYTES) throw new Error(`${file}: larger than ${MAX_ARTICLE_BYTES} bytes`);

  const { meta, body } = splitFrontMatter(source, file);
  const parsed = frontMatterSchema.safeParse(meta);
  if (!parsed.success) {
    throw new Error(`${file}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  }
  if (`${parsed.data.id}.md` !== path.basename(file)) throw new Error(`${file}: id "${parsed.data.id}" must match the file name`);
  if (!body) throw new Error(`${file}: empty article`);
  if (parsed.data.primary && !parsed.data.route) throw new Error(`${file}: primary needs a route`);

  const filled = fillPlaceholders(body, facts, file);
  return {
    id: parsed.data.id,
    title: parsed.data.title,
    category: parsed.data.category,
    route: parsed.data.route ?? null,
    primary: parsed.data.primary === "true",
    roles: [...new Set(parsed.data.roles)],
    plans: [...new Set(parsed.data.plans)],
    keywords: parsed.data.keywords,
    summary: summarize(filled),
    body: filled,
  };
}

export const HELP_CONTENT_DIR = path.join(process.cwd(), "content", "help");

export function loadHelpArticles(dir = HELP_CONTENT_DIR): HelpArticle[] {
  const facts = buildHelpFacts();
  const files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort();
  if (files.length === 0) throw new Error(`No help articles found in ${dir}`);

  const articles = files.map((file) => parseHelpArticle(readFileSync(path.join(dir, file), "utf8"), file, facts));
  const seen = new Set<string>();
  for (const article of articles) {
    if (seen.has(article.id)) throw new Error(`Duplicate help article id "${article.id}"`);
    seen.add(article.id);
  }

  // Every page with articles has exactly one main article.
  const routes = new Set(articles.flatMap((article) => (article.route ? [article.route] : [])));
  for (const route of routes) {
    const primaries = articles.filter((article) => article.route === route && article.primary).map((article) => article.id);
    if (primaries.length !== 1) {
      throw new Error(`Page ${route} needs exactly one article with "primary: true", found ${primaries.length ? primaries.join(", ") : "none"}`);
    }
  }
  return articles;
}
