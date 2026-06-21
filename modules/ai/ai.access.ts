import type { SubscriptionPlan, SubscriptionStatus } from "../../app/generated/prisma/client.js";
import { env } from "../../config/env.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { AppError } from "../../shared/utils/api-error.js";
import { prisma } from "../../shared/utils/prisma.js";

export type AiFeature = "chat" | "issue_generation";

type LimitConfig = {
  requestLimit: number | null;
  tokenLimit: number | null;
};

export interface AiAccessState {
  subscriptionPlan: SubscriptionPlan;
  subscriptionStatus: SubscriptionStatus | "NONE";
  accessPlan: SubscriptionPlan;
  enforcementMode: "monitor" | "enforced";
  planAllowsAi: boolean;
  effectiveAccess: boolean;
  limits: LimitConfig;
  today: {
    workspaceRequestCount: number;
    workspaceTotalTokens: number;
    userRequestCount: number;
    userTotalTokens: number;
  };
}

export interface AiWorkspacePolicy {
  subscriptionPlan: SubscriptionPlan;
  subscriptionStatus: SubscriptionStatus | "NONE";
  accessPlan: SubscriptionPlan;
  enforcementMode: "monitor" | "enforced";
  planAllowsAi: boolean;
  effectiveAccess: boolean;
  limits: LimitConfig;
  today: {
    workspaceRequestCount: number;
    workspaceTotalTokens: number;
  };
}

const ACTIVE_SUBSCRIPTION_STATUSES: SubscriptionStatus[] = ["ACTIVE", "TRIALING", "PAST_DUE"];

function resolveAccessPlan(plan: SubscriptionPlan, status: SubscriptionStatus | "NONE"): SubscriptionPlan {
  return status !== "NONE" && ACTIVE_SUBSCRIPTION_STATUSES.includes(status) ? plan : "FREE";
}

function limitConfigForPlan(plan: SubscriptionPlan): LimitConfig {
  switch (plan) {
    case "FREE":
      return {
        requestLimit: env.AI_FREE_DAILY_REQUEST_LIMIT ?? null,
        tokenLimit: env.AI_FREE_DAILY_TOKEN_LIMIT ?? null,
      };
    case "STANDARD":
      return {
        requestLimit: env.AI_STANDARD_DAILY_REQUEST_LIMIT ?? null,
        tokenLimit: env.AI_STANDARD_DAILY_TOKEN_LIMIT ?? null,
      };
    case "PREMIUM":
      return {
        requestLimit: env.AI_PREMIUM_DAILY_REQUEST_LIMIT ?? null,
        tokenLimit: env.AI_PREMIUM_DAILY_TOKEN_LIMIT ?? null,
      };
  }
}

function usageDate(date = new Date()) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

export async function getAiWorkspacePolicy(workspaceId: string): Promise<AiWorkspacePolicy> {
  const today = usageDate();

  const [subscription, workspaceDaily] = await Promise.all([
    prisma.subscription.findUnique({
      where: { workspaceId },
      select: { plan: true, status: true },
    }),
    prisma.aiWorkspaceUsageDaily.findUnique({
      where: {
        workspaceId_date: {
          workspaceId,
          date: today,
        },
      },
      select: {
        requestCount: true,
        totalTokens: true,
      },
    }),
  ]);

  const subscriptionPlan = subscription?.plan ?? "FREE";
  const subscriptionStatus = subscription?.status ?? "NONE";
  const accessPlan = resolveAccessPlan(subscriptionPlan, subscriptionStatus);
  const enforcementMode = env.AI_ENFORCE_BILLING ? "enforced" : "monitor";
  const planAllowsAi = accessPlan === "PREMIUM";
  const limits = limitConfigForPlan(accessPlan);

  return {
    subscriptionPlan,
    subscriptionStatus,
    accessPlan,
    enforcementMode,
    planAllowsAi,
    effectiveAccess: enforcementMode === "monitor" ? true : planAllowsAi,
    limits,
    today: {
      workspaceRequestCount: workspaceDaily?.requestCount ?? 0,
      workspaceTotalTokens: workspaceDaily?.totalTokens ?? 0,
    },
  };
}

export async function getAiAccessState(workspaceId: string, userId: string): Promise<AiAccessState> {
  const today = usageDate();

  const [workspacePolicy, userDaily] = await Promise.all([
    getAiWorkspacePolicy(workspaceId),
    prisma.aiUserUsageDaily.findUnique({
      where: {
        workspaceId_userId_date: {
          workspaceId,
          userId,
          date: today,
        },
      },
      select: {
        requestCount: true,
        totalTokens: true,
      },
    }),
  ]);

  return {
    ...workspacePolicy,
    today: {
      ...workspacePolicy.today,
      userRequestCount: userDaily?.requestCount ?? 0,
      userTotalTokens: userDaily?.totalTokens ?? 0,
    },
  };
}

export async function assertAiAccess(input: {
  workspaceId: string;
  userId: string;
  feature: AiFeature;
  estimatedTokens?: number;
}): Promise<AiAccessState> {
  const access = await getAiAccessState(input.workspaceId, input.userId);

  if (access.enforcementMode === "monitor") {
    return access;
  }

  if (!access.planAllowsAi) {
    throw new AppError(
      403,
      ERROR_CODES.AI_PLAN_UPGRADE_REQUIRED,
      "AI is currently available on the Premium plan. Upgrade the workspace plan to continue.",
      { feature: input.feature, accessPlan: access.accessPlan },
    );
  }

  const estimatedTokens = Math.max(0, input.estimatedTokens ?? 0);

  if (
    access.limits.requestLimit !== null &&
    access.today.workspaceRequestCount + 1 > access.limits.requestLimit
  ) {
    throw new AppError(
      429,
      ERROR_CODES.AI_BUDGET_EXCEEDED,
      "The workspace's daily AI request limit has been reached for your plan.",
      { feature: input.feature, limitType: "request", requestLimit: access.limits.requestLimit },
    );
  }

  if (
    access.limits.tokenLimit !== null &&
    access.today.workspaceTotalTokens + estimatedTokens > access.limits.tokenLimit
  ) {
    throw new AppError(
      429,
      ERROR_CODES.AI_BUDGET_EXCEEDED,
      "The workspace's daily AI token limit has been reached for your plan.",
      { feature: input.feature, limitType: "token", tokenLimit: access.limits.tokenLimit },
    );
  }

  return access;
}
