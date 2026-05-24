import { z } from "zod/v4";

const uploadKindSchema = z.enum([
  "workspace-logo",
  "avatar",
  "attachment",
  "video",
]);

const fileNameSchema = z
  .string()
  .trim()
  .min(1, "File name is required")
  .max(255, "File name must be at most 255 characters");

const contentTypeSchema = z
  .string()
  .trim()
  .min(1, "Content type is required")
  .max(100, "Content type must be at most 100 characters");

const fileSizeSchema = z.coerce
  .number()
  .int("File size must be an integer")
  .positive("File size must be greater than 0");

const singleUploadBodySchema = z.object({
  fileName: fileNameSchema,
  contentType: contentTypeSchema,
  size: fileSizeSchema,
  kind: uploadKindSchema,
});

const batchUploadFileSchema = singleUploadBodySchema.extend({
  clientId: z
    .string()
    .trim()
    .min(1, "Client ID is required")
    .max(100, "Client ID must be at most 100 characters")
    .optional(),
});

export const createPresignedUrlSchema = {
  body: singleUploadBodySchema,
};

export const createPresignedUrlsSchema = {
  body: z.object({
    files: z
      .array(batchUploadFileSchema)
      .min(1, "At least one file is required")
      .max(10, "You can request at most 10 presigned URLs at once"),
  }),
};

export const getViewUrlSchema = {
  query: z.object({
    key: z.string().trim().min(1, "Key is required").max(1024, "Key must be at most 1024 characters"),
  }),
};

export type UploadKind = z.infer<typeof uploadKindSchema>;
export type CreatePresignedUrlInput = z.infer<typeof singleUploadBodySchema>;
export type BatchUploadFileInput = z.infer<typeof batchUploadFileSchema>;
export type CreatePresignedUrlsInput = z.infer<typeof createPresignedUrlsSchema.body>;
export type GetViewUrlInput = z.infer<typeof getViewUrlSchema.query>;
