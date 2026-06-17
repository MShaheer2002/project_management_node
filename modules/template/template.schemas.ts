import { z } from "zod/v4";

const templateIssueTypeSchema = z.enum(["task", "bug", "issue"]);
const templateAssigneeTypeSchema = z.enum(["UNASSIGNED", "CREATOR", "SPECIFIC_USER"]);
const templateLifecycleSchema = z.enum(["ACTIVE", "INACTIVE", "ARCHIVED"]);

const stringArraySchema = z.array(z.string().trim().min(1).max(100)).max(200);

export const templateIdParamsSchema = {
  params: z.object({ id: z.string().uuid() }),
};

export const listTemplatesSchema = {
  query: z.object({
    q: z.string().trim().max(200).optional(),
    category: z.string().trim().min(1).max(100).optional(),
    issueType: templateIssueTypeSchema.optional(),
    creatorId: z.string().min(1).optional(),
    sort: z.enum(["updatedAt:desc", "updatedAt:asc", "createdAt:desc", "createdAt:asc", "name:asc"]).optional(),
    lifecycle: templateLifecycleSchema.optional(),
    isActive: z.coerce.boolean().optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }).catchall(z.unknown()),
};

export const listActiveTemplatesSchema = {
  query: z.object({
    issueType: templateIssueTypeSchema.optional(),
  }).catchall(z.unknown()),
};

const templateDraftInputSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().min(1).max(5000),
  issueType: templateIssueTypeSchema,
  category: z.string().trim().min(1).max(100),
  customCategory: z.string().trim().min(1).max(100).nullable().optional(),
  titleTemplate: z.string().trim().min(1).max(500),
  contentTemplate: z.string().trim().min(1).max(50000),
  defaultPriority: z.string().trim().min(1).max(50),
  defaultStatus: z.string().trim().min(1).max(50),
  customStatus: z.string().trim().min(1).max(100).nullable().optional(),
  defaultAssigneeType: templateAssigneeTypeSchema,
  defaultAssigneeId: z.string().min(1).nullable().optional(),
  defaultEstimate: z.number().int().min(1).max(5).nullable().optional(),
  defaultDueDateOffset: z.number().int().min(0).max(365).nullable().optional(),
  defaultLabelIds: z.array(z.string().uuid()).max(100).optional(),
  defaultSeverity: z.enum(["low", "medium", "high"]).nullable().optional(),
  categoryOptions: stringArraySchema.optional(),
  priorityOptions: stringArraySchema.optional(),
  statusOptions: stringArraySchema.optional(),
  labelOptions: stringArraySchema.optional(),
  checklistItems: z.array(z.string().trim().min(1).max(500)).max(300).optional(),
  stepsToReproduceTemplate: z.string().trim().max(50000).nullable().optional(),
  expectedBehaviorTemplate: z.string().trim().max(50000).nullable().optional(),
  actualBehaviorTemplate: z.string().trim().max(50000).nullable().optional(),
  acceptanceCriteriaTemplate: z.string().trim().max(50000).nullable().optional(),
  relatedIssueKeysTemplate: z.string().trim().max(50000).nullable().optional(),
  notesTemplate: z.string().trim().max(50000).nullable().optional(),
});

export const createTemplateSchema = {
  body: templateDraftInputSchema,
};

export const updateTemplateSchema = {
  params: z.object({ id: z.string().uuid() }),
  body: templateDraftInputSchema.partial().refine((data) => Object.keys(data).length > 0, {
    message: "At least one field is required",
  }),
};

export const duplicateTemplateSchema = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ isActive: z.boolean().optional() }).optional(),
};

export type CreateTemplateInput = z.infer<typeof createTemplateSchema.body>;
export type UpdateTemplateInput = z.infer<typeof updateTemplateSchema.body>;
export type ListTemplatesQuery = z.infer<typeof listTemplatesSchema.query>;
export type ListActiveTemplatesQuery = z.infer<typeof listActiveTemplatesSchema.query>;
