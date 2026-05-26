import { z } from "zod/v4";

export const listNotificationsSchema = {
  query: z.object({
    cursor: z.string().uuid().optional(),
    limit: z.coerce.number().int().min(1).max(100).optional(),
    unreadOnly: z.coerce.boolean().optional(),
    category: z.enum(["mention", "assignment", "update", "membership", "comment"]).optional(),
    types: z.string().trim().min(1).optional(),
    actorId: z.string().min(1).optional(),
    targetType: z.enum(["issue", "comment", "project", "team", "workspace"]).optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  }),
};

export const markNotificationReadSchema = {
  params: z.object({ id: z.string().uuid() }),
  body: z.object({ read: z.boolean().optional() }).optional(),
};

export const markNotificationsReadSchema = {
  body: z.object({
    ids: z.array(z.string().uuid()).min(1).max(100),
  }),
};

export type ListNotificationsQuery = z.infer<typeof listNotificationsSchema.query>;
export type MarkNotificationReadInput = z.infer<typeof markNotificationReadSchema.body>;
export type MarkNotificationsReadInput = z.infer<typeof markNotificationsReadSchema.body>;
