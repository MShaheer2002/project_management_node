/**
 * Single source of truth for which browser origins may call the API or open
 * a Socket.IO connection. Both config/cors.ts and socket/index.ts import
 * this instead of each keeping their own copy of the pattern — they used to
 * drift (Socket.IO's copy never gated dev-only origins behind NODE_ENV),
 * which is exactly the kind of gap that's easy to miss when the same check
 * is duplicated.
 *
 * Every company workspace lives on its own subdomain (<slug>.trussen.app),
 * so "the frontend origin" isn't a single fixed string in production — it's
 * a pattern: the bare root domain, or any subdomain of it, over HTTPS.
 */

const PRODUCTION_ROOT_DOMAIN = "trussen.app";

function isProductionOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }

  return (
    url.protocol === "https:" &&
    (url.hostname === PRODUCTION_ROOT_DOMAIN || url.hostname.endsWith(`.${PRODUCTION_ROOT_DOMAIN}`))
  );
}

function isDevelopmentOrigin(origin: string): boolean {
  return (
    origin.startsWith("http://localhost:") ||
    origin.startsWith("http://127.0.0.1:") ||
    /^http:\/\/[a-z0-9-]+\.localhost:\d+$/.test(origin) || // e.g. fissiontech.localhost:3000
    /^http:\/\/192\.168\.\d+\.\d+:\d+$/.test(origin) || // local network IPs
    origin.endsWith(".ngrok-free.dev") // ngrok tunnels
  );
}

export function isAllowedFrontendOrigin(origin: string | undefined, nodeEnv: string): boolean {
  if (!origin) return true; // no Origin header — curl, Postman, server-to-server
  if (isProductionOrigin(origin)) return true;
  if (nodeEnv !== "production") return isDevelopmentOrigin(origin);
  return false;
}
