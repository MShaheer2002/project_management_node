import cron from "node-cron";

import { env } from "../../config/env.js";
import { triggerStaleScan, triggerWeeklyDigest } from "./ai.background.js";

const CRON_TIMEZONE = "UTC";

export function startAiBackgroundScheduler() {
  if (!env.AI_BACKGROUND_SCHEDULER_ENABLED) {
    console.log("[AI Scheduler] Background scheduler disabled by configuration.");
    return [];
  }

  const staleScanTask = cron.schedule(
    "0 8 * * *",
    () => {
      void triggerStaleScan({ reason: "scheduled" });
    },
    { timezone: CRON_TIMEZONE },
  );

  const weeklyDigestTask = cron.schedule(
    "0 9 * * 1",
    () => {
      void triggerWeeklyDigest({ reason: "scheduled" });
    },
    { timezone: CRON_TIMEZONE },
  );

  console.log("[AI Scheduler] Scheduled stale scan (daily 08:00 UTC) and weekly digest (Monday 09:00 UTC).");
  return [staleScanTask, weeklyDigestTask];
}
