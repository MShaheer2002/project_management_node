import { z } from "zod/v4";
import { documentDraftSchema } from "../documents/documents.schemas.js";

const visibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);
const teamSortSchema = z.enum(["name:asc", "name:desc", "createdAt:asc", "createdAt:desc"]);
const memberSortSchema = z.enum(["name:asc", "name:desc", "joinedAt:asc", "joinedAt:desc"]);
const viewSchema = z.enum(["compact", "full"]);

export const createTeamSchema = {
  body: z.object({
    name: z.string().min(1, "Team name is required").max(100).trim(),
    description: z.string().max(500).trim().optional(),
    leadId: z.string().min(1, "Lead is required"),
    departmentId: z.string().uuid("Invalid department ID").nullable().optional(),
    visibility: visibilitySchema.optional(),
    memberIds: z.array(z.string().min(1)).max(100).optional(),
    docs: z.array(documentDraftSchema).max(20).optional(),
  }).superRefine((value, ctx) => {
    const keys = (value.docs ?? []).map((document) => document.file.key);
    if (new Set(keys).size !== keys.length) {
      ctx.addIssue({
        code: "custom",
        message: "Document keys must be unique",
        path: ["docs"],
      });
    }
  }),
};

export const listTeamsSchema = {
  query: z.object({
    q: z.string().trim().max(100).optional(),
    cursor: z.string().uuid("Invalid team cursor").optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sort: teamSortSchema.optional(),
    departmentId: z.string().uuid("Invalid department ID").optional(),
    leadId: z.string().min(1).optional(),
    visibility: visibilitySchema.optional(),
    view: viewSchema.optional(),
  }),
};

export const teamIdParamSchema = {
  params: z.object({
    id: z.string().uuid("Invalid team ID"),
  }),
};

export const updateTeamSchema = {
  params: z.object({
    id: z.string().uuid("Invalid team ID"),
  }),
  body: z.object({
    name: z.string().min(1).max(100).trim().optional(),
    description: z.string().max(500).trim().nullable().optional(),
    leadId: z.string().min(1).optional(),
    departmentId: z.string().uuid("Invalid department ID").nullable().optional(),
    visibility: visibilitySchema.optional(),
  }),
};

export const listTeamMembersSchema = {
  params: z.object({
    id: z.string().uuid("Invalid team ID"),
  }),
  query: z.object({
    q: z.string().trim().max(100).optional(),
    cursor: z.string().min(1, "Invalid cursor").optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sort: memberSortSchema.optional(),
    role: z.enum(["OWNER", "ADMIN", "MEMBER", "GUEST"]).optional(),
    view: viewSchema.optional(),
  }),
};

export const addTeamMembersSchema = {
  params: z.object({
    id: z.string().uuid("Invalid team ID"),
  }),
  body: z.object({
    userIds: z.array(z.string().min(1)).min(1).max(100),
  }),
};

export const removeTeamMemberSchema = {
  params: z.object({
    id: z.string().uuid("Invalid team ID"),
    uid: z.string().min(1, "User ID is required"),
  }),
};

export type CreateTeamInput = z.infer<typeof createTeamSchema.body>;
export type ListTeamsQuery = z.infer<typeof listTeamsSchema.query>;
export type UpdateTeamInput = z.infer<typeof updateTeamSchema.body>;
export type ListTeamMembersQuery = z.infer<typeof listTeamMembersSchema.query>;
export type AddTeamMembersInput = z.infer<typeof addTeamMembersSchema.body>;
