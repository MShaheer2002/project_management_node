import { z } from "zod";

export const helpSearchSchema = {
  query: z.object({
    q: z.string().trim().min(2, "Type at least 2 characters").max(300),
    route: z.string().trim().max(200).regex(/^\/[\w\-/]*$/, "Invalid route").optional(),
  }),
};

export const helpArticleParamsSchema = {
  params: z.object({
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Invalid article id").max(80),
  }),
};

export const helpInsightsSchema = {
  query: z.object({
    days: z.coerce.number().int().min(1).max(90).default(30),
  }),
};
