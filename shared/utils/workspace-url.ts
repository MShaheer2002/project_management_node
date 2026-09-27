import { env } from "../../config/env.js";
import { prisma } from "./prisma.js";

/**
 * A URL in a workspace's own app: `<slug>.<FRONTEND_URL host>` —
 * e.g. https://acme.trussen.app/settings, or http://acme.localhost:3000 in dev.
 * Each workspace only runs on its own subdomain; the bare domain sends a
 * signed-in user to whichever workspace their browser last used, which may be
 * a different one (and one they aren't signed in to).
 */
export function workspaceAppUrl(slug: string, path: string) {
  const url = new URL(path, env.FRONTEND_URL);
  url.hostname = `${slug}.${new URL(env.FRONTEND_URL).hostname}`;
  return url.toString();
}

/**
 * Where an OAuth callback returns the browser: the workspace the flow started
 * from, or the bare app when that isn't known (e.g. the state didn't verify).
 */
export async function oauthReturnUrl(workspaceId: string | null, path: string) {
  const workspace = workspaceId
    ? await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { slug: true } }).catch(() => null)
    : null;
  return workspace ? workspaceAppUrl(workspace.slug, path) : new URL(path, env.FRONTEND_URL).toString();
}
