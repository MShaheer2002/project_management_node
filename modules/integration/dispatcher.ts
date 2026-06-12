/**
 * Integration Event Dispatcher
 *
 * Single entry point for all integration notifications.
 * The issue/cycle/comment services call this instead of importing
 * each provider's notification module separately.
 *
 * Adding a new provider = register a handler here. Zero changes in callers.
 *
 * All handlers are fire-and-forget — failures are logged but never thrown.
 */

import type { IntegrationEvent } from "./integration.types.js";

type EventHandler = (workspaceId: string, event: IntegrationEvent) => Promise<void>;

// Lazy-load provider handlers to avoid circular imports at startup
const providers: Record<string, () => Promise<{ handleEvent: EventHandler }>> = {
  slack: () => import("./slack/slack.notify.js"),
  discord: () => import("./discord/discord.notify.js"),
};

/**
 * Dispatch an integration event to all connected providers.
 * Each provider independently checks if it's connected and if the
 * event type is enabled in its settings. Safe to call even if no
 * integrations are connected — it's a no-op.
 */
export async function dispatchIntegrationEvent(
  workspaceId: string,
  event: IntegrationEvent,
): Promise<void> {
  const results = Object.entries(providers).map(async ([name, loadHandler]) => {
    try {
      const handler = await loadHandler();
      await handler.handleEvent(workspaceId, event);
    } catch (err) {
      console.warn(`[Integration Dispatcher] ${name} failed for ${event.type}:`, err);
    }
  });

  await Promise.allSettled(results);
}
