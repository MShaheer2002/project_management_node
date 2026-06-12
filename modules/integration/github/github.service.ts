/**
 * GitHub Integration — Service Layer
 *
 * Business logic for GitHub OAuth, webhook registration, and event processing.
 * Ported from the monolithic integration.service.ts to the per-provider module structure.
 *
 * Database schema:
 *   - Integration.accessToken  — GitHub OAuth token
 *   - Integration.providerMeta — { githubUser, repos, scope }
 *   - IntegrationSetting rows  — boolean toggles (key/value)
 */

import { prisma } from "../../../shared/utils/prisma.js";
import { AppError } from "../../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../../shared/errors/error-codes.js";
import { logActivity } from "../../../shared/utils/activity.js";
import { env } from "../../../config/env.js";
import { extractIssueRefs } from "./github.utils.js";
import { createNotification } from "../../notification/notification.service.js";
import {
  findConnectedIntegration,
  getSettings,
  initDefaultSettings,
} from "../integration.service.js";

// ─── Default GitHub Settings ─────────────────────────────────────────────────

export const DEFAULT_GITHUB_SETTINGS: Record<string, boolean> = {
  autoCompleteOnMerge: true,
  autoMoveToReviewOnPr: true,
  notifyOnPrOpen: true,
  notifyOnPrReview: true,
  notifyOnPrMerge: true,
  showCommits: true,
  showBranches: true,
};

// ─── OAuth ──────────────────────────────────────────────────────────────────

/**
 * Start GitHub OAuth flow — returns the authorization URL.
 */
export function getGitHubAuthUrl(workspaceId: string, userId: string): string {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new AppError(500, ERROR_CODES.GITHUB_NOT_CONFIGURED, "GitHub integration is not configured on this server");
  }

  // State encodes workspace + user for the callback to resolve
  const state = Buffer.from(JSON.stringify({ workspaceId, userId })).toString("base64url");

  const params = new URLSearchParams({
    client_id: env.GITHUB_CLIENT_ID,
    redirect_uri: `${env.BACKEND_URL ?? `http://localhost:${env.PORT}`}/integrations/github/callback`,
    scope: "repo admin:repo_hook",
    state,
  });

  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/**
 * Handle GitHub OAuth callback — exchange code for access token, store integration.
 */
export async function handleGitHubCallback(code: string, state: string) {
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) {
    throw new AppError(500, ERROR_CODES.GITHUB_NOT_CONFIGURED, "GitHub integration is not configured");
  }

  // Decode state
  let stateData: { workspaceId: string; userId: string };
  try {
    stateData = JSON.parse(Buffer.from(state, "base64url").toString());
  } catch {
    throw new AppError(400, ERROR_CODES.GITHUB_OAUTH_FAILED, "Invalid OAuth state parameter");
  }

  const { workspaceId, userId } = stateData;

  // Exchange code for access token
  const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({
      client_id: env.GITHUB_CLIENT_ID,
      client_secret: env.GITHUB_CLIENT_SECRET,
      code,
    }),
  });

  const tokenData = (await tokenResponse.json()) as {
    access_token?: string;
    token_type?: string;
    scope?: string;
    error?: string;
    error_description?: string;
  };

  if (tokenData.error || !tokenData.access_token) {
    throw new AppError(
      400,
      ERROR_CODES.GITHUB_OAUTH_FAILED,
      tokenData.error_description || "Failed to exchange GitHub authorization code",
    );
  }

  // Fetch GitHub user info to store with the integration
  const githubUserResponse = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  const githubUser = (await githubUserResponse.json()) as {
    login: string;
    id: number;
    avatar_url: string;
  };

  // Fetch user's repos — only repos owned by the authenticated user or where they have push access
  const reposResponse = await fetch("https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member", {
    headers: {
      Authorization: `Bearer ${tokenData.access_token}`,
      Accept: "application/vnd.github.v3+json",
    },
  });

  const repos = (await reposResponse.json()) as Array<{
    full_name: string;
    name: string;
    owner: { login: string };
    permissions?: { admin?: boolean; push?: boolean };
  }>;

  console.log(`[GitHub] Found ${repos.length} repos for ${githubUser.login}:`, repos.map((r) => r.full_name));

  // Register webhooks on all repos the user owns or has admin access to
  const webhookUrl = `${env.BACKEND_URL ?? `http://localhost:${env.PORT}`}/webhooks/github`;
  const webhookSecret = env.GITHUB_WEBHOOK_SECRET ?? "";
  const registeredRepos: string[] = [];

  for (const repo of repos) {
    try {
      const createWebhookResponse = await fetch(
        `https://api.github.com/repos/${repo.full_name}/hooks`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${tokenData.access_token}`,
            Accept: "application/vnd.github.v3+json",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            name: "web",
            active: true,
            events: ["push", "pull_request", "pull_request_review"],
            config: {
              url: webhookUrl,
              content_type: "json",
              secret: webhookSecret,
              insecure_ssl: "0",
            },
          }),
        },
      );

      if (createWebhookResponse.ok) {
        registeredRepos.push(repo.full_name);
      } else {
        const errorBody = (await createWebhookResponse.json()) as { errors?: Array<{ message: string }> };
        // 422 with "Hook already exists" is fine — webhook was already registered
        const alreadyExists = errorBody.errors?.some((e) => e.message?.includes("already exists"));
        if (alreadyExists) {
          registeredRepos.push(repo.full_name);
        } else {
          console.warn(`[GitHub] Failed to register webhook on ${repo.full_name}:`, errorBody);
        }
      }
    } catch (err) {
      console.warn(`[GitHub] Error registering webhook on ${repo.full_name}:`, err);
    }
  }

  console.log(`[GitHub] Registered webhooks on ${registeredRepos.length} repos:`, registeredRepos);

  // Upsert integration record — new schema uses separate fields instead of config JSON
  const providerMeta = {
    githubUser: {
      login: githubUser.login,
      id: githubUser.id,
      avatarUrl: githubUser.avatar_url,
    },
    repos: registeredRepos,
    scope: tokenData.scope,
  };

  const integration = await prisma.integration.upsert({
    where: {
      workspaceId_provider: {
        workspaceId,
        provider: "GITHUB",
      },
    },
    create: {
      workspaceId,
      provider: "GITHUB",
      connected: true,
      accessToken: tokenData.access_token,
      providerMeta,
      connectedAt: new Date(),
      connectedById: userId,
    },
    update: {
      connected: true,
      accessToken: tokenData.access_token,
      providerMeta,
      connectedAt: new Date(),
      connectedById: userId,
    },
  });

  // Initialize default settings if they don't already exist
  await initDefaultSettings(integration.id, DEFAULT_GITHUB_SETTINGS);

  await logActivity({
    workspaceId,
    actorId: userId,
    type: "INTEGRATION_CONNECTED",
    targetType: "INTEGRATION",
    targetId: "GITHUB",
    message: `GitHub integration connected by ${githubUser.login} (${registeredRepos.length} repos)`,
    metadata: { provider: "github", githubLogin: githubUser.login, repos: registeredRepos },
  });

  return { workspaceId, provider: "github", githubLogin: githubUser.login, repos: registeredRepos };
}

// ─── GitHub Webhook Event Processing ─────────────────────────────────────────

/**
 * Process a GitHub push event.
 * Extracts issue references from commit messages and branch names, links them to issues.
 */
export async function handleGitHubPush(workspaceId: string, payload: any) {
  const integration = await findConnectedIntegration(workspaceId, "GITHUB");
  if (!integration) return;

  const settings = await getSettings(integration.id);
  const actorId = integration.connectedById;
  if (!actorId) return;

  const repoFullName = payload.repository?.full_name ?? "unknown/repo";
  const branch = (payload.ref ?? "").replace("refs/heads/", "");
  const commits: any[] = payload.commits ?? [];

  // Check branch name for issue refs
  if (settings.showBranches) {
    const branchRefs = extractIssueRefs(branch);
    for (const issueId of branchRefs) {
      const issue = await prisma.issue.findFirst({
        where: { id: issueId, workspaceId },
        select: { id: true, title: true },
      });
      if (issue) {
        await logActivity({
          workspaceId,
          actorId,
          type: "GITHUB_BRANCH_LINKED",
          targetType: "ISSUE",
          targetId: issue.id,
          message: `Branch ${branch} linked to ${issue.id}`,
          metadata: {
            branch,
            repo: repoFullName,
            provider: "github",
            entityId: issue.id,
            entityTitle: issue.title,
          },
        });
      }
    }
  }

  // Process each commit
  if (settings.showCommits) {
    for (const commit of commits) {
      const issueRefs = extractIssueRefs(commit.message);
      for (const issueId of issueRefs) {
        const issue = await prisma.issue.findFirst({
          where: { id: issueId, workspaceId },
          select: { id: true, title: true },
        });
        if (issue) {
          await logActivity({
            workspaceId,
            actorId,
            type: "GITHUB_COMMIT_LINKED",
            targetType: "ISSUE",
            targetId: issue.id,
            message: `Commit ${(commit.id as string).slice(0, 7)} linked to ${issue.id}`,
            metadata: {
              sha: commit.id,
              shortSha: (commit.id as string).slice(0, 7),
              message: commit.message,
              url: commit.url,
              author: commit.author?.name ?? "unknown",
              branch,
              repo: repoFullName,
              provider: "github",
              entityId: issue.id,
              entityTitle: issue.title,
            },
          });
        }
      }
    }
  }
}

/**
 * Process a GitHub pull_request event.
 * Links PRs to issues, auto-moves status on open/merge.
 */
export async function handleGitHubPullRequest(workspaceId: string, payload: any) {
  const integration = await findConnectedIntegration(workspaceId, "GITHUB");
  if (!integration) return;

  const settings = await getSettings(integration.id);
  const actorId = integration.connectedById;
  if (!actorId) return;

  const action: string = payload.action;
  const pr = payload.pull_request;
  if (!pr) return;

  const repoFullName = payload.repository?.full_name ?? "unknown/repo";
  const prNumber = pr.number;
  const prTitle = pr.title ?? "";
  const prBody = pr.body ?? "";
  const prBranch = pr.head?.ref ?? "";
  const prUser = pr.user?.login ?? "unknown";
  const prUrl = pr.html_url ?? "";
  const merged = pr.merged === true;

  // Collect all issue refs from PR title, body, and branch
  const allRefs = new Set([
    ...extractIssueRefs(prTitle),
    ...extractIssueRefs(prBody),
    ...extractIssueRefs(prBranch),
  ]);

  if (allRefs.size === 0) return;

  for (const issueId of allRefs) {
    const issue = await prisma.issue.findFirst({
      where: { id: issueId, workspaceId },
      select: {
        id: true,
        internalId: true,
        title: true,
        status: true,
        assigneeId: true,
        creatorId: true,
        completedAt: true,
        watchers: { select: { userId: true } },
      },
    });

    if (!issue) continue;

    const issueRouteId = issue.internalId ?? issue.id;

    if (action === "opened" || action === "reopened") {
      // Log activity
      await logActivity({
        workspaceId,
        actorId,
        type: "GITHUB_PR_OPENED",
        targetType: "ISSUE",
        targetId: issue.id,
        message: `PR #${prNumber} opened for ${issue.id}`,
        metadata: {
          prNumber,
          prTitle,
          prUrl,
          prBranch,
          prUser,
          repo: repoFullName,
          provider: "github",
          entityId: issue.id,
          entityTitle: issue.title,
        },
      });

      // Auto-move to Review if enabled and issue is not already in Review/Done
      if (settings.autoMoveToReviewOnPr && issue.status !== "REVIEW" && issue.status !== "DONE") {
        await prisma.issue.update({
          where: { id: issue.id },
          data: { status: "REVIEW" },
        });

        await logActivity({
          workspaceId,
          actorId,
          type: "ISSUE_STATUS_CHANGED",
          targetType: "ISSUE",
          targetId: issue.id,
          message: `${issue.id} moved to Review (PR #${prNumber} opened)`,
          metadata: {
            fromStatus: issue.status,
            toStatus: "REVIEW",
            trigger: "github_pr_opened",
            prNumber,
            entityId: issue.id,
          },
        });
      }

      // Notify assignee
      if (settings.notifyOnPrOpen && issue.assigneeId) {
        await createNotification({
          workspaceId,
          recipientUserId: issue.assigneeId,
          type: "UPDATE",
          category: "update",
          title: "Pull request opened",
          message: `PR #${prNumber} "${prTitle}" opened for ${issue.id}`,
          target: {
            type: "issue",
            id: issue.id,
            publicId: issueRouteId,
            url: `/issues/${issueRouteId}`,
          },
          metadata: {
            prNumber,
            prTitle,
            prUrl,
            repo: repoFullName,
            provider: "github",
            workspaceId,
            entityId: issue.id,
            entityTitle: issue.title,
            url: `/issues/${issueRouteId}`,
          },
          eventId: `github-pr:${repoFullName}:${prNumber}:opened`,
        }).catch(() => {});
      }
    }

    if (action === "closed" && merged) {
      // PR merged
      await logActivity({
        workspaceId,
        actorId,
        type: "GITHUB_PR_MERGED",
        targetType: "ISSUE",
        targetId: issue.id,
        message: `PR #${prNumber} merged — ${issue.id}`,
        metadata: {
          prNumber,
          prTitle,
          prUrl,
          prBranch,
          prUser,
          repo: repoFullName,
          mergedAt: pr.merged_at,
          provider: "github",
          entityId: issue.id,
          entityTitle: issue.title,
        },
      });

      // Auto-complete issue if enabled
      if (settings.autoCompleteOnMerge && issue.status !== "DONE") {
        await prisma.issue.update({
          where: { id: issue.id },
          data: { status: "DONE", completedAt: new Date() },
        });

        await logActivity({
          workspaceId,
          actorId,
          type: "ISSUE_STATUS_CHANGED",
          targetType: "ISSUE",
          targetId: issue.id,
          message: `${issue.id} completed (PR #${prNumber} merged)`,
          metadata: {
            fromStatus: issue.status,
            toStatus: "DONE",
            trigger: "github_pr_merged",
            prNumber,
            entityId: issue.id,
          },
        });
      }

      // Notify assignee + creator + watchers
      if (settings.notifyOnPrMerge) {
        const recipients = new Set<string>();
        if (issue.assigneeId) recipients.add(issue.assigneeId);
        if (issue.creatorId) recipients.add(issue.creatorId);
        for (const w of issue.watchers) recipients.add(w.userId);

        await Promise.all([...recipients].map((recipientUserId) =>
          createNotification({
            workspaceId,
            recipientUserId,
            type: "UPDATE",
            category: "update",
            title: "Pull request merged",
            message: `PR #${prNumber} merged — ${issue.id} ${settings.autoCompleteOnMerge ? "completed" : "updated"}`,
            target: {
              type: "issue",
              id: issue.id,
              publicId: issueRouteId,
              url: `/issues/${issueRouteId}`,
            },
            metadata: {
              prNumber,
              prTitle,
              prUrl,
              repo: repoFullName,
              provider: "github",
              workspaceId,
              entityId: issue.id,
              entityTitle: issue.title,
              url: `/issues/${issueRouteId}`,
            },
            eventId: `github-pr:${repoFullName}:${prNumber}:merged:${recipientUserId}`,
          }).catch(() => {}),
        ));
      }
    }

    if (action === "closed" && !merged) {
      // PR closed without merge
      await logActivity({
        workspaceId,
        actorId,
        type: "GITHUB_PR_CLOSED",
        targetType: "ISSUE",
        targetId: issue.id,
        message: `PR #${prNumber} closed without merge — ${issue.id}`,
        metadata: {
          prNumber,
          prTitle,
          prUrl,
          prUser,
          repo: repoFullName,
          provider: "github",
          entityId: issue.id,
          entityTitle: issue.title,
        },
      });
    }
  }
}

/**
 * Process a GitHub pull_request_review event.
 */
export async function handleGitHubPullRequestReview(workspaceId: string, payload: any) {
  const integration = await findConnectedIntegration(workspaceId, "GITHUB");
  if (!integration) return;

  const settings = await getSettings(integration.id);
  const actorId = integration.connectedById;
  if (!actorId) return;

  const pr = payload.pull_request;
  const review = payload.review;
  if (!pr || !review) return;

  const repoFullName = payload.repository?.full_name ?? "unknown/repo";
  const prNumber = pr.number;
  const prTitle = pr.title ?? "";
  const prBranch = pr.head?.ref ?? "";
  const reviewUser = review.user?.login ?? "unknown";
  const reviewState = review.state ?? "commented"; // approved, changes_requested, commented

  const allRefs = new Set([
    ...extractIssueRefs(prTitle),
    ...extractIssueRefs(pr.body ?? ""),
    ...extractIssueRefs(prBranch),
  ]);

  for (const issueId of allRefs) {
    const issue = await prisma.issue.findFirst({
      where: { id: issueId, workspaceId },
      select: { id: true, internalId: true, title: true, assigneeId: true, creatorId: true },
    });

    if (!issue) continue;

    const issueRouteId = issue.internalId ?? issue.id;

    await logActivity({
      workspaceId,
      actorId,
      type: "GITHUB_PR_REVIEW",
      targetType: "ISSUE",
      targetId: issue.id,
      message: `${reviewUser} ${reviewState} PR #${prNumber} for ${issue.id}`,
      metadata: {
        prNumber,
        prTitle,
        reviewState,
        reviewUser,
        repo: repoFullName,
        provider: "github",
        entityId: issue.id,
        entityTitle: issue.title,
      },
    });

    // Notify PR author (issue assignee or creator) about the review
    if (settings.notifyOnPrReview) {
      const recipient = issue.assigneeId ?? issue.creatorId;
      if (recipient) {
        const stateLabel = reviewState === "approved" ? "approved" :
          reviewState === "changes_requested" ? "requested changes on" : "commented on";

        await createNotification({
          workspaceId,
          recipientUserId: recipient,
          type: "UPDATE",
          category: "update",
          title: `PR review: ${reviewState}`,
          message: `${reviewUser} ${stateLabel} PR #${prNumber} for ${issue.id}`,
          target: {
            type: "issue",
            id: issue.id,
            publicId: issueRouteId,
            url: `/issues/${issueRouteId}`,
          },
          metadata: {
            prNumber,
            prTitle,
            reviewState,
            reviewUser,
            repo: repoFullName,
            provider: "github",
            workspaceId,
            entityId: issue.id,
            entityTitle: issue.title,
            url: `/issues/${issueRouteId}`,
          },
          eventId: `github-review:${repoFullName}:${prNumber}:${reviewUser}:${reviewState}`,
        }).catch(() => {});
      }
    }
  }
}
