import { z } from "zod/v4";

const visibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);
const departmentSortSchema = z.enum(["name:asc", "name:desc", "createdAt:asc", "createdAt:desc"]);
const memberSortSchema = z.enum(["name:asc", "name:desc", "joinedAt:asc", "joinedAt:desc"]);
const viewSchema = z.enum(["compact", "full"]);
const colorSchema = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, "Color must be a valid hex code");

export const createDepartmentSchema = {
  body: z.object({
    name: z.string().min(1, "Department name is required").max(100).trim(),
    description: z.string().max(500).trim().optional(),
    headId: z.string().min(1, "Head is required").nullable().optional(),
    color: colorSchema.nullable().optional(),
    visibility: visibilitySchema.optional(),
    isDefault: z.boolean().optional(),
    memberIds: z.array(z.string().min(1)).max(100).optional(),
  }),
};

export const listDepartmentsSchema = {
  query: z.object({
    q: z.string().trim().max(100).optional(),
    cursor: z.string().uuid("Invalid department cursor").optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    sort: departmentSortSchema.optional(),
    visibility: visibilitySchema.optional(),
    headId: z.string().min(1).optional(),
    view: viewSchema.optional(),
  }),
};

export const departmentIdParamSchema = {
  params: z.object({
    id: z.string().uuid("Invalid department ID"),
  }),
};

export const updateDepartmentSchema = {
  params: z.object({
    id: z.string().uuid("Invalid department ID"),
  }),
  body: z.object({
    name: z.string().min(1).max(100).trim().optional(),
    description: z.string().max(500).trim().nullable().optional(),
    headId: z.string().min(1).nullable().optional(),
    color: colorSchema.nullable().optional(),
    visibility: visibilitySchema.optional(),
    isDefault: z.boolean().optional(),
  }),
};

export const listDepartmentMembersSchema = {
  params: z.object({
    id: z.string().uuid("Invalid department ID"),
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

export const addDepartmentMembersSchema = {
  params: z.object({
    id: z.string().uuid("Invalid department ID"),
  }),
  body: z.object({
    userIds: z.array(z.string().min(1)).min(1).max(100),
  }),
};

export const removeDepartmentMemberSchema = {
  params: z.object({
    id: z.string().uuid("Invalid department ID"),
    uid: z.string().min(1, "User ID is required"),
  }),
};

export type CreateDepartmentInput = z.infer<typeof createDepartmentSchema.body>;
export type ListDepartmentsQuery = z.infer<typeof listDepartmentsSchema.query>;
export type UpdateDepartmentInput = z.infer<typeof updateDepartmentSchema.body>;
export type ListDepartmentMembersQuery = z.infer<typeof listDepartmentMembersSchema.query>;
export type AddDepartmentMembersInput = z.infer<typeof addDepartmentMembersSchema.body>;
