import { z } from "zod/v4";

const analyticsPeriodSchema = z.enum(["7d", "30d", "90d", "custom"]);
const analyticsScopeSchema = z.enum(["workspace", "project", "team", "member", "cycle"]);
const exportFormatSchema = z.enum(["csv", "json", "pdf"]);

export const analyticsQuerySchema = {
  query: z.object({
    period: analyticsPeriodSchema.default("30d"),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
  }),
};

export const projectAnalyticsParamsSchema = {
  params: z.object({ id: z.string().uuid("Invalid project ID") }),
};

export const teamAnalyticsParamsSchema = {
  params: z.object({ id: z.string().uuid("Invalid team ID") }),
};

export const memberAnalyticsParamsSchema = {
  params: z.object({ id: z.string().min(1, "Invalid member ID") }),
};

export const cycleAnalyticsParamsSchema = {
  params: z.object({ id: z.string().uuid("Invalid cycle ID") }),
};

export const exportQuerySchema = {
  query: z.object({
    period: analyticsPeriodSchema.default("30d"),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    scope: analyticsScopeSchema,
    scopeId: z.string().optional(),
    format: exportFormatSchema.default("json"),
  }).superRefine((value, ctx) => {
    if (value.scope !== "workspace" && !value.scopeId) {
      ctx.addIssue({
        code: "custom",
        path: ["scopeId"],
        message: "scopeId is required for non-workspace exports",
      });
    }
  }),
};

export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema.query>;
export type ExportQuery = z.infer<typeof exportQuerySchema.query>;
