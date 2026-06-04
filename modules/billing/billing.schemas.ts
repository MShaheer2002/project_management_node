import { z } from "zod/v4";

const billingPlanInputSchema = z.enum(["standard", "premium"]);
const billingCycleInputSchema = z.enum(["monthly"]);

export const createSubscriptionSchema = {
  body: z.object({
    plan: billingPlanInputSchema,
    billingCycle: billingCycleInputSchema.default("monthly"),
  }),
};

export const changePlanSchema = {
  body: z.object({
    plan: billingPlanInputSchema,
  }),
};

export const setDefaultPaymentMethodSchema = {
  body: z.object({
    paymentMethodId: z.string().min(1, "paymentMethodId is required"),
  }),
};

export const attachPaymentMethodSchema = {
  body: z.object({
    paymentMethodId: z.string().min(1, "paymentMethodId is required"),
  }),
};

export const removePaymentMethodSchema = {
  params: z.object({
    id: z.string().uuid("Invalid payment method ID"),
  }),
};

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema.body>;
export type ChangePlanInput = z.infer<typeof changePlanSchema.body>;
export type AttachPaymentMethodInput = z.infer<typeof attachPaymentMethodSchema.body>;
export type SetDefaultPaymentMethodInput = z.infer<typeof setDefaultPaymentMethodSchema.body>;
