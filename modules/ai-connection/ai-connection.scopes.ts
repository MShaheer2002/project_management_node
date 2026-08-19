/**
 * Personal Access Token scope taxonomy.
 *
 * Every AiConnection (PAT) stores a `scopes` array drawn from this list.
 * "admin" is a real wildcard scope, not a UI shortcut that expands to the
 * rest — see hasScope() in shared/utils/scopes.ts.
 */

export const ALL_SCOPES = [
  "admin",
  "issues:read",
  "issues:write",
  "projects:read",
  "projects:write",
  "teams:read",
  "teams:write",
  "departments:read",
  "departments:write",
  "cycles:read",
  "cycles:write",
  "members:read",
  "analytics:read",
] as const;

export type Scope = (typeof ALL_SCOPES)[number];
