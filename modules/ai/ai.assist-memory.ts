/**
 * AI Assistance memory: the last 24 hours of one person's help chat in one
 * workspace, kept server side so follow-up questions work ("and how do I
 * change it?") and the chat follows them across devices.
 *
 * Bounded on every axis: 24-hour lifetime, at most MAX_STORED messages per
 * person, and only the last MODEL_HISTORY_MESSAGES (within MODEL_HISTORY_CHARS)
 * are ever sent to the model. Saving is best effort: a failed save never fails
 * the answer the person is waiting for.
 */
import type { Prisma } from "../../app/generated/prisma/client.js";
import { prisma } from "../../shared/utils/prisma.js";
import { logAiWarn } from "./ai.observability.js";

export const ASSIST_HISTORY_TTL_MS = 24 * 60 * 60 * 1000;
/** Six questions and their answers. */
export const MODEL_HISTORY_MESSAGES = 12;
export const MODEL_HISTORY_CHARS = 6_000;
const MAX_STORED = 100;
const SHOWN_IN_BUBBLE = 50;
const MAX_STORED_CHARS = 8_000;

export type AssistHistoryMessage = { role: "user" | "assistant"; content: string };

const since = (now = Date.now()) => new Date(now - ASSIST_HISTORY_TTL_MS);

/** What the bubble shows: oldest first, assistant replies with their full structure. */
export async function getAssistHistory(workspaceId: string, userId: string) {
  const rows = await prisma.aiAssistMessage.findMany({
    where: { workspaceId, userId, createdAt: { gt: since() } },
    orderBy: { seq: "desc" },
    take: SHOWN_IN_BUBBLE,
    select: { role: true, content: true, payload: true, createdAt: true },
  });
  return rows.reverse().map((row) => ({
    role: row.role === "assistant" ? ("assistant" as const) : ("user" as const),
    content: row.role === "assistant" ? (row.payload ?? { answer: row.content }) : row.content,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * The recent conversation for the model: newest messages that fit the budget,
 * returned oldest first, always starting with a question so the model never
 * sees an answer without the question it answered.
 */
export function trimForModel(messages: AssistHistoryMessage[]): AssistHistoryMessage[] {
  const kept: AssistHistoryMessage[] = [];
  let chars = 0;
  for (const message of [...messages].reverse()) {
    if (kept.length >= MODEL_HISTORY_MESSAGES || chars + message.content.length > MODEL_HISTORY_CHARS) break;
    kept.unshift(message);
    chars += message.content.length;
  }
  while (kept[0]?.role === "assistant") kept.shift();
  return kept;
}

export async function getModelHistory(workspaceId: string, userId: string): Promise<AssistHistoryMessage[]> {
  try {
    const rows = await prisma.aiAssistMessage.findMany({
      where: { workspaceId, userId, createdAt: { gt: since() } },
      orderBy: { seq: "desc" },
      take: MODEL_HISTORY_MESSAGES,
      select: { role: true, content: true },
    });
    return trimForModel(
      rows.reverse().map((row) => ({ role: row.role === "assistant" ? "assistant" : "user", content: row.content })),
    );
  } catch (error) {
    // No memory is better than no answer.
    logAiWarn("assist_history_read_failed", {
      workspaceId,
      userId,
      feature: "assist",
      success: false,
      errorMessage: error instanceof Error ? error.message : "History read failed",
    });
    return [];
  }
}

/** Save one question and its answer, then drop anything expired or over the cap for this person. */
export async function saveAssistTurn(input: {
  workspaceId: string;
  userId: string;
  question: string;
  answer: string;
  payload: Prisma.InputJsonValue;
}) {
  try {
    const now = Date.now();
    // One insert, in this order, so `seq` puts the question right before its answer.
    await prisma.aiAssistMessage.createMany({
      data: [
        { workspaceId: input.workspaceId, userId: input.userId, role: "user", content: input.question.slice(0, MAX_STORED_CHARS) },
        { workspaceId: input.workspaceId, userId: input.userId, role: "assistant", content: input.answer.slice(0, MAX_STORED_CHARS), payload: input.payload },
      ],
    });

    const overflow = await prisma.aiAssistMessage.findMany({
      where: { workspaceId: input.workspaceId, userId: input.userId },
      orderBy: { seq: "desc" },
      skip: MAX_STORED,
      select: { id: true },
    });
    await prisma.aiAssistMessage.deleteMany({
      where: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        OR: [{ createdAt: { lte: since(now) } }, { id: { in: overflow.map((row) => row.id) } }],
      },
    });
  } catch (error) {
    logAiWarn("assist_history_save_failed", {
      workspaceId: input.workspaceId,
      userId: input.userId,
      feature: "assist",
      success: false,
      errorMessage: error instanceof Error ? error.message : "History save failed",
    });
  }
}

export async function clearAssistHistory(workspaceId: string, userId: string) {
  await prisma.aiAssistMessage.deleteMany({ where: { workspaceId, userId } });
}

/** Hourly: remove everyone's expired messages, including people who never came back. */
export async function purgeExpiredAssistMessages(): Promise<number> {
  const { count } = await prisma.aiAssistMessage.deleteMany({ where: { createdAt: { lte: since() } } });
  return count;
}
