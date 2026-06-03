import type Stripe from "stripe";

import { prisma } from "../../shared/utils/prisma.js";
import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { env } from "../../config/env.js";
import { stripe } from "./stripe.service.js";
import type {
  ChangePlanInput,
  CreateSubscriptionInput,
} from "./billing.schemas.js";
import type {
  Prisma,
  SubscriptionPlan,
  SubscriptionStatus,
  WorkspaceRole,
} from "../../app/generated/prisma/client.js";

const PRORATION_NOTICE =
  "Seat changes during the billing period may create prorated charges or credits on the current or next invoice.";

const GIGABYTE = 1024 * 1024 * 1024;

function toSubscriptionPlan(plan: CreateSubscriptionInput["plan"] | ChangePlanInput["plan"]): SubscriptionPlan {
  return plan === "standard" ? "STANDARD" : "PREMIUM";
}

function getPriceIdForPlan(plan: SubscriptionPlan) {
  switch (plan) {
    case "STANDARD":
      return env.STRIPE_STANDARD_MONTHLY_PRICE_ID;
    case "PREMIUM":
      return env.STRIPE_PREMIUM_MONTHLY_PRICE_ID;
    default:
      throw new AppError(400, ERROR_CODES.BILLING_INVALID_PLAN, "Free plan does not use a Stripe price");
  }
}

function getEntitlements(plan: SubscriptionPlan) {
  switch (plan) {
    case "FREE":
      return {
        aiEnabled: false,
        memberInviteCap: 10,
        storageLimitBytes: 2 * GIGABYTE,
        paidSeatBilling: false,
      };
    case "STANDARD":
      return {
        aiEnabled: false,
        memberInviteCap: null,
        storageLimitBytes: 50 * GIGABYTE,
        paidSeatBilling: true,
      };
    case "PREMIUM":
      return {
        aiEnabled: true,
        memberInviteCap: null,
        storageLimitBytes: null,
        paidSeatBilling: true,
      };
  }
}

function hasPaidAccess(status: SubscriptionStatus) {
  return status === "ACTIVE" || status === "TRIALING" || status === "PAST_DUE";
}

function getAccessPlan(plan: SubscriptionPlan, status: SubscriptionStatus): SubscriptionPlan {
  return hasPaidAccess(status) ? plan : "FREE";
}

function mapStripeStatus(status: Stripe.Subscription.Status): SubscriptionStatus {
  switch (status) {
    case "active":
      return "ACTIVE";
    case "trialing":
      return "TRIALING";
    case "past_due":
      return "PAST_DUE";
    case "canceled":
      return "CANCELED";
    case "incomplete":
      return "INCOMPLETE";
    case "unpaid":
      return "UNPAID";
    default:
      return "INCOMPLETE";
  }
}

function planFromPriceId(priceId: string | null | undefined): SubscriptionPlan {
  if (priceId === env.STRIPE_STANDARD_MONTHLY_PRICE_ID) {
    return "STANDARD";
  }

  if (priceId === env.STRIPE_PREMIUM_MONTHLY_PRICE_ID) {
    return "PREMIUM";
  }

  throw new AppError(
    409,
    ERROR_CODES.BILLING_UNKNOWN_PRICE_ID,
    "Stripe subscription is using an unknown price ID. Update the configured price mapping before syncing billing state.",
  );
}

function mapInvoiceStatus(status: Stripe.Invoice.Status | null): "PAID" | "UNPAID" | "VOID" {
  if (status === "paid") {
    return "PAID";
  }

  if (status === "void" || status === "uncollectible") {
    return "VOID";
  }

  return "UNPAID";
}

async function getSubscriptionRecord(workspaceId: string) {
  const subscription = await prisma.subscription.findUnique({
    where: { workspaceId },
  });

  if (!subscription) {
    throw new AppError(404, ERROR_CODES.SUBSCRIPTION_NOT_FOUND, "Workspace subscription not found");
  }

  return subscription;
}

async function ensureStripeCustomer(workspaceId: string, ownerUserId?: string) {
  const subscription = await getSubscriptionRecord(workspaceId);

  if (subscription.stripeCustomerId) {
    return subscription.stripeCustomerId;
  }

  const workspace = await prisma.workspace.findUnique({
    where: { id: workspaceId },
    select: {
      id: true,
      name: true,
      slug: true,
      memberships: {
        where: { role: "OWNER" },
        select: { userId: true },
        take: 1,
      },
    },
  });

  if (!workspace) {
    throw new AppError(404, ERROR_CODES.WORKSPACE_NOT_FOUND, "Workspace not found");
  }

  const customer = await stripe.customers.create({
    name: workspace.name,
    metadata: {
      workspaceId: workspace.id,
      workspaceSlug: workspace.slug,
      ownerUserId: ownerUserId ?? workspace.memberships[0]?.userId ?? "",
    },
  });

  await prisma.subscription.update({
    where: { workspaceId },
    data: { stripeCustomerId: customer.id },
  });

  return customer.id;
}

function getPaymentMethodCardMetadata(paymentMethod: Stripe.PaymentMethod) {
  if (paymentMethod.type !== "card" || !paymentMethod.card) {
    throw new AppError(422, ERROR_CODES.BILLING_PAYMENT_METHOD_INVALID, "Only card payment methods are supported");
  }

  return {
    brand: paymentMethod.card.brand,
    last4: paymentMethod.card.last4,
    expiryMonth: paymentMethod.card.exp_month,
    expiryYear: paymentMethod.card.exp_year,
  };
}

async function getDefaultPaymentMethodRecord(workspaceId: string) {
  const paymentMethod = await prisma.paymentMethod.findFirst({
    where: {
      workspaceId,
      isDefault: true,
      isActive: true,
    },
  });

  if (!paymentMethod?.stripePaymentMethodId) {
    throw new AppError(
      409,
      ERROR_CODES.BILLING_NO_DEFAULT_PAYMENT_METHOD,
      "A default payment method is required before creating or updating a paid subscription",
    );
  }

  return paymentMethod;
}

async function updateWorkspaceSubscriptionFromStripe(
  workspaceId: string,
  stripeSubscription: Stripe.Subscription,
  seatCount: number,
) {
  const item = stripeSubscription.items.data[0];
  const priceId =
    typeof item?.price === "string" ? item.price : item?.price?.id ?? null;

  await prisma.subscription.update({
    where: { workspaceId },
    data: {
      plan: planFromPriceId(priceId),
      status: mapStripeStatus(stripeSubscription.status),
      billingCycle: "MONTHLY",
      currentPeriodStart: stripeSubscription.items.data[0]?.current_period_start
        ? new Date(stripeSubscription.items.data[0].current_period_start * 1000)
        : null,
      currentPeriodEnd: stripeSubscription.items.data[0]?.current_period_end
        ? new Date(stripeSubscription.items.data[0].current_period_end * 1000)
        : null,
      cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end,
      stripeCustomerId:
        typeof stripeSubscription.customer === "string"
          ? stripeSubscription.customer
          : stripeSubscription.customer.id,
      stripeSubscriptionId: stripeSubscription.id,
      stripeSubscriptionItemId: item?.id ?? null,
      stripePriceId: priceId,
      seatCount,
    },
  });
}

function logBillingSyncFailure(action: string, workspaceId: string, error: unknown) {
  console.error("[Billing] Non-fatal sync failure", {
    action,
    workspaceId,
    error,
  });
}

async function countAcceptedMembers(workspaceId: string) {
  return prisma.workspaceMembership.count({ where: { workspaceId } });
}

async function countPendingInvitations(workspaceId: string) {
  return prisma.workspaceInvitation.count({
    where: { workspaceId, status: "PENDING" },
  });
}

async function upsertInvoiceFromStripe(
  workspaceId: string,
  stripeInvoice: Stripe.Invoice,
) {
  const localSubscription = await prisma.subscription.findUnique({
    where: { workspaceId },
    select: { id: true },
  });

  const amount = stripeInvoice.amount_paid > 0 ? stripeInvoice.amount_paid : stripeInvoice.amount_due;

  await prisma.invoice.upsert({
    where: {
      workspaceId_invoiceNumber: {
        workspaceId,
        invoiceNumber: stripeInvoice.number ?? stripeInvoice.id,
      },
    },
    update: {
      subscriptionId: localSubscription?.id ?? null,
      stripeInvoiceId: stripeInvoice.id,
      amount,
      currency: stripeInvoice.currency ?? "usd",
      status: mapInvoiceStatus(stripeInvoice.status),
      hostedInvoiceUrl: stripeInvoice.hosted_invoice_url ?? null,
      pdfUrl: stripeInvoice.invoice_pdf ?? null,
      issuedAt: stripeInvoice.created
        ? new Date(stripeInvoice.created * 1000)
        : new Date(),
      paidAt:
        stripeInvoice.status_transitions.paid_at != null
          ? new Date(stripeInvoice.status_transitions.paid_at * 1000)
          : null,
    },
    create: {
      workspaceId,
      subscriptionId: localSubscription?.id ?? null,
      invoiceNumber: stripeInvoice.number ?? stripeInvoice.id,
      stripeInvoiceId: stripeInvoice.id,
      amount,
      currency: stripeInvoice.currency ?? "usd",
      status: mapInvoiceStatus(stripeInvoice.status),
      hostedInvoiceUrl: stripeInvoice.hosted_invoice_url ?? null,
      pdfUrl: stripeInvoice.invoice_pdf ?? null,
      issuedAt: stripeInvoice.created
        ? new Date(stripeInvoice.created * 1000)
        : new Date(),
      paidAt:
        stripeInvoice.status_transitions.paid_at != null
          ? new Date(stripeInvoice.status_transitions.paid_at * 1000)
          : null,
    },
  });
}

function getExpandedInvoicePaymentIntent(
  invoice: unknown,
): Stripe.PaymentIntent | null {
  const maybeInvoice = invoice as {
    payment_intent?: string | Stripe.PaymentIntent | null;
  } | null;

  if (!maybeInvoice?.payment_intent || typeof maybeInvoice.payment_intent === "string") {
    return null;
  }

  return maybeInvoice.payment_intent;
}

function extractPaymentIntentId(invoice: unknown): string | null {
  const paymentIntent = getExpandedInvoicePaymentIntent(invoice);

  if (paymentIntent) {
    return paymentIntent.id;
  }

  const maybeInvoice = invoice as {
    payment_intent?: string | Stripe.PaymentIntent | null;
  } | null;

  if (typeof maybeInvoice?.payment_intent === "string") {
    return maybeInvoice.payment_intent;
  }

  return null;
}

export async function createInitialWorkspaceSubscription(
  tx: Prisma.TransactionClient,
  workspaceId: string,
) {
  await tx.subscription.create({
    data: {
      workspaceId,
      plan: "FREE",
      status: "ACTIVE",
      billingCycle: "MONTHLY",
      seatCount: 1,
    },
  });
}

export async function enforceFreeWorkspaceCapacity(workspaceId: string, email?: string) {
  const subscription = await getSubscriptionRecord(workspaceId);

  if (subscription.plan !== "FREE") {
    return;
  }

  const normalizedEmail = email?.trim().toLowerCase();
  const [acceptedMembers, pendingInvitations] = await Promise.all([
    countAcceptedMembers(workspaceId),
    prisma.workspaceInvitation.count({
      where: {
        workspaceId,
        status: "PENDING",
        ...(normalizedEmail ? { email: { not: normalizedEmail } } : {}),
      },
    }),
  ]);

  if (acceptedMembers + pendingInvitations >= 10) {
    throw new AppError(
      409,
      ERROR_CODES.FREE_PLAN_MEMBER_LIMIT_REACHED,
      "Free plan supports up to 10 workspace members and pending invites combined. Upgrade to Standard or Premium to continue.",
    );
  }
}

export async function syncPaidSeatQuantity(workspaceId: string) {
  const subscription = await getSubscriptionRecord(workspaceId);
  const seatCount = await countAcceptedMembers(workspaceId);

  await prisma.subscription.update({
    where: { workspaceId },
    data: { seatCount },
  });

  if (subscription.plan === "FREE" || !subscription.stripeSubscriptionId || !subscription.stripeSubscriptionItemId) {
    return;
  }

  const updatedStripeSubscription = await stripe.subscriptions.update(
    subscription.stripeSubscriptionId,
    {
      items: [
        {
          id: subscription.stripeSubscriptionItemId,
          quantity: seatCount,
          price: subscription.stripePriceId ?? getPriceIdForPlan(subscription.plan),
        },
      ],
      proration_behavior: "create_prorations",
    },
  );

  await updateWorkspaceSubscriptionFromStripe(workspaceId, updatedStripeSubscription, seatCount);
}

export async function getBillingOverview(workspaceId: string, role: WorkspaceRole) {
  const subscription = await getSubscriptionRecord(workspaceId);
  const accessPlan = getAccessPlan(subscription.plan, subscription.status);
  const entitlements = getEntitlements(accessPlan);

  return {
    plan: subscription.plan,
    accessPlan,
    status: subscription.status,
    billingCycle: subscription.billingCycle,
    seatCount: subscription.seatCount,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    entitlements,
    permissions: {
      canViewBilling: role === "OWNER" || role === "ADMIN",
      canManageBilling: role === "OWNER",
    },
    prorationNotice: PRORATION_NOTICE,
  };
}

export async function getSubscriptionPaymentStatus(workspaceId: string) {
  const subscription = await getSubscriptionRecord(workspaceId);
  const accessPlan = getAccessPlan(subscription.plan, subscription.status);

  let paymentIntentClientSecret: string | null = null;
  let paymentIntentStatus: Stripe.PaymentIntent.Status | null = null;

  if (subscription.stripePaymentIntentId) {
    try {
      const paymentIntent = await stripe.paymentIntents.retrieve(
        subscription.stripePaymentIntentId,
      );
      paymentIntentClientSecret = paymentIntent.client_secret ?? null;
      paymentIntentStatus = paymentIntent.status;
    } catch (error) {
      logBillingSyncFailure("payment_intent_status_lookup", workspaceId, error);
    }
  }

  const requiresAction =
    paymentIntentStatus === "requires_action" ||
    paymentIntentStatus === "requires_confirmation" ||
    subscription.status === "INCOMPLETE";

  return {
    plan: subscription.plan,
    accessPlan,
    status: subscription.status,
    hasPaidAccess: hasPaidAccess(subscription.status),
    paymentIntentId: subscription.stripePaymentIntentId,
    paymentIntentStatus,
    clientSecret: paymentIntentClientSecret,
    requiresAction,
    prorationNotice: PRORATION_NOTICE,
  };
}

export async function createSetupIntent(workspaceId: string, ownerUserId: string) {
  const customerId = await ensureStripeCustomer(workspaceId, ownerUserId);

  const setupIntent = await stripe.setupIntents.create({
    customer: customerId,
    usage: "off_session",
    payment_method_types: ["card"],
    metadata: {
      workspaceId,
      ownerUserId,
    },
  });

  return {
    clientSecret: setupIntent.client_secret,
    setupIntentId: setupIntent.id,
  };
}

export async function listPaymentMethods(workspaceId: string) {
  const paymentMethods = await prisma.paymentMethod.findMany({
    where: { workspaceId, isActive: true },
    orderBy: [{ isDefault: "desc" }, { createdAt: "asc" }],
    select: {
      id: true,
      brand: true,
      last4: true,
      expiryMonth: true,
      expiryYear: true,
      isDefault: true,
      createdAt: true,
    },
  });

  return paymentMethods.map((paymentMethod) => ({
    id: paymentMethod.id,
    brand: paymentMethod.brand,
    last4: paymentMethod.last4,
    expiryMonth: paymentMethod.expiryMonth,
    expiryYear: paymentMethod.expiryYear,
    isDefault: paymentMethod.isDefault,
    createdAt: paymentMethod.createdAt,
  }));
}

export async function syncPaidSeatQuantityBestEffort(workspaceId: string) {
  try {
    await syncPaidSeatQuantity(workspaceId);
  } catch (error) {
    logBillingSyncFailure("seat_quantity_sync", workspaceId, error);
  }
}

export async function attachPaymentMethod(
  workspaceId: string,
  ownerUserId: string,
  paymentMethodId: string,
) {
  const customerId = await ensureStripeCustomer(workspaceId, ownerUserId);

  const existing = await prisma.paymentMethod.findUnique({
    where: { stripePaymentMethodId: paymentMethodId },
  });

  if (existing && existing.workspaceId !== workspaceId) {
    throw new AppError(409, ERROR_CODES.CONFLICT, "This payment method is already attached to another workspace");
  }

  const paymentMethod = await stripe.paymentMethods.attach(paymentMethodId, {
    customer: customerId,
  });
  const card = getPaymentMethodCardMetadata(paymentMethod);

  const defaultMethod = await prisma.paymentMethod.findFirst({
    where: { workspaceId, isDefault: true, isActive: true },
    select: { id: true },
  });

  const shouldBeDefault = !defaultMethod;

  const saved = await prisma.paymentMethod.upsert({
    where: { stripePaymentMethodId: paymentMethod.id },
    update: {
      type: "CARD",
      brand: card.brand,
      last4: card.last4,
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      isDefault: shouldBeDefault,
      isActive: true,
    },
    create: {
      workspaceId,
      type: "CARD",
      brand: card.brand,
      last4: card.last4,
      expiryMonth: card.expiryMonth,
      expiryYear: card.expiryYear,
      stripePaymentMethodId: paymentMethod.id,
      isDefault: shouldBeDefault,
      isActive: true,
    },
  });

  if (shouldBeDefault) {
    await stripe.customers.update(customerId, {
      invoice_settings: {
        default_payment_method: paymentMethod.id,
      },
    });
  }

  return {
    id: saved.id,
    brand: saved.brand,
    last4: saved.last4,
    expiryMonth: saved.expiryMonth,
    expiryYear: saved.expiryYear,
    isDefault: saved.isDefault,
  };
}

export async function setDefaultPaymentMethod(workspaceId: string, paymentMethodId: string) {
  const subscription = await getSubscriptionRecord(workspaceId);

  if (!subscription.stripeCustomerId) {
    throw new AppError(409, ERROR_CODES.STRIPE_CUSTOMER_MISSING, "Stripe customer is missing for this workspace");
  }

  const paymentMethod = await prisma.paymentMethod.findFirst({
    where: {
      workspaceId,
      stripePaymentMethodId: paymentMethodId,
      isActive: true,
    },
  });

  if (!paymentMethod) {
    throw new AppError(404, ERROR_CODES.PAYMENT_METHOD_NOT_FOUND, "Payment method not found");
  }

  await stripe.customers.update(subscription.stripeCustomerId, {
    invoice_settings: {
      default_payment_method: paymentMethodId,
    },
  });

  if (subscription.stripeSubscriptionId) {
    await stripe.subscriptions.update(subscription.stripeSubscriptionId, {
      default_payment_method: paymentMethodId,
    });
  }

  await prisma.$transaction([
    prisma.paymentMethod.updateMany({
      where: { workspaceId },
      data: { isDefault: false },
    }),
    prisma.paymentMethod.update({
      where: { id: paymentMethod.id },
      data: { isDefault: true },
    }),
  ]);

  return { paymentMethodId };
}

export async function removePaymentMethod(workspaceId: string, id: string) {
  const subscription = await getSubscriptionRecord(workspaceId);
  const paymentMethod = await prisma.paymentMethod.findFirst({
    where: {
      id,
      workspaceId,
      isActive: true,
    },
  });

  if (!paymentMethod?.stripePaymentMethodId) {
    throw new AppError(404, ERROR_CODES.PAYMENT_METHOD_NOT_FOUND, "Payment method not found");
  }

  const replacement = await prisma.paymentMethod.findFirst({
    where: {
      workspaceId,
      isActive: true,
      id: { not: paymentMethod.id },
    },
    orderBy: { createdAt: "asc" },
  });

  if (
    paymentMethod.isDefault &&
    subscription.plan !== "FREE" &&
    ["ACTIVE", "TRIALING", "PAST_DUE", "INCOMPLETE"].includes(subscription.status) &&
    !replacement
  ) {
    throw new AppError(
      409,
      ERROR_CODES.PAYMENT_METHOD_IN_USE,
      "Add another active card before removing the default payment method for a paid workspace",
    );
  }

  if (paymentMethod.isDefault && replacement?.stripePaymentMethodId) {
    await setDefaultPaymentMethod(workspaceId, replacement.stripePaymentMethodId);
  }

  await stripe.paymentMethods.detach(paymentMethod.stripePaymentMethodId);

  await prisma.paymentMethod.update({
    where: { id: paymentMethod.id },
    data: {
      isActive: false,
      isDefault: false,
    },
  });
}

export async function createSubscription(
  workspaceId: string,
  ownerUserId: string,
  input: CreateSubscriptionInput,
) {
  const subscription = await getSubscriptionRecord(workspaceId);

  if (subscription.plan !== "FREE" && subscription.stripeSubscriptionId) {
    throw new AppError(409, ERROR_CODES.BILLING_ALREADY_ON_PLAN, "Workspace already has a paid subscription");
  }

  const targetPlan = toSubscriptionPlan(input.plan);
  const defaultPaymentMethod = await getDefaultPaymentMethodRecord(workspaceId);
  const customerId = await ensureStripeCustomer(workspaceId, ownerUserId);
  const seatCount = await countAcceptedMembers(workspaceId);

  const stripeSubscription = await stripe.subscriptions.create({
    customer: customerId,
    default_payment_method: defaultPaymentMethod.stripePaymentMethodId!,
    payment_behavior: "default_incomplete",
    payment_settings: {
      save_default_payment_method: "on_subscription",
    },
    proration_behavior: "create_prorations",
    items: [
      {
        price: getPriceIdForPlan(targetPlan),
        quantity: seatCount,
      },
    ],
    metadata: {
      workspaceId,
      ownerUserId,
    },
    expand: ["latest_invoice.payment_intent"],
  });

  await updateWorkspaceSubscriptionFromStripe(workspaceId, stripeSubscription, seatCount);

  const latestInvoice = stripeSubscription.latest_invoice;
  const paymentIntent =
    latestInvoice && typeof latestInvoice !== "string"
      ? getExpandedInvoicePaymentIntent(latestInvoice)
      : null;

  await prisma.subscription.update({
    where: { workspaceId },
    data: {
      stripePaymentIntentId: paymentIntent?.id ?? extractPaymentIntentId(latestInvoice),
    },
  });

  return {
    subscriptionId: stripeSubscription.id,
    status: mapStripeStatus(stripeSubscription.status),
    paymentIntentId: paymentIntent?.id ?? extractPaymentIntentId(latestInvoice),
    clientSecret: paymentIntent?.client_secret ?? null,
    requiresAction: paymentIntent != null && stripeSubscription.status === "incomplete",
    seatCount,
    prorationNotice: PRORATION_NOTICE,
  };
}

export async function changePlan(
  workspaceId: string,
  ownerUserId: string,
  input: ChangePlanInput,
) {
  const subscription = await getSubscriptionRecord(workspaceId);

  if (!subscription.stripeSubscriptionId || !subscription.stripeSubscriptionItemId) {
    throw new AppError(404, ERROR_CODES.STRIPE_SUBSCRIPTION_MISSING, "Stripe subscription not found for this workspace");
  }

  const targetPlan = toSubscriptionPlan(input.plan);

  if (subscription.plan === targetPlan) {
    throw new AppError(409, ERROR_CODES.BILLING_ALREADY_ON_PLAN, "Workspace is already on this plan");
  }

  await ensureStripeCustomer(workspaceId, ownerUserId);
  const defaultPaymentMethod = await getDefaultPaymentMethodRecord(workspaceId);
  const seatCount = await countAcceptedMembers(workspaceId);

  const stripeSubscription = await stripe.subscriptions.update(
    subscription.stripeSubscriptionId,
    {
      default_payment_method: defaultPaymentMethod.stripePaymentMethodId!,
      items: [
        {
          id: subscription.stripeSubscriptionItemId,
          price: getPriceIdForPlan(targetPlan),
          quantity: seatCount,
        },
      ],
      proration_behavior: "create_prorations",
      expand: ["latest_invoice.payment_intent"],
    },
  );

  await updateWorkspaceSubscriptionFromStripe(workspaceId, stripeSubscription, seatCount);

  const latestInvoice = stripeSubscription.latest_invoice;
  const paymentIntent =
    latestInvoice && typeof latestInvoice !== "string"
      ? getExpandedInvoicePaymentIntent(latestInvoice)
      : null;

  await prisma.subscription.update({
    where: { workspaceId },
    data: {
      stripePaymentIntentId: paymentIntent?.id ?? extractPaymentIntentId(latestInvoice),
    },
  });

  return {
    subscriptionId: stripeSubscription.id,
    status: mapStripeStatus(stripeSubscription.status),
    paymentIntentId: paymentIntent?.id ?? extractPaymentIntentId(latestInvoice),
    clientSecret: paymentIntent?.client_secret ?? null,
    requiresAction: paymentIntent != null && stripeSubscription.status === "incomplete",
    seatCount,
    prorationNotice: PRORATION_NOTICE,
  };
}

export async function cancelSubscription(workspaceId: string) {
  const subscription = await getSubscriptionRecord(workspaceId);

  if (!subscription.stripeSubscriptionId) {
    throw new AppError(404, ERROR_CODES.STRIPE_SUBSCRIPTION_MISSING, "Stripe subscription not found for this workspace");
  }

  const stripeSubscription = await stripe.subscriptions.update(
    subscription.stripeSubscriptionId,
    {
      cancel_at_period_end: true,
    },
  );

  await updateWorkspaceSubscriptionFromStripe(workspaceId, stripeSubscription, subscription.seatCount);

  return {
    cancelAtPeriodEnd: true,
    currentPeriodEnd: stripeSubscription.items.data[0]?.current_period_end
      ? new Date(stripeSubscription.items.data[0].current_period_end * 1000)
      : subscription.currentPeriodEnd,
  };
}

export async function listInvoices(workspaceId: string) {
  const invoices = await prisma.invoice.findMany({
    where: { workspaceId },
    orderBy: { issuedAt: "desc" },
    select: {
      id: true,
      invoiceNumber: true,
      amount: true,
      currency: true,
      status: true,
      hostedInvoiceUrl: true,
      pdfUrl: true,
      issuedAt: true,
      paidAt: true,
      stripeInvoiceId: true,
    },
  });

  return invoices;
}

function getEventWorkspaceId(event: Stripe.Event): string | null {
  const object = event.data.object as unknown as Record<string, unknown> & {
    metadata?: Record<string, string>;
    customer?: string;
    subscription?: string;
  };

  return object.metadata?.["workspaceId"] ?? null;
}

async function resolveWorkspaceIdForEvent(event: Stripe.Event) {
  const metadataWorkspaceId = getEventWorkspaceId(event);

  if (metadataWorkspaceId) {
    return metadataWorkspaceId;
  }

  const object = event.data.object as unknown as Record<string, unknown> & {
    customer?: string | Stripe.Customer | Stripe.DeletedCustomer | null;
    subscription?: string | Stripe.Subscription | null;
    id?: string;
  };

  const customerId =
    typeof object.customer === "string"
      ? object.customer
      : object.customer?.id;
  const subscriptionId =
    typeof object.subscription === "string"
      ? object.subscription
      : object.subscription?.id;

  const subscription = await prisma.subscription.findFirst({
    where: {
      OR: [
        ...(customerId ? [{ stripeCustomerId: customerId }] : []),
        ...(subscriptionId ? [{ stripeSubscriptionId: subscriptionId }] : []),
        ...(event.type.startsWith("payment_intent.") && typeof object.id === "string"
          ? [{ stripePaymentIntentId: object.id }]
          : []),
      ],
    },
    select: { workspaceId: true },
  });

  return subscription?.workspaceId ?? null;
}

export async function handleStripeWebhook(rawBody: Buffer, signature: string) {
  let event: Stripe.Event;

  try {
    event = stripe.webhooks.constructEvent(rawBody, signature, env.STRIPE_WEBHOOK_SECRET);
  } catch {
    throw new AppError(400, ERROR_CODES.STRIPE_WEBHOOK_INVALID_SIGNATURE, "Invalid Stripe webhook signature");
  }

  const existingEvent = await prisma.billingWebhookEvent.findUnique({
    where: { stripeEventId: event.id },
    select: { id: true, processed: true },
  });

  if (existingEvent?.processed) {
    return { received: true, duplicate: true };
  }

  const workspaceId = await resolveWorkspaceIdForEvent(event);

  await prisma.billingWebhookEvent.upsert({
    where: { stripeEventId: event.id },
    update: {
      type: event.type,
      workspaceId,
      payload: event as unknown as Prisma.InputJsonValue,
    },
    create: {
      stripeEventId: event.id,
      type: event.type,
      workspaceId,
      payload: event as unknown as Prisma.InputJsonValue,
    },
  });

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted": {
      if (workspaceId) {
        const stripeSubscription = event.data.object as Stripe.Subscription;
        const seatCount = stripeSubscription.items.data[0]?.quantity ?? 1;
        await updateWorkspaceSubscriptionFromStripe(workspaceId, stripeSubscription, seatCount);
      }
      break;
    }

    case "invoice.paid":
    case "invoice.payment_failed": {
      if (workspaceId) {
        const stripeInvoice = event.data.object as Stripe.Invoice;
        await upsertInvoiceFromStripe(workspaceId, stripeInvoice);
        const paymentIntentId = extractPaymentIntentId(stripeInvoice);

        if (paymentIntentId) {
          await prisma.subscription.update({
            where: { workspaceId },
            data: { stripePaymentIntentId: paymentIntentId },
          });
        }

        const subscriptionId = (
          stripeInvoice as unknown as {
            subscription?: string | Stripe.Subscription | null;
          }
        ).subscription;

        if (subscriptionId && typeof subscriptionId === "string") {
          const stripeSubscription = await stripe.subscriptions.retrieve(subscriptionId);
          const seatCount = stripeSubscription.items.data[0]?.quantity ?? 1;
          await updateWorkspaceSubscriptionFromStripe(workspaceId, stripeSubscription, seatCount);
        }
      }
      break;
    }

    case "invoice.payment_action_required": {
      if (workspaceId) {
        const stripeInvoice = event.data.object as Stripe.Invoice;
        await upsertInvoiceFromStripe(workspaceId, stripeInvoice);
        const paymentIntentId = extractPaymentIntentId(stripeInvoice);

        await prisma.subscription.update({
          where: { workspaceId },
          data: {
            status: "INCOMPLETE",
            stripePaymentIntentId: paymentIntentId,
          },
        });
      }
      break;
    }

    case "payment_intent.requires_action":
    case "payment_intent.payment_failed": {
      if (workspaceId) {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        await prisma.subscription.update({
          where: { workspaceId },
          data: {
            status: "INCOMPLETE",
            stripePaymentIntentId: paymentIntent.id,
          },
        });
      }
      break;
    }

    case "payment_intent.succeeded": {
      if (workspaceId) {
        const paymentIntent = event.data.object as Stripe.PaymentIntent;
        const subscription = await prisma.subscription.findUnique({
          where: { workspaceId },
          select: { stripeSubscriptionId: true },
        });

        if (subscription?.stripeSubscriptionId) {
          const stripeSubscription = await stripe.subscriptions.retrieve(
            subscription.stripeSubscriptionId,
          );
          const seatCount = stripeSubscription.items.data[0]?.quantity ?? 1;
          await updateWorkspaceSubscriptionFromStripe(workspaceId, stripeSubscription, seatCount);
        }

        await prisma.subscription.update({
          where: { workspaceId },
          data: { stripePaymentIntentId: paymentIntent.id },
        });
      }
      break;
    }

    case "payment_method.attached": {
      if (workspaceId) {
        const paymentMethod = event.data.object as Stripe.PaymentMethod;
        const card = getPaymentMethodCardMetadata(paymentMethod);
        await prisma.paymentMethod.upsert({
          where: { stripePaymentMethodId: paymentMethod.id },
          update: {
            brand: card.brand,
            last4: card.last4,
            expiryMonth: card.expiryMonth,
            expiryYear: card.expiryYear,
            isActive: true,
          },
          create: {
            workspaceId,
            type: "CARD",
            stripePaymentMethodId: paymentMethod.id,
            brand: card.brand,
            last4: card.last4,
            expiryMonth: card.expiryMonth,
            expiryYear: card.expiryYear,
            isDefault: false,
            isActive: true,
          },
        });
      }
      break;
    }

    case "payment_method.detached": {
      const paymentMethod = event.data.object as Stripe.PaymentMethod;
        await prisma.paymentMethod.updateMany({
          where: { stripePaymentMethodId: paymentMethod.id },
          data: { isActive: false, isDefault: false },
        });
      break;
    }

    default:
      break;
  }

  await prisma.billingWebhookEvent.update({
    where: { stripeEventId: event.id },
    data: { processed: true, workspaceId },
  });

  return { received: true, duplicate: false };
}
