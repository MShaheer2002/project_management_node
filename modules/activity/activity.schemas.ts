import { z } from "zod/v4";

const scopeSchema = z.enum(["workspace", "project", "team", "issue"]);
const entityTypeSchema = z.enum(["workspace", "project", "team", "issue", "comment", "label", "member", "cycle"]);

export const listActivitySchema = {
  query: z.object({
    scope: scopeSchema.optional(),
    scopeId: z.string().min(1).optional(),
    actorId: z.string().min(1).optional(),
    types: z.string().trim().min(1).optional(),
    entityTypes: z.string().trim().min(1).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
};

export const issueActivitySchema = {
  params: z.object({
    issueId: z.string().min(1),
  }),
  query: z.object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
};

export type ListActivityQuery = z.infer<typeof listActivitySchema.query>;
export type ListIssueActivityQuery = z.infer<typeof issueActivitySchema.query>;
export { entityTypeSchema };
