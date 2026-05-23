/**
 * Dashboard Module — Controller
 *
 * Handles HTTP request parsing and response sending for dashboard endpoints.
 */

import type { RequestHandler } from "express";
import * as dashboardService from "./dashboard.service.js";
import { sendSuccess } from "../../shared/utils/api-response.js";

/** GET /dashboard — Aggregate workspace dashboard data */
export const getOverview: RequestHandler = async (req, res, next) => {
  try {
    const dashboard = await dashboardService.getDashboardData(
      req.workspace!.id,
      req.user!.id,
    );

    sendSuccess(res, 200, dashboard);
  } catch (error) {
    next(error);
  }
};
