/**
 * Bull Board — queue visibility.
 *
 * Before this, the only way to see queue depth or a failed-job count was to
 * query Redis by hand (which is how the 18 failed proactive-summary jobs
 * from 2026-06-26 were found — six weeks after the fact, by accident). This
 * gives that same view a URL instead.
 *
 * Off by default (`BULL_BOARD_ENABLED=false`) and gated by basic auth when
 * on — this exposes job payloads and counts across every workspace, which is
 * an ops view, not something to leave open on a public port.
 *
 * Mounted as a route on the main `api` app (see `app/app.ts`) rather than
 * run as its own standalone server — the AI jobs it displays actually run
 * in the `ai-worker` process, but that process has no public HTTP route in
 * production (it's a DO App Platform Worker component), while `api` already
 * does. Both processes connect to the same Redis, so either can read queue
 * state; `api` is just the one with a public URL to serve it from.
 */

import { createBullBoard } from "@bull-board/api";
import { BullMQAdapter } from "@bull-board/api/bullMQAdapter";
import { ExpressAdapter } from "@bull-board/express";
import express from "express";

import { env } from "../../config/env.js";
import { AI_QUEUE_NAMES } from "../../modules/ai/ai.jobs.js";
import { getQueue } from "./queues.js";

function requireBasicAuth(username: string, password: string) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    const header = req.headers.authorization;
    if (header?.startsWith("Basic ")) {
      const decoded = Buffer.from(header.slice("Basic ".length), "base64").toString("utf8");
      const separatorIndex = decoded.indexOf(":");
      const user = separatorIndex === -1 ? decoded : decoded.slice(0, separatorIndex);
      const pass = separatorIndex === -1 ? "" : decoded.slice(separatorIndex + 1);
      if (user === username && pass === password) {
        next();
        return;
      }
    }
    res.setHeader("WWW-Authenticate", 'Basic realm="Trussen Queue Dashboard"');
    res.status(401).send("Authentication required.");
  };
}

export function getBullBoardRouter(basePath: string): express.Router | null {
  if (!env.BULL_BOARD_ENABLED) return null;

  if (!env.BULL_BOARD_USERNAME || !env.BULL_BOARD_PASSWORD) {
    console.warn(
      "[Bull Board] BULL_BOARD_ENABLED is true but BULL_BOARD_USERNAME/BULL_BOARD_PASSWORD are not set. Not mounting — an unauthenticated queue dashboard is not an option.",
    );
    return null;
  }

  const queues = Object.values(AI_QUEUE_NAMES)
    .map((name) => getQueue(name))
    .filter((queue): queue is NonNullable<typeof queue> => queue !== null)
    .map((queue) => new BullMQAdapter(queue));

  if (queues.length === 0) {
    console.warn("[Bull Board] No queues available (is REDIS_URL set?) — not mounting.");
    return null;
  }

  const serverAdapter = new ExpressAdapter();
  serverAdapter.setBasePath(basePath);

  createBullBoard({ queues, serverAdapter });

  const router = express.Router();
  router.use(requireBasicAuth(env.BULL_BOARD_USERNAME, env.BULL_BOARD_PASSWORD));
  router.use(serverAdapter.getRouter());
  return router;
}
