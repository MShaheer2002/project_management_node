import type { RequestHandler } from "express";

import * as activityService from "./activity.service.js";
import type { ListActivityQuery, ListIssueActivityQuery } from "./activity.schemas.js";

export const list: RequestHandler = async (req, res, next) => {
  try {
    const result = await activityService.listActivity(
      req.workspace!.id,
      req.workspace!.role,
      (req.validated?.query ?? req.query) as ListActivityQuery,
    );
    res.status(200).json({
      success: true,
      data: result.items,
      meta: {
        nextCursor: result.meta.nextCursor,
        hasMore: result.meta.hasMore,
      },
    });
  } catch (error) {
    next(error);
  }
};

export const listIssueActivity: RequestHandler = async (req, res, next) => {
  try {
    const result = await activityService.listIssueActivity(
      req.workspace!.id,
      req.workspace!.role,
      req.params.issueId as string,
      (req.validated?.query ?? req.query) as ListIssueActivityQuery,
    );
    res.status(200).json({
      success: true,
      data: result.items,
      meta: {
        nextCursor: result.meta.nextCursor,
        hasMore: result.meta.hasMore,
      },
    });
  } catch (error) {
    next(error);
  }
};
