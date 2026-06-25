import { Prisma } from "../../app/generated/prisma/client.js";
import { prisma } from "../../shared/utils/prisma.js";
import { getAiWorkspacePolicy } from "./ai.access.js";
import type { AiUsageQuery } from "./ai.schemas.js";

type UsageDbClient = typeof prisma | Prisma.TransactionClient;
type AiUsageFeature = "chat" | "issue_generation";

interface RecordAiDailyUsageInput {
  workspaceId: string;
  userId?: string | undefined;
  feature: AiUsageFeature;
  inputTokens: number;
  outputTokens: number;
  requestCountIncrement?: number | undefined;
  issueGenerationCountIncrement?: number | undefined;
  chatTurnCountIncrement?: number | undefined;
  occurredAt?: Date | undefined;
}

function toUsageDate(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function resolveUsageRange(query: AiUsageQuery) {
  const today = new Date();
  const end = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  let from = new Date(end);
  let to = new Date(end);

  if (query.period === "custom") {
    from = new Date(`${query.from!}T00:00:00.000Z`);
    to = new Date(`${query.to!}T00:00:00.000Z`);
  } else {
    const days = query.period === "7d" ? 7 : query.period === "30d" ? 30 : 90;
    from.setUTCDate(from.getUTCDate() - (days - 1));
  }

  return { from, to };
}

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function emptyTotals() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requestCount: 0,
    issueGenerationCount: 0,
    chatTurnCount: 0,
  };
}

export async function recordAiDailyUsage(db: UsageDbClient, input: RecordAiDailyUsageInput): Promise<void> {
  const occurredAt = input.occurredAt ?? new Date();
  const usageDate = toUsageDate(occurredAt);
  const totalTokens = input.inputTokens + input.outputTokens;
  const requestCount = input.requestCountIncrement ?? 1;
  const issueGenerationCount = input.issueGenerationCountIncrement ?? (input.feature === "issue_generation" ? 1 : 0);
  const chatTurnCount = input.chatTurnCountIncrement ?? (input.feature === "chat" ? 1 : 0);

  await db.aiWorkspaceUsageDaily.upsert({
    where: {
      workspaceId_date: {
        workspaceId: input.workspaceId,
        date: usageDate,
      },
    },
    create: {
      workspaceId: input.workspaceId,
      date: usageDate,
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens,
      requestCount,
      issueGenerationCount,
      chatTurnCount,
    },
    update: {
      inputTokens: { increment: input.inputTokens },
      outputTokens: { increment: input.outputTokens },
      totalTokens: { increment: totalTokens },
      requestCount: { increment: requestCount },
      issueGenerationCount: { increment: issueGenerationCount },
      chatTurnCount: { increment: chatTurnCount },
    },
  });

  if (input.userId) {
    await db.aiUserUsageDaily.upsert({
      where: {
        workspaceId_userId_date: {
          workspaceId: input.workspaceId,
          userId: input.userId,
          date: usageDate,
        },
      },
      create: {
        workspaceId: input.workspaceId,
        userId: input.userId,
        date: usageDate,
        inputTokens: input.inputTokens,
        outputTokens: input.outputTokens,
        totalTokens,
        requestCount,
        issueGenerationCount,
        chatTurnCount,
      },
      update: {
        inputTokens: { increment: input.inputTokens },
        outputTokens: { increment: input.outputTokens },
        totalTokens: { increment: totalTokens },
        requestCount: { increment: requestCount },
        issueGenerationCount: { increment: issueGenerationCount },
        chatTurnCount: { increment: chatTurnCount },
      },
    });
  }
}

export async function getWorkspaceUsage(workspaceId: string, query: AiUsageQuery) {
  const range = resolveUsageRange(query);
  const [dailyRows, userRows, policy] = await Promise.all([
    prisma.aiWorkspaceUsageDaily.findMany({
      where: {
        workspaceId,
        date: {
          gte: range.from,
          lte: range.to,
        },
      },
      orderBy: { date: "asc" },
    }),
    prisma.aiUserUsageDaily.findMany({
      where: {
        workspaceId,
        date: {
          gte: range.from,
          lte: range.to,
        },
      },
      select: {
        userId: true,
        inputTokens: true,
        outputTokens: true,
        totalTokens: true,
        requestCount: true,
        issueGenerationCount: true,
        chatTurnCount: true,
      },
    }),
    getAiWorkspacePolicy(workspaceId),
  ]);

  const totals = dailyRows.reduce((acc, row) => ({
    inputTokens: acc.inputTokens + row.inputTokens,
    outputTokens: acc.outputTokens + row.outputTokens,
    totalTokens: acc.totalTokens + row.totalTokens,
    requestCount: acc.requestCount + row.requestCount,
    issueGenerationCount: acc.issueGenerationCount + row.issueGenerationCount,
    chatTurnCount: acc.chatTurnCount + row.chatTurnCount,
  }), emptyTotals());

  const uniqueActiveUsers = new Set(userRows.map((row) => row.userId)).size;

  const perUserMap = new Map<string, ReturnType<typeof emptyTotals>>();
  for (const row of userRows) {
    const current = perUserMap.get(row.userId) ?? emptyTotals();
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.totalTokens += row.totalTokens;
    current.requestCount += row.requestCount;
    current.issueGenerationCount += row.issueGenerationCount;
    current.chatTurnCount += row.chatTurnCount;
    perUserMap.set(row.userId, current);
  }

  const topUserIds = [...perUserMap.entries()]
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
    .slice(0, Math.min(query.limit, 10))
    .map(([userId]) => userId);

  const memberships = topUserIds.length > 0
    ? await prisma.workspaceMembership.findMany({
        where: { workspaceId, userId: { in: topUserIds } },
        select: {
          userId: true,
          role: true,
          user: { select: { name: true, email: true, avatar: true } },
        },
      })
    : [];

  const membershipMap = new Map(memberships.map((membership) => [membership.userId, membership]));

  return {
    range: { from: formatDate(range.from), to: formatDate(range.to), period: query.period },
    policy,
    totals: {
      ...totals,
      activeUsers: uniqueActiveUsers,
    },
    daily: dailyRows.map((row) => ({
      date: formatDate(row.date),
      inputTokens: row.inputTokens,
      outputTokens: row.outputTokens,
      totalTokens: row.totalTokens,
      requestCount: row.requestCount,
      issueGenerationCount: row.issueGenerationCount,
      chatTurnCount: row.chatTurnCount,
    })),
    topUsers: topUserIds.map((userId) => {
      const totalsForUser = perUserMap.get(userId) ?? emptyTotals();
      const membership = membershipMap.get(userId);
      return {
        userId,
        name: membership?.user.name ?? "Unknown",
        email: membership?.user.email ?? "",
        avatar: membership?.user.avatar ?? null,
        role: membership?.role ?? "MEMBER",
        ...totalsForUser,
      };
    }),
  };
}

export async function getUserUsage(workspaceId: string, query: AiUsageQuery) {
  const range = resolveUsageRange(query);
  const rows = await prisma.aiUserUsageDaily.findMany({
    where: {
      workspaceId,
      date: {
        gte: range.from,
        lte: range.to,
      },
    },
    select: {
      userId: true,
      date: true,
      inputTokens: true,
      outputTokens: true,
      totalTokens: true,
      requestCount: true,
      issueGenerationCount: true,
      chatTurnCount: true,
    },
  });

  const byUser = new Map<string, ReturnType<typeof emptyTotals>>();
  for (const row of rows) {
    const current = byUser.get(row.userId) ?? emptyTotals();
    current.inputTokens += row.inputTokens;
    current.outputTokens += row.outputTokens;
    current.totalTokens += row.totalTokens;
    current.requestCount += row.requestCount;
    current.issueGenerationCount += row.issueGenerationCount;
    current.chatTurnCount += row.chatTurnCount;
    byUser.set(row.userId, current);
  }

  const sortedUserIds = [...byUser.entries()]
    .sort((a, b) => b[1].totalTokens - a[1].totalTokens)
    .slice(0, query.limit)
    .map(([userId]) => userId);

  const memberships = sortedUserIds.length > 0
    ? await prisma.workspaceMembership.findMany({
        where: { workspaceId, userId: { in: sortedUserIds } },
        select: {
          userId: true,
          role: true,
          user: { select: { name: true, email: true, avatar: true } },
        },
      })
    : [];

  const membershipMap = new Map(memberships.map((membership) => [membership.userId, membership]));

  return {
    range: { from: formatDate(range.from), to: formatDate(range.to), period: query.period },
    users: sortedUserIds.map((userId) => {
      const totals = byUser.get(userId) ?? emptyTotals();
      const membership = membershipMap.get(userId);
      return {
        userId,
        name: membership?.user.name ?? "Unknown",
        email: membership?.user.email ?? "",
        avatar: membership?.user.avatar ?? null,
        role: membership?.role ?? "MEMBER",
        ...totals,
      };
    }),
  };
}
