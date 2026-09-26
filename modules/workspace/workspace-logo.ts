/**
 * How a workspace logo is handed to clients.
 *
 * Uploads live in a private bucket, so the stored S3 URL can't be loaded
 * directly. Every response instead carries our own route
 * (GET /workspaces/:id/logo), which redirects to a short-lived signed link.
 * The browser only ever talks to Trussen and S3, never to a host an admin
 * picked (F-36). `v` changes with the file, so a new logo is never cached
 * under the old address.
 */
import { workspaceLogoKey } from "../../infra/storage/s3.js";

/** The logo URL to send to clients, or null (no logo, or legacy data that isn't our own upload). */
export function publicWorkspaceLogo(workspace: { id: string; logo: string | null }) {
  const key = workspace.logo ? workspaceLogoKey(workspace.id, workspace.logo) : null;
  if (!key) return null;
  const version = key.slice(key.lastIndexOf("/") + 1, key.lastIndexOf("."));
  // Relative on purpose: the web app prefixes the API address it already
  // uses, so this works wherever the API runs (BACKEND_URL is the public
  // tunnel/host for webhooks, which isn't always what the browser talks to).
  return `/workspaces/${workspace.id}/logo?v=${version}`;
}
