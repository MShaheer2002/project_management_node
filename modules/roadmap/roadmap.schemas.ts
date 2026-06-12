import { z } from "zod/v4";

const roadmapViewSchema = z.enum(["MONTH", "QUARTER"]);
const roadmapHealthSchema = z.enum(["ON_TRACK", "AT_RISK", "OFF_TRACK", "BLOCKED", "NO_SIGNAL"]);
const projectStatusSchema = z.enum(["ACTIVE", "COMPLETED", "ARCHIVED"]);
const milestoneStatusSchema = z.enum(["PLANNED", "IN_PROGRESS", "COMPLETED", "MISSED"]);
const roadmapSortSchema = z.enum([
  "targetDate:asc",
  "targetDate:desc",
  "startDate:asc",
  "startDate:desc",
  "progress:asc",
  "progress:desc",
  "health:asc",
  "health:desc",
  "updatedAt:desc",
  "name:asc",
]);

export const listRoadmapSchema = {
  query: z.object({
    view: roadmapViewSchema.optional(),
    from: z.string().date().optional(),
    to: z.string().date().optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(200).optional(),
    sort: roadmapSortSchema.optional(),
    teamId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    leadId: z.string().min(1).optional(),
    projectId: z.string().uuid().optional(),
    status: projectStatusSchema.optional(),
    health: roadmapHealthSchema.optional(),
    includeUnscheduled: z.coerce.boolean().optional(),
    q: z.string().trim().max(100).optional(),
  }),
};

export const roadmapProjectParamsSchema = {
  params: z.object({
    projectId: z.string().uuid("Invalid project ID"),
  }),
};

export const roadmapDependencyParamsSchema = {
  params: z.object({
    dependencyId: z.string().uuid("Invalid dependency ID"),
  }),
};

export const roadmapMilestoneParamsSchema = {
  params: z.object({
    projectId: z.string().uuid("Invalid project ID"),
    milestoneId: z.string().uuid("Invalid milestone ID"),
  }),
};

export const updateRoadmapScheduleSchema = {
  params: roadmapProjectParamsSchema.params,
  body: z.object({
    startDate: z.string().date().nullable().optional(),
    targetDate: z.string().date().nullable().optional(),
    reason: z.string().trim().max(5000).nullable().optional(),
    force: z.boolean().optional(),
  }),
};

export const createMilestoneSchema = {
  params: roadmapProjectParamsSchema.params,
  body: z.object({
    name: z.string().trim().min(1).max(120),
    description: z.string().trim().max(5000).nullable().optional(),
    dueDate: z.string().datetime(),
    ownerId: z.string().min(1).nullable().optional(),
    status: milestoneStatusSchema.optional(),
  }),
};

export const updateMilestoneSchema = {
  params: roadmapMilestoneParamsSchema.params,
  body: z.object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(5000).nullable().optional(),
    dueDate: z.string().datetime().optional(),
    ownerId: z.string().min(1).nullable().optional(),
    status: milestoneStatusSchema.optional(),
  }),
};

export const reorderMilestonesSchema = {
  params: roadmapProjectParamsSchema.params,
  body: z.object({
    orderedIds: z.array(z.string().uuid()).min(1).max(500),
  }).superRefine((value, ctx) => {
    if (new Set(value.orderedIds).size !== value.orderedIds.length) {
      ctx.addIssue({
        code: "custom",
        message: "orderedIds must not contain duplicates",
        path: ["orderedIds"],
      });
    }
  }),
};

export const createDependencySchema = {
  body: z.object({
    blockingProjectId: z.string().uuid(),
    blockedProjectId: z.string().uuid(),
    note: z.string().trim().max(5000).nullable().optional(),
  }).superRefine((value, ctx) => {
    if (value.blockingProjectId === value.blockedProjectId) {
      ctx.addIssue({
        code: "custom",
        message: "blockingProjectId and blockedProjectId must be different",
        path: ["blockedProjectId"],
      });
    }
  }),
};

export const resolveDependencySchema = {
  params: roadmapDependencyParamsSchema.params,
  body: z.object({
    note: z.string().trim().max(5000).nullable().optional(),
  }),
};

export const cancelDependencySchema = {
  params: roadmapDependencyParamsSchema.params,
  body: z.object({
    note: z.string().trim().max(5000).nullable().optional(),
  }),
};

export type ListRoadmapQuery = z.infer<typeof listRoadmapSchema.query>;
export type UpdateRoadmapScheduleInput = z.infer<typeof updateRoadmapScheduleSchema.body>;
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema.body>;
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema.body>;
export type ReorderMilestonesInput = z.infer<typeof reorderMilestonesSchema.body>;
export type CreateDependencyInput = z.infer<typeof createDependencySchema.body>;
export type ResolveDependencyInput = z.infer<typeof resolveDependencySchema.body>;
export type CancelDependencyInput = z.infer<typeof cancelDependencySchema.body>;
