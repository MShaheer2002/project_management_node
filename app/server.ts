/**
 * Server Entry Point
 *
 * This file starts the HTTP server. Before listening, it:
 *   1. Validates environment variables (via config/env.ts import)
 *   2. Verifies database connectivity (ensures Prisma can reach PostgreSQL)
 *   3. Starts listening on the configured PORT
 *
 * It also handles graceful shutdown:
 *   - On SIGTERM/SIGINT (e.g., Ctrl+C, Docker stop, Kubernetes pod termination)
 *   - Closes the HTTP server (stops accepting new connections)
 *   - Disconnects Prisma (releases DB connection pool)
 *   - Exits cleanly
 *
 * This ensures no orphaned connections or in-flight requests are dropped abruptly.
 */

import { createServer } from "node:http";

import app from "./app.js";
import { env } from "../config/env.js";
import { prisma } from "../shared/utils/prisma.js";
import { initializeSocket } from "../socket/index.js";

// ─── Start Server ────────────────────────────────────────────────────────────

async function start() {
  try {
    // Verify database connection before accepting any requests
    await prisma.$queryRaw`SELECT 1`;
    console.log("✅ Database connected");

    // Start the HTTP server
    const httpServer = createServer(app);
    initializeSocket(httpServer);

    httpServer.listen(env.PORT, () => {
      console.log(
        `Server running on port ${env.PORT} (${env.NODE_ENV} mode)`,
      );
    });

    // ─── Graceful Shutdown ─────────────────────────────────────────────────

    /**
     * Handles process termination signals.
     * Called on Ctrl+C (SIGINT) or Docker/K8s stop (SIGTERM).
     * Ensures we clean up resources before the process exits.
     */
    async function shutdown(signal: string) {
      console.log(`\n⏳ Received ${signal}. Shutting down gracefully...`);

      // Stop accepting new connections
      httpServer.close(() => {
        console.log("🔌 HTTP server closed");
      });

      // Disconnect Prisma (release DB connection pool)
      await prisma.$disconnect();
      console.log("🗄️  Database disconnected");

      process.exit(0);
    }

    // Listen for termination signals
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("SIGINT", () => shutdown("SIGINT"));
  } catch (error) {
    // If database connection fails on startup, crash immediately
    // This is intentional — the app cannot function without a DB
    console.error("❌ Failed to start server:", error);
    await prisma.$disconnect();
    process.exit(1);
  }
}

start();
