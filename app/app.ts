/**
 * Express Application Setup
 *
 * This file configures the Express app with the global middleware stack.
 * Middleware order matters — it's applied top-to-bottom for every request:
 *
 * 1. Security headers (helmet)
 * 2. CORS policy
 * 3. Body parsing (JSON)
 * 4. Rate limiting (global)
 * 5. Request logging
 * 6. ─── Route mounting ───  (feature modules plug in here)
 * 7. 404 handler (unmatched routes)
 * 8. Global error handler (catches all thrown errors)
 *
 * Feature module routes are registered in the "Routes" section below.
 * Each module exports a router that is mounted at its base path.
 */

import express from "express";
import cors from "cors";
import helmet from "helmet";

import swaggerUi from "swagger-ui-express";
import { clerkMiddleware } from "@clerk/express";

import { corsConfig } from "../config/cors.js";
import { requestLogger } from "../shared/middleware/request-logger.js";
import { globalRateLimiter } from "../shared/middleware/rate-limiter.js";
import { notFound } from "../shared/middleware/not-found.js";
import { errorHandler } from "../shared/middleware/error-handler.js";
import { sendSuccess } from "../shared/utils/api-response.js";
import { prisma } from "../shared/utils/prisma.js";
import { openApiSpec } from "../docs/api/openapi.js";
import authRoutes from "../modules/auth/auth.routes.js";
import workspaceRoutes from "../modules/workspace/workspace.routes.js";
import invitationRoutes from "../modules/workspace/invitation.routes.js";
import dashboardRoutes from "../modules/dashboard/dashboard.routes.js";
import sidebarRoutes from "../modules/sidebar/sidebar.routes.js";
import departmentRoutes from "../modules/department/department.routes.js";
import teamRoutes from "../modules/team/team.routes.js";
import uploadRoutes from "../modules/upload/upload.routes.js";
import projectRoutes from "../modules/project/project.routes.js";
import issueRoutes from "../modules/issue/issue.routes.js";
import commentRoutes from "../modules/comment/comment.routes.js";
import labelRoutes from "../modules/label/label.routes.js";
import activityRoutes from "../modules/activity/activity.routes.js";
import notificationRoutes from "../modules/notification/notification.routes.js";
import cycleRoutes from "../modules/cycle/cycle.routes.js";
import templateRoutes from "../modules/template/template.routes.js";
import billingRoutes from "../modules/billing/billing.routes.js";
import analyticsRoutes from "../modules/analytics/analytics.routes.js";
import roadmapRoutes from "../modules/roadmap/roadmap.routes.js";
import documentsRoutes from "../modules/documents/documents.routes.js";
import apiKeyRoutes from "../modules/api-key/api-key.routes.js";
import integrationRoutes from "../modules/integration/integration\.routes\.js";
import webhookRoutes from "../modules/integration/webhooks/webhook.routes.js";

// ─── Create Express App ──────────────────────────────────────────────────────

const app = express();

// Trust proxy — required when behind reverse proxies (ngrok, Nginx, cloud load balancers).
// Allows express-rate-limit to correctly identify clients via X-Forwarded-For header.
app.set("trust proxy", 1);

// ─── Global Middleware Stack (order matters) ─────────────────────────────────

// 1. Security headers — prevents XSS, clickjacking, MIME sniffing, etc.
app.use(helmet());

// 2. CORS — only allow requests from our frontend origin
app.use(cors(corsConfig));

// Stripe webhook must receive the raw body for signature verification.
app.use("/webhooks/stripe", express.raw({ type: "application/json" }));

// 3. Body parsing — parse JSON request bodies (limit 10mb for rich text content)
app.use(express.json({ limit: "10mb" }));

// Slack sends slash commands as application/x-www-form-urlencoded
// Preserve raw body for Slack signature verification
app.use(express.urlencoded({
  extended: true,
  verify: (req: any, _res, buf) => {
    // Store raw body for Slack signature verification
    req.rawBody = buf.toString();
  },
}));

// 4. Rate limiting — 100 requests/min per IP (protects against abuse)
app.use(globalRateLimiter);

// 5. Request logging — logs method, URL, status, response time
app.use(requestLogger);

// 6. Clerk — parses session JWT from Authorization header (does NOT block unauthenticated requests)
// This makes getAuth(req) available in downstream middleware. It's permissive (non-blocking).
app.use(clerkMiddleware());

// ─── API Documentation (Swagger UI) ──────────────────────────────────────────

/**
 * GET /api-docs
 *
 * Serves the interactive Swagger UI for exploring and testing all API endpoints.
 * Only available in development — disabled in production to avoid exposing internals.
 * Visit http://localhost:8000/api-docs to browse the full API spec.
 */
app.use("/api-docs", swaggerUi.serve, swaggerUi.setup(openApiSpec, {
  customSiteTitle: "Project Management API Docs",
  customCss: ".swagger-ui .topbar { display: none }",
}));

/**
 * GET /api-docs.json
 *
 * Returns the raw OpenAPI spec as JSON.
 * Useful for importing into Postman, Insomnia, or code generators.
 */
app.get("/api-docs.json", (_req, res) => {
  res.json(openApiSpec);
});

// ─── Health Check ────────────────────────────────────────────────────────────

/**
 * GET /health
 *
 * Returns server status and database connectivity.
 * This endpoint is NOT behind auth — used by load balancers and uptime monitors.
 * Runs a lightweight query (SELECT 1) to verify the DB connection is alive.
 */
app.get("/health", async (_req, res, next) => {
  try {
    // Verify database connectivity with a simple query
    await prisma.$queryRaw`SELECT 1`;

    sendSuccess(res, 200, {
      status: "ok",
      db: "connected",
      uptime: Math.floor(process.uptime()),
    });
  } catch (error) {
    next(error);
  }
});

// ─── Feature Module Routes (mounted here as phases are built) ────────────────

// Phase 1: Auth (webhook + user profile)
app.use(authRoutes);

// Phase 2: Workspaces (multi-tenancy core)
app.use("/workspaces", workspaceRoutes);
app.use("/invitations", invitationRoutes);

// Dashboard aggregate (read-only workspace overview)
app.use("/dashboard", dashboardRoutes);

// Sidebar/app shell aggregate
app.use("/sidebar", sidebarRoutes);
app.use("/departments", departmentRoutes);
app.use("/teams", teamRoutes);
app.use("/uploads", uploadRoutes);
app.use("/projects", projectRoutes);
app.use("/issues", issueRoutes);
app.use(commentRoutes);
app.use(labelRoutes);
app.use(activityRoutes);
app.use(notificationRoutes);
app.use(cycleRoutes);
app.use(templateRoutes);
app.use(billingRoutes);
app.use(analyticsRoutes);
app.use(roadmapRoutes);
app.use(documentsRoutes);
app.use("/api-keys", apiKeyRoutes);
app.use("/integrations", integrationRoutes);
app.use("/webhooks", webhookRoutes);

// ─── Error Handling (must be LAST in the stack) ──────────────────────────────

// 6. 404 — catches any request that didn't match a route above
app.use(notFound);

// 7. Global error handler — catches all thrown/next(err) errors
app.use(errorHandler);

export default app;
