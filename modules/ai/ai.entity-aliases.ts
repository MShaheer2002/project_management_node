import { prisma } from "../../shared/utils/prisma.js";
import { buildNormalizedTextForms, normalizeLocaleCode } from "./ai.text-normalization.js";

export type AliasEntityType = "PROJECT" | "TEAM" | "DEPARTMENT" | "MEMBER" | "CYCLE";

function normalizeAlias(value: string) {
  return buildNormalizedTextForms(value).folded;
}

type AliasInput = string | { value: string; locale?: string | null | undefined } | null | undefined;

function uniqueAliases(values: AliasInput[], defaultLocale?: string | undefined) {
  const seen = new Set<string>();
  const result: Array<{ alias: string; normalized: string; locale: string | null }> = [];

  for (const value of values) {
    const alias = typeof value === "string" ? value.trim() : typeof value?.value === "string" ? value.value.trim() : "";
    const locale = normalizeLocaleCode(typeof value === "string" ? defaultLocale : value?.locale ?? defaultLocale) ?? null;
    const normalized = normalizeAlias(alias);
    const dedupeKey = `${locale ?? "default"}:${normalized}`;
    if (!alias || !normalized || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    result.push({ alias, normalized, locale });
  }

  return result;
}

export async function upsertEntityAliases(input: {
  workspaceId: string;
  entityType: AliasEntityType;
  entityId: string;
  aliases: AliasInput[];
  locale?: string | undefined;
}) {
  const aliases = uniqueAliases(input.aliases, input.locale);
  if (aliases.length === 0) return;

  const existing = await (prisma as any).entityAlias.findMany({
    where: {
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
    },
    select: { normalized: true, locale: true },
  }).catch(() => []);

  const existingNormalized = new Set(
    (existing as Array<{ normalized: string; locale: string | null }>).map((entry) => `${normalizeLocaleCode(entry.locale) ?? "default"}:${entry.normalized}`),
  );
  const missing = aliases.filter((entry) => !existingNormalized.has(`${entry.locale ?? "default"}:${entry.normalized}`));
  if (missing.length === 0) return;

  await (prisma as any).entityAlias.createMany({
    data: missing.map((entry) => ({
      workspaceId: input.workspaceId,
      entityType: input.entityType,
      entityId: input.entityId,
      alias: entry.alias,
      normalized: entry.normalized,
      locale: entry.locale,
    })),
  }).catch(() => {});
}
