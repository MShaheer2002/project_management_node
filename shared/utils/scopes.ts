/**
 * Scope check shared by MCP tool dispatch and REST route middleware.
 *
 * Legacy/placeholder connections (empty scopes, or the old hardcoded
 * ["mcp:v1"] value) stay unrestricted — this is intentional, not a bug: it's
 * how existing tokens keep working without a data migration. Anyone who
 * wants a tighter connection edits it to real scopes.
 */
export function hasScope(scopes: string[] | null | undefined, required: string): boolean {
  if (!scopes || scopes.length === 0 || scopes.includes("mcp:v1")) return true;
  return scopes.includes("admin") || scopes.includes(required);
}
