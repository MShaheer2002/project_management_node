import { z } from "zod/v4";

const cycleStatusSchema = z.enum(["UPCOMING", "CURRENT", "COMPLETED"]);
const cycleIssueStatusSchema = z.string().trim().min(1).max(50);
const cycleIssuePrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
const cycleIssueTypeSchema = z.enum(["task", "bug", "issue"]);
const cycleIssueSortSchema = z.enum(["updatedAt:desc", "priority:desc", "dueDate:asc", "status:asc"]);

export const createCycleSchema = {
  body: z.object({
    teamId: z.string().uuid(),
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(5000).nullable().optional(),
    goal: z.string().trim().max(5000).nullable().optional(),
    startsAt: z.string().datetime(),
    endsAt: z.string().datetime(),
    status: cycleStatusSchema.optional(),
  }),
};

export const listCyclesSchema = {
  query: z.object({
    teamId: z.string().uuid().optional(),
    status: cycleStatusSchema.optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
};

export const cycleIdParamsSchema = {
  params: z.object({ id: z.string().uuid() }),
};

export const updateCycleSchema = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    goal: z.string().trim().max(5000).nullable().optional(),
    startsAt: z.string().datetime().optional(),
    endsAt: z.string().datetime().optional(),
    status: cycleStatusSchema.optional(),
  }),
};

export const carryOverSchema = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    mode: z.enum(["nextCycle", "backlog"]),
    targetCycleId: z.string().uuid().optional(),
  }),
};

export const listCycleIssuesSchema = {
  params: z.object({ id: z.string().uuid() }),
  query: z.object({
    q: z.string().trim().max(200).optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sort: cycleIssueSortSchema.optional(),
    status: cycleIssueStatusSchema.optional(),
    priority: cycleIssuePrioritySchema.optional(),
    type: cycleIssueTypeSchema.optional(),
    assigneeId: z.string().min(1).optional(),
    projectId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
  }),
};

export const planCycleIssuesSchema = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    issueIds: z.array(z.string().min(1)).min(1).max(100),
  }),
};

export const removeCycleIssueSchema = {
  params: z.object({
    id: z.string().uuid(),
    issueId: z.string().min(1),
  }),
};

export const assignIssueCycleSchema = {
  params: z.object({ id: z.string().min(1) }),
  body: z.object({ cycleId: z.string().uuid() }),
};

export const removeIssueCycleSchema = {
  params: z.object({ id: z.string().min(1) }),
};

export type CreateCycleInput = z.infer<typeof createCycleSchema.body>;
export type ListCyclesQuery = z.infer<typeof listCyclesSchema.query>;
export type UpdateCycleInput = z.infer<typeof updateCycleSchema.body>;
export type CarryOverInput = z.infer<typeof carryOverSchema.body>;
export type ListCycleIssuesQuery = z.infer<typeof listCycleIssuesSchema.query>;
export type PlanCycleIssuesInput = z.infer<typeof planCycleIssuesSchema.body>;
export type AssignIssueCycleInput = z.infer<typeof assignIssueCycleSchema.body>;
