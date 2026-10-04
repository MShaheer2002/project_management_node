import type { RequestHandler } from "express";
import { sendSuccess } from "../../shared/utils/api-response.js";
import { getAccessPlanForWorkspace } from "../billing/billing.service.js";
import { getHelpInsights, isHelpInsightsStaff } from "../ai/ai.assist-insights.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { getHelpArticle, listHelpArticles, searchHelpArticles, type HelpViewer } from "./help.service.js";

// Articles only change on deploy. Private: the list depends on the viewer's role and plan.
const CACHE_CONTROL = "private, max-age=300";

async function viewerOf(req: Parameters<RequestHandler>[0]): Promise<HelpViewer> {
  return {
    role: req.workspace!.role,
    plan: await getAccessPlanForWorkspace(req.workspace!.id),
  };
}

/** GET /help/articles — help articles this member may read, grouped by category */
export const list: RequestHandler = async (req, res, next) => {
  try {
    res.set("Cache-Control", CACHE_CONTROL);
    sendSuccess(res, 200, listHelpArticles(await viewerOf(req)));
  } catch (error) {
    next(error);
  }
};

/** GET /help/articles/:id — one article with its full text */
export const getById: RequestHandler = async (req, res, next) => {
  try {
    res.set("Cache-Control", CACHE_CONTROL);
    sendSuccess(res, 200, getHelpArticle(req.params.id as string, await viewerOf(req)));
  } catch (error) {
    next(error);
  }
};

/** GET /help/search?q=&route= — articles matching a question, best first */
export const search: RequestHandler = async (req, res, next) => {
  try {
    const { q, route } = (req.validated?.query ?? req.query) as { q: string; route?: string };
    sendSuccess(res, 200, { results: await searchHelpArticles(q, await viewerOf(req), route) });
  } catch (error) {
    next(error);
  }
};

/** GET /help/insights/access — whether this person may open AI Assistance insights */
export const insightsAccess: RequestHandler = (req, res) => {
  sendSuccess(res, 200, { staff: isHelpInsightsStaff(req.user?.email) });
};

/**
 * GET /help/insights?days= — Trussen staff only (HELP_INSIGHTS_STAFF_EMAILS).
 * Anonymized across all workspaces: no names, no workspaces.
 */
export const insights: RequestHandler = async (req, res, next) => {
  try {
    if (!isHelpInsightsStaff(req.user?.email)) {
      // Same answer as a missing route: don't advertise that this exists.
      throw new AppError(404, ERROR_CODES.NOT_FOUND, "Not found");
    }
    const { days } = (req.validated?.query ?? req.query) as unknown as { days: number };
    res.set("Cache-Control", "no-store");
    sendSuccess(res, 200, await getHelpInsights(Number(days) || 30));
  } catch (error) {
    next(error);
  }
};
