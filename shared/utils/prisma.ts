/**
 * Prisma Client Singleton
 *
 * Creates a single Prisma client instance shared across the entire application.
 * Prisma 7 requires a driver adapter — we use @prisma/adapter-pg which connects
 * to PostgreSQL using the standard `pg` library under the hood.
 *
 * Usage: import { prisma } from "../shared/utils/prisma.js"
 *
 * The client is stored on `globalThis` in development to survive hot reloads
 * without creating new connections each time tsx restarts the module.
 */

import { PrismaClient } from "../../app/generated/prisma/client.js";
import { PrismaPg } from "@prisma/adapter-pg";

// Create the PostgreSQL adapter using DATABASE_URL from environment
// PrismaPg accepts a connection string directly and manages the pool internally
const adapter = new PrismaPg(process.env["DATABASE_URL"]!);

// Type for the Prisma client instance
type PrismaClientInstance = InstanceType<typeof PrismaClient>;

// Extend globalThis to hold the prisma instance across hot reloads
const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClientInstance | undefined;
};

// Reuse existing client in development, create new one otherwise
export const prisma: PrismaClientInstance =
  globalForPrisma.prisma ?? new PrismaClient({ adapter });

// In development, store on global to prevent multiple instances during hot reload
if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
