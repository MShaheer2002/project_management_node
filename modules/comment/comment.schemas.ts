import { z } from "zod/v4";
import { webLinkSchema } from "../../shared/utils/web-link.js";

const attachmentRefSchema = z.object({
  key: z.string().min(1),
  fileName: z.string().min(1).max(255),
  contentType: z.string().min(1),
  size: z.number().int().positive(),
  kind: z.enum(["attachment", "video"]),
  assetUrl: webLinkSchema.nullable().optional(),
});

export const issueCommentsParamsSchema = {
  params: z.object({
    id: z.string().min(1),
  }),
};

/** GET /issues/:id/mentionable-members — who the @-mention picker may suggest */
export const mentionableMembersSchema = {
  params: z.object({
    id: z.string().min(1),
  }),
  query: z.object({
    q: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(20).default(6),
  }),
};

export const createCommentSchema = {
  params: z.object({
    id: z.string().min(1),
  }),
  body: z.object({
    body: z.string().trim().min(1).max(20000),
    parentId: z.string().uuid().nullable().optional(),
    attachments: z.array(attachmentRefSchema).max(100).optional(),
  }),
};

export const listCommentsSchema = {
  params: z.object({
    id: z.string().min(1),
  }),
  query: z.object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
  }),
};

export const updateCommentSchema = {
  params: z.object({
    id: z.string().uuid(),
  }),
  body: z.object({
    body: z.string().trim().min(1).max(20000),
    attachments: z.array(attachmentRefSchema).max(100).optional(),
  }),
};

export const deleteCommentSchema = {
  params: z.object({
    id: z.string().uuid(),
  }),
};

export const createCommentAttachmentsSchema = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({
    attachments: z.array(attachmentRefSchema).min(1).max(100),
  }),
};

export const deleteCommentAttachmentParamsSchema = {
  params: z.object({ id: z.string().uuid(), attachmentId: z.string().uuid() }),
};

export type CreateCommentInput = z.infer<typeof createCommentSchema.body>;
export type ListCommentsQuery = z.infer<typeof listCommentsSchema.query>;
export type UpdateCommentInput = z.infer<typeof updateCommentSchema.body>;
