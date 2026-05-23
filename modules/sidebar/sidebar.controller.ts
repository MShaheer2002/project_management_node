/**
 * Sidebar Module — Controller
 */

import type { RequestHandler } from "express";
import * as sidebarService from "./sidebar.service.js";
import { sendSuccess } from "../../shared/utils/api-response.js";

/** GET /sidebar — Authenticated app shell/sidebar aggregate */
export const getSidebar: RequestHandler = async (req, res, next) => {
  try {
    const sidebar = await sidebarService.getSidebarData(
      req.workspace!.id,
      req.user!.id,
      req.workspace!.role,
    );

    sendSuccess(res, 200, sidebar);
  } catch (error) {
    next(error);
  }
};
