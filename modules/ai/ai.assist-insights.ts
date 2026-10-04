/**
 * AI Assistance answer log, feedback, and staff insights.
 *
 * Every answer is recorded for 90 days so the Trussen team can see what people
 * ask, what the assistant couldn't answer, and what was rated down: the to-do
 * list for the help articles (content/help).
 *
 * Privacy:
 *  - Questions are masked before they are stored (emails, phone numbers,
 *    links, secrets and ids).
 *  - workspaceId and userId are stored only so deleting a user or workspace
 *    deletes their rows, and so only the asker can rate an answer. Insights
 *    never select them.
 *  - Insights are for Trussen staff only (HELP_INSIGHTS_STAFF_EMAILS).
 *  - Rows are deleted after 90 days.
 */
import { env } from "../../config/env.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { prisma } from "../../shared/utils/prisma.js";
import { allHelpArticles, helpArticleById } from "../help/help.service.js";
import { logAiWarn } from "./ai.observability.js";

export const ANSWER_RETENTION_DAYS = 90;
const MAX_QUESTION_CHARS = 1_000;
const MAX_COMMENT_CHARS = 500;

export type AnswerKind = "instant" | "grounded" | "not_sure" | "unavailable";
export const RATING_REASONS = ["wrong", "unclear", "not_helpful", "other"] as const;
export type RatingReason = (typeof RATING_REASONS)[number];

/** Mask personal and secret-looking parts of free text before it is stored. */
export function maskQuestion(text: string): string {
  return text
    .replace(/https?:\/\/\S+|www\.\S+/gi, "[link]")
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/\b(?:lin|sk|pk|rk|ghp|gho|github_pat|xox[abpr])[_-][A-Za-z0-9_-]{8,}\b/g, "[secret]")
    .replace(/\buser_[A-Za-z0-9]{8,}\b/g, "[id]")
    // 9+ digits: phone and account numbers, but not dates like 2026-10-03.
    .replace(/\+?(?:\d[\s().-]{0,2}){8,}\d/g, "[number]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_QUESTION_CHARS);
}

/** Record one answer. Returns its id for feedback, or null if saving failed (never fails the answer). */
export async function recordAssistAnswer(input: {
  workspaceId: string;
  userId: string;
  question: string;
  kind: AnswerKind;
  articleIds: string[];
  route?: string | undefined;
  model?: string | undefined;
  latencyMs?: number | undefined;
}): Promise<string | null> {
  try {
    const row = await prisma.aiAssistAnswer.create({
      data: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        question: maskQuestion(input.question),
        kind: input.kind,
        articleIds: [...new Set(input.articleIds)].slice(0, 5),
        route: input.route ?? null,
        model: input.model ?? null,
        latencyMs: input.latencyMs ?? null,
      },
      select: { id: true },
    });
    return row.id;
  } catch (error) {
    logAiWarn("assist_answer_record_failed", {
      workspaceId: input.workspaceId,
      feature: "assist",
      success: false,
      errorMessage: error instanceof Error ? error.message : "Record failed",
    });
    return null;
  }
}

/** Thumbs up or down from the person who asked. Anyone else gets 404. Can be changed. */
export async function rateAssistAnswer(input: {
  answerId: string;
  workspaceId: string;
  userId: string;
  rating: "up" | "down";
  reason?: RatingReason | undefined;
  comment?: string | undefined;
}) {
  const down = input.rating === "down";
  const { count } = await prisma.aiAssistAnswer.updateMany({
    where: { id: input.answerId, workspaceId: input.workspaceId, userId: input.userId },
    data: {
      rating: input.rating,
      // A reason and comment only make sense with a thumbs down.
      ratingReason: down ? (input.reason ?? null) : null,
      ratingComment: down && input.comment?.trim() ? maskQuestion(input.comment).slice(0, MAX_COMMENT_CHARS) : null,
      ratedAt: new Date(),
    },
  });
  if (count === 0) throw new AppError(404, ERROR_CODES.NOT_FOUND, "Answer not found");
}

/** Hourly: drop answers past the retention window. */
export async function purgeOldAssistAnswers(): Promise<number> {
  const cutoff = new Date(Date.now() - ANSWER_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.aiAssistAnswer.deleteMany({ where: { createdAt: { lt: cutoff } } });
  return count;
}

export function isHelpInsightsStaff(email: string | null | undefined): boolean {
  return Boolean(email) && env.HELP_INSIGHTS_STAFF_EMAILS.includes(email!.trim().toLowerCase());
}

const articleRef = (id: string) => ({ id, title: helpArticleById(id)?.title ?? id });

/**
 * The staff report. Never selects workspaceId or userId: nothing in it can be
 * traced to a person or a customer.
 */
export async function getHelpInsights(days: number) {
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  const recent = { createdAt: { gte: since } };

  const [byKind, byRating, topQuestions, unanswered, disliked, articleUse] = await Promise.all([
    prisma.aiAssistAnswer.groupBy({ by: ["kind"], where: recent, _count: { _all: true } }),
    prisma.aiAssistAnswer.groupBy({ by: ["rating"], where: { ...recent, rating: { not: null } }, _count: { _all: true } }),
    // Group the same question asked in slightly different ways (case, punctuation, spacing).
    prisma.$queryRaw<Array<{ question: string; count: bigint; notSure: bigint }>>`
      SELECT min("question") AS "question", count(*) AS "count",
             count(*) FILTER (WHERE "kind" IN ('not_sure', 'unavailable')) AS "notSure"
      FROM "AiAssistAnswer"
      WHERE "createdAt" >= ${since}
      GROUP BY trim(regexp_replace(lower("question"), '[^a-z0-9]+', ' ', 'g'))
      ORDER BY count(*) DESC, min("question")
      LIMIT 25`,
    prisma.aiAssistAnswer.findMany({
      where: { ...recent, kind: { in: ["not_sure", "unavailable"] } },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { question: true, kind: true, articleIds: true, route: true, createdAt: true },
    }),
    prisma.aiAssistAnswer.findMany({
      where: { ...recent, rating: "down" },
      orderBy: { ratedAt: "desc" },
      take: 50,
      select: { question: true, kind: true, ratingReason: true, ratingComment: true, articleIds: true, createdAt: true },
    }),
    prisma.$queryRaw<Array<{ articleId: string; count: bigint }>>`
      SELECT unnest("articleIds") AS "articleId", count(*) AS "count"
      FROM "AiAssistAnswer"
      WHERE "createdAt" >= ${since} AND "kind" IN ('instant', 'grounded')
      GROUP BY 1
      ORDER BY 2 DESC`,
  ]);

  const kindCount = (kind: AnswerKind) => byKind.find((row) => row.kind === kind)?._count._all ?? 0;
  const ratingCount = (rating: string) => byRating.find((row) => row.rating === rating)?._count._all ?? 0;
  const answers = byKind.reduce((sum, row) => sum + row._count._all, 0);
  const up = ratingCount("up");
  const down = ratingCount("down");
  const used = new Set(articleUse.map((row) => row.articleId));

  return {
    period: { days, since: since.toISOString() },
    totals: {
      answers,
      instant: kindCount("instant"),
      grounded: kindCount("grounded"),
      notSure: kindCount("not_sure"),
      unavailable: kindCount("unavailable"),
      up,
      down,
      notSureRate: answers ? (kindCount("not_sure") + kindCount("unavailable")) / answers : 0,
      helpfulRate: up + down ? up / (up + down) : null,
    },
    topQuestions: topQuestions.map((row) => ({ question: row.question, count: Number(row.count), notSure: Number(row.notSure) })),
    unanswered: unanswered.map((row) => ({ ...row, articles: row.articleIds.map(articleRef), articleIds: undefined })),
    disliked: disliked.map((row) => ({ ...row, articles: row.articleIds.map(articleRef), articleIds: undefined })),
    articles: {
      used: articleUse.map((row) => ({ ...articleRef(row.articleId), count: Number(row.count) })),
      neverUsed: allHelpArticles()
        .filter((article) => !used.has(article.id))
        .map((article) => ({ id: article.id, title: article.title })),
    },
  };
}
