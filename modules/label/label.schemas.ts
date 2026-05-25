import { z } from "zod/v4";

const labelSortSchema = z.enum(["name:asc", "usage:desc"]);
const hexColorRegex = /^#[0-9A-Fa-f]{6}$/;

export const createLabelSchema = {
  body: z.object({
    name: z.string().trim().min(1).max(40),
    color: z.string().regex(hexColorRegex, "Color must be a valid hex value like #RRGGBB"),
    description: z.string().trim().max(500).nullable().optional(),
  }),
};

export const listLabelsSchema = {
  query: z.object({
    q: z.string().trim().max(200).optional(),
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sort: labelSortSchema.optional(),
  }),
};

export const updateLabelSchema = {
  params: z.object({
    labelId: z.string().uuid(),
  }),
  body: z.object({
    name: z.string().trim().min(1).max(40).optional(),
    color: z.string().regex(hexColorRegex, "Color must be a valid hex value like #RRGGBB").optional(),
    description: z.string().trim().max(500).nullable().optional(),
  }),
};

export const deleteLabelSchema = {
  params: z.object({
    labelId: z.string().uuid(),
  }),
};

export const attachIssueLabelsSchema = {
  params: z.object({
    issueId: z.string().min(1),
  }),
  body: z.object({
    labelIds: z.array(z.string().uuid()).min(1).max(20),
  }),
};

export const removeIssueLabelSchema = {
  params: z.object({
    issueId: z.string().min(1),
    labelId: z.string().uuid(),
  }),
};

export type CreateLabelInput = z.infer<typeof createLabelSchema.body>;
export type ListLabelsQuery = z.infer<typeof listLabelsSchema.query>;
export type UpdateLabelInput = z.infer<typeof updateLabelSchema.body>;
export type AttachIssueLabelsInput = z.infer<typeof attachIssueLabelsSchema.body>;
