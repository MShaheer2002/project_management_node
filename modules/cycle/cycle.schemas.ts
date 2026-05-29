import { z } from "zod/v4";

const cycleStatusSchema = z.enum(["UPCOMING", "CURRENT", "COMPLETED"]);

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
export type AssignIssueCycleInput = z.infer<typeof assignIssueCycleSchema.body>;
