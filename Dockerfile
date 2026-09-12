# See docs/deoplyement-guide/first deployemnt/setup-3-dockerfile.md for the
# full step-by-step explanation of every line below.

# ── Build stage ───────────────────────────────────────────────────────────
FROM node:25-slim AS build
WORKDIR /app

# openssl: Prisma's CLI (schema/migration engine) needs it even though the
# generated client itself (Prisma 7, driver-adapter mode) doesn't.
RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci

COPY . .

# `prisma generate` reads prisma.config.ts, which requires *a* DATABASE_URL/
# DIRECT_URL to exist — it never actually connects to a database for this
# command, so a placeholder is enough. The real ones come from DO's env vars
# at runtime, not from this build step.
ENV DATABASE_URL="postgresql://placeholder:placeholder@localhost:5432/placeholder"
RUN npx prisma generate
RUN npm run build

# ── Runtime stage ─────────────────────────────────────────────────────────
FROM node:25-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

RUN apt-get update -y && apt-get install -y openssl && rm -rf /var/lib/apt/lists/*

COPY package*.json ./
RUN npm ci --omit=dev

# Compiled app (this already includes the generated Prisma client — see the
# doc for why that doesn't need a separate copy step).
COPY --from=build /app/dist ./dist

# Needed for the Pre-Deploy Job's `prisma migrate deploy` to run from this
# same image — the schema/migrations, and prisma.config.ts (which the
# Prisma CLI reads directly; it's never compiled by tsc).
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/prisma.config.ts ./prisma.config.ts

EXPOSE 8000

# Web Service component uses this default. The Worker component overrides
# it in DO's dashboard to: node dist/workers/ai-background.worker.js
CMD ["node", "dist/app/server.js"]
