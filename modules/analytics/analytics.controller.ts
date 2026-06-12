import type { RequestHandler } from "express";

import { sendSuccess } from "../../shared/utils/api-response.js";
import * as analyticsService from "./analytics.service.js";
import type { AnalyticsQuery, ExportQuery } from "./analytics.schemas.js";

export const getWorkspaceAnalytics: RequestHandler = async (req, res, next) => {
  try {
    const query = req.validated!.query as AnalyticsQuery;
    const data = await analyticsService.getWorkspaceAnalytics(
      req.workspace!.id,
      query,
    );
    sendSuccess(res, 200, data);
  } catch (error) {
    next(error);
  }
};

export const getProjectAnalytics: RequestHandler = async (req, res, next) => {
  try {
    const query = req.validated!.query as AnalyticsQuery;
    const data = await analyticsService.getProjectAnalytics(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      String(req.params.id),
      query,
    );
    sendSuccess(res, 200, data);
  } catch (error) {
    next(error);
  }
};

export const getTeamAnalytics: RequestHandler = async (req, res, next) => {
  try {
    const query = req.validated!.query as AnalyticsQuery;
    const data = await analyticsService.getTeamAnalytics(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      String(req.params.id),
      query,
    );
    sendSuccess(res, 200, data);
  } catch (error) {
    next(error);
  }
};

export const getMemberAnalytics: RequestHandler = async (req, res, next) => {
  try {
    const query = req.validated!.query as AnalyticsQuery;
    const data = await analyticsService.getMemberAnalytics(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      String(req.params.id),
      query,
    );
    sendSuccess(res, 200, data);
  } catch (error) {
    next(error);
  }
};

export const getCycleAnalytics: RequestHandler = async (req, res, next) => {
  try {
    const query = req.validated!.query as AnalyticsQuery;
    const data = await analyticsService.getCycleAnalytics(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      String(req.params.id),
      query,
    );
    sendSuccess(res, 200, data);
  } catch (error) {
    next(error);
  }
};

export const exportAnalytics: RequestHandler = async (req, res, next) => {
  try {
    const query = req.validated!.query as ExportQuery;
    const file = await analyticsService.exportAnalytics(
      req.workspace!.id,
      req.workspace!.role,
      req.user!.id,
      query,
    );

    res.setHeader("Content-Disposition", `attachment; filename=\"${file.fileName}\"`);
    res.setHeader("Content-Type", file.contentType);
    res.status(200).send(file.body);
  } catch (error) {
    next(error);
  }
};
