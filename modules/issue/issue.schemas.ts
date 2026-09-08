import { z } from "zod/v4";

const issueStatusSchema = z.string().trim().min(1).max(50);
const issuePrioritySchema = z.enum(["low", "medium", "high", "urgent"]);
const issueTypeSchema = z.enum(["task", "bug", "issue"]);
const bugSeveritySchema = z.enum(["low", "medium", "high"]);
const issueSortSchema = z.enum(["createdAt:desc", "createdAt:asc", "updatedAt:desc", "updatedAt:asc", "dueDate:asc", "dueDate:desc"]);

const attachmentRefSchema = z.object({
  key: z.string().min(1),
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1),
  size: z.number().int().positive(),
  kind: z.enum(["attachment", "video"]),
  assetUrl: z.string().url().nullable().optional(),
});

const integrationRefInputSchema = z.object({
  id: z.string().trim().min(1).max(100),
  provider: z.enum(["github", "jira", "slack", "notion", "figma", "custom"]),
  label: z.string().trim().max(100).nullable().optional(),
  externalId: z.string().trim().max(255).nullable().optional(),
  url: z.string().url().nullable().optional(),
});

const createSubtaskInlineSchema = z.object({
  title: z.string().trim().min(1).max(500),
  order: z.number().int().min(0).optional(),
});

export const createIssueSchema = {
  body: z.object({
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(50000).optional(),
    type: issueTypeSchema,
    projectId: z.string().uuid(),
    cycleId: z.string().uuid().nullable().optional(),
    priority: issuePrioritySchema,
    status: issueStatusSchema.optional(),
    assigneeId: z.string().min(1).nullable().optional(),
    labels: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    dueDate: z.string().date().nullable().optional(),
    dueTime: z.string().optional().nullable(),
    estimate: z.number().int().min(1).max(5).nullable().optional(),
    subtasks: z.array(createSubtaskInlineSchema).max(200).optional(),
    stepsToReproduce: z.string().trim().max(50000).optional(),
    expectedBehavior: z.string().trim().max(50000).optional(),
    actualBehavior: z.string().trim().max(50000).optional(),
    severity: bugSeveritySchema.optional(),
    acceptanceCriteria: z.string().trim().max(50000).optional(),
    relatedIssueKeys: z.array(z.string().trim().min(1)).max(100).optional(),
    notes: z.string().trim().max(50000).optional(),
    integrationRefs: z.array(integrationRefInputSchema).max(25).optional(),
    attachments: z.array(attachmentRefSchema).max(100).optional(),
    parentIssueId: z.string().min(1).nullable().optional(),
    templateId: z.string().uuid().optional(),
    templateDraftId: z.string().uuid().optional(),
  }),
};

export const listIssuesSchema = {
  query: z.object({
    q: z.string().trim().max(200).optional(),
    cursor: z.string().min(1).optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sort: issueSortSchema.optional(),
    status: issueStatusSchema.optional(),
    priority: issuePrioritySchema.optional(),
    type: issueTypeSchema.optional(),
    assigneeId: z.string().min(1).optional(),
    projectId: z.string().uuid().optional(),
    teamId: z.string().uuid().optional(),
    departmentId: z.string().uuid().optional(),
    creatorId: z.string().min(1).optional(),
    view: z.enum(["full", "compact"]).optional(),
  }),
};

export const getStatusCountsSchema = {
  query: z.object({
    projectId: z.string().uuid().optional(),
  }),
};

export const checkAssignmentEligibilitySchema = {
  body: z.object({
    projectId: z.string().uuid(),
    assigneeId: z.string().min(1),
  }),
};

export const issueIdParamsSchema = {
  params: z.object({
    id: z.string().min(1),
  }),
};

export const updateIssueSchema = {
  params: z.object({
    id: z.string().min(1),
  }),
  body: z.object({
    title: z.string().trim().min(1).max(500).optional(),
    description: z.string().trim().max(50000).nullable().optional(),
    type: issueTypeSchema.optional(),
    priority: issuePrioritySchema.optional(),
    status: issueStatusSchema.optional(),
    assigneeId: z.string().min(1).nullable().optional(),
    labels: z.array(z.string().trim().min(1).max(80)).max(50).optional(),
    dueDate: z.string().date().nullable().optional(),
    dueTime: z.string().nullable().optional(),
    estimate: z.number().int().min(1).max(5).nullable().optional(),
    stepsToReproduce: z.string().trim().max(50000).nullable().optional(),
    expectedBehavior: z.string().trim().max(50000).nullable().optional(),
    actualBehavior: z.string().trim().max(50000).nullable().optional(),
    severity: bugSeveritySchema.nullable().optional(),
    acceptanceCriteria: z.string().trim().max(50000).nullable().optional(),
    relatedIssueKeys: z.array(z.string().trim().min(1)).max(100).optional(),
    notes: z.string().trim().max(50000).nullable().optional(),
    attachments: z.array(attachmentRefSchema).max(100).optional(),
    parentIssueId: z.string().min(1).nullable().optional(),
  }),
};

export const updateIssueStatusSchema = {
  params: z.object({ id: z.string().min(1) }),
  body: z.object({ status: issueStatusSchema }),
};

export const createSubtaskSchema = {
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    title: z.string().trim().min(1).max(500),
    order: z.number().int().min(0).optional(),
  }),
};

export const updateSubtaskSchema = {
  params: z.object({ id: z.string().min(1), sid: z.string().uuid() }),
  body: z.object({
    title: z.string().trim().min(1).max(500).optional(),
    completed: z.boolean().optional(),
    order: z.number().int().min(0).optional(),
  }),
};

export const deleteSubtaskParamsSchema = {
  params: z.object({ id: z.string().min(1), sid: z.string().uuid() }),
};

export const reorderSubtasksSchema = {
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    items: z.array(z.object({
      id: z.string().uuid(),
      order: z.number().int().min(0),
    })).min(1).max(500),
  }),
};

export const createIssueAttachmentsSchema = {
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    attachments: z.array(attachmentRefSchema).min(1).max(100),
  }),
};

export const deleteIssueAttachmentParamsSchema = {
  params: z.object({ id: z.string().min(1), attachmentId: z.string().uuid() }),
};

export const addDependencySchema = {
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      issueId: z.string().min(1).optional(),
      relatedId: z.string().min(1).optional(),
      relation: z.enum(["blocks", "blocked-by", "related"]),
    })
    .refine((value) => Boolean(value.issueId || value.relatedId), {
      message: "Issue is required",
      path: ["issueId"],
    })
    .transform(({ issueId, relatedId, relation }) => ({
      issueId: issueId ?? relatedId!,
      relation,
    })),
};

export const removeDependencyParamsSchema = {
  params: z.object({ id: z.string().min(1), relatedId: z.string().min(1) }),
};

export const listWatchersSchema = {
  params: z.object({ id: z.string().min(1) }),
};

export const addWatchersSchema = {
  params: z.object({ id: z.string().min(1) }),
  body: z.object({
    userIds: z.array(z.string().min(1)).min(1).max(100),
  }),
};

export const removeWatcherParamsSchema = {
  params: z.object({ id: z.string().min(1), userId: z.string().min(1) }),
};

export const updateIntegrationRefSchema = {
  params: z.object({ id: z.string().min(1) }),
  body: z
    .object({
      integrationRef: z
        .object({
          provider: z.enum(["github", "jira", "slack", "notion", "figma", "custom"]),
          label: z.string().trim().max(100).nullable().optional(),
          externalId: z.string().trim().max(255).nullable().optional(),
          url: z.string().url().nullable().optional(),
        })
        .nullable()
        .optional(),
      integrationRefs: z
        .array(
          z.object({
            id: z.string().trim().min(1).max(100),
            provider: z.enum(["github", "jira", "slack", "notion", "figma", "custom"]),
            label: z.string().trim().max(100).nullable().optional(),
            externalId: z.string().trim().max(255).nullable().optional(),
            url: z.string().url().nullable().optional(),
          }),
        )
        .max(25)
        .optional(),
    })
    .transform(({ integrationRef, integrationRefs }) => ({
      integrationRefs:
        integrationRefs
        ?? (integrationRef
          ? [
              {
                id: "legacy-ref",
                provider: integrationRef.provider,
                label: integrationRef.label ?? null,
                externalId: integrationRef.externalId ?? null,
                url: integrationRef.url ?? null,
              },
            ]
          : []),
    })),
};

export type CreateIssueInput = z.infer<typeof createIssueSchema.body>;
export type CheckAssignmentEligibilityInput = z.infer<typeof checkAssignmentEligibilitySchema.body>;
export type ListIssuesQuery = z.infer<typeof listIssuesSchema.query>;
export type GetStatusCountsQuery = z.infer<typeof getStatusCountsSchema.query>;
export type UpdateIssueInput = z.infer<typeof updateIssueSchema.body>;
