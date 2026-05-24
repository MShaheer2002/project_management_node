import { z } from "zod/v4";

const visibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);
const projectStatusSchema = z.enum(["ACTIVE", "ARCHIVED", "COMPLETED"]);
const projectSortSchema = z.enum([
  "updatedAt:desc",
  "updatedAt:asc",
  "name:asc",
  "name:desc",
  "createdAt:desc",
  "createdAt:asc",
  "targetDate:asc",
  "targetDate:desc",
]);
const memberSortSchema = z.enum(["name:asc", "name:desc", "joinedAt:asc", "joinedAt:desc"]);
const viewSchema = z.enum(["compact", "full"]);

const featuresSchema = z.object({
  roadmap: z.boolean().optional(),
  cycles: z.boolean().optional(),
  issueTracking: z.boolean().optional(),
});

export const createProjectSchema = {
  body: z.object({
    name: z.string().min(2, "Project name is required").max(120).trim(),
    slug: z.string().regex(/^[a-z0-9-]+$/, "Invalid project slug").optional(),
    description: z.string().max(5000).trim().optional(),
    teamId: z.string().uuid("Invalid team ID"),
    departmentId: z.string().uuid("Invalid department ID").nullable().optional(),
    leadId: z.string().min(1).optional(),
    memberIds: z.array(z.string().min(1)).max(200).optional(),
    visibility: visibilitySchema.optional(),
    startDate: z.string().date().optional(),
    targetDate: z.string().date().optional(),
    features: featuresSchema.optional(),
  }),
};

export const listProjectsSchema = {
  query: z.object({
    q: z.string().trim().max(100).optional(),
    cursor: z.string().uuid("Invalid project cursor").optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sort: projectSortSchema.optional(),
    view: viewSchema.optional(),
    teamId: z.string().uuid("Invalid team ID").optional(),
    departmentId: z.string().uuid("Invalid department ID").optional(),
    leadId: z.string().min(1).optional(),
    status: projectStatusSchema.optional(),
    visibility: visibilitySchema.optional(),
  }),
};

export const projectIdParamsSchema = {
  params: z.object({
    id: z.string().uuid("Invalid project ID"),
  }),
};

export const updateProjectSchema = {
  params: z.object({
    id: z.string().uuid("Invalid project ID"),
  }),
  body: z.object({
    name: z.string().min(2).max(120).trim().optional(),
    slug: z.string().regex(/^[a-z0-9-]+$/, "Invalid project slug").optional(),
    description: z.string().max(5000).trim().nullable().optional(),
    teamId: z.string().uuid("Invalid team ID").optional(),
    departmentId: z.string().uuid("Invalid department ID").nullable().optional(),
    leadId: z.string().min(1).nullable().optional(),
    visibility: visibilitySchema.optional(),
    status: projectStatusSchema.optional(),
    startDate: z.string().date().nullable().optional(),
    targetDate: z.string().date().nullable().optional(),
    features: featuresSchema.optional(),
  }),
};

export const listProjectMembersSchema = {
  params: z.object({
    id: z.string().uuid("Invalid project ID"),
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

export const addProjectMembersSchema = {
  params: z.object({
    id: z.string().uuid("Invalid project ID"),
  }),
  body: z.object({
    userIds: z.array(z.string().min(1)).min(1).max(200),
  }),
};

export const removeProjectMemberSchema = {
  params: z.object({
    id: z.string().uuid("Invalid project ID"),
    uid: z.string().min(1, "User ID is required"),
  }),
};

export type CreateProjectInput = z.infer<typeof createProjectSchema.body>;
export type ListProjectsQuery = z.infer<typeof listProjectsSchema.query>;
export type UpdateProjectInput = z.infer<typeof updateProjectSchema.body>;
export type ListProjectMembersQuery = z.infer<typeof listProjectMembersSchema.query>;
export type AddProjectMembersInput = z.infer<typeof addProjectMembersSchema.body>;
