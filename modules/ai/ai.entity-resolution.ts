import { prisma } from "../../shared/utils/prisma.js";
import { incrementAiMetricCounter, logAiInfo, recordAiResolverSnapshot } from "./ai.observability.js";
import { createEmbedding } from "./ai.provider.js";
import { getResolverFlowPolicy, RESOLVER_FLOW_THRESHOLDS, RESOLVER_SCORE_WEIGHTS } from "./ai.entity-resolution.config.js";
import { buildNormalizedTextForms, localeMatchesText, normalizeLocaleCode } from "./ai.text-normalization.js";

export type ResolvedEntityType = "project" | "team" | "department" | "member" | "cycle" | "issue";
export type ResolutionStatus = "resolved" | "confirm" | "ambiguous" | "not_found";
export type ResolutionAccessMode = "read" | "mutation";
export type ResolutionRisk = "low" | "medium" | "high";

export type EntityResolutionCandidate = {
  id: string;
  name: string;
  entityType?: ResolvedEntityType | undefined;
  confidence: number;
  reason: string;
};

export type EntityResolutionResult = {
  status: ResolutionStatus;
  entityType: ResolvedEntityType;
  match?: { id: string; name: string };
  confidence?: number;
  candidates?: EntityResolutionCandidate[];
  reason: string;
};

export type EntityResolutionRequest = {
  workspaceId: string;
  userId: string;
  userRole: string;
  rawMessage: string;
  mention?: string | undefined;
  entityType?: ResolvedEntityType | undefined;
  expectedEntityTypes?: ResolvedEntityType[] | undefined;
  triggeringIntent?: string | undefined;
  conversationId?: string | undefined;
  accessMode: ResolutionAccessMode;
  actionRisk: ResolutionRisk;
  currentContext?: {
    projectId?: string;
    issueId?: string;
    teamId?: string;
    departmentId?: string;
    cycleId?: string;
    memberId?: string;
  } | undefined;
  enableEmbeddings?: boolean;
};

function resolveRequestedEntityTypes(request: EntityResolutionRequest): ResolvedEntityType[] {
  if (request.entityType) return [request.entityType];
  const expected = [...new Set(request.expectedEntityTypes ?? [])];
  if (expected.length > 0) return expected;
  throw new Error("Entity resolution requires at least one concrete entity type.");
}

type BaseCandidate = {
  id: string;
  name: string;
  aliases: Array<{ alias: string; normalized: string; locale?: string | null | undefined }>;
};

type ScoredCandidate = BaseCandidate & {
  exactScore: number;
  fuzzyScore: number;
  embeddingScore: number;
  contextScore: number;
  localeBoost: number;
  phraseContainedScore: number;
  calibratedScore: number;
  reason: string;
};

const isAdminRole = (role: string) => role === "OWNER" || role === "ADMIN";

const ENTITY_ALIAS_TYPE: Partial<Record<ResolvedEntityType, "PROJECT" | "TEAM" | "DEPARTMENT" | "MEMBER" | "CYCLE">> = {
  project: "PROJECT",
  team: "TEAM",
  department: "DEPARTMENT",
  member: "MEMBER",
  cycle: "CYCLE",
};

const ENTITY_EMBEDDING_TYPE: Record<ResolvedEntityType, "PROJECT" | "TEAM" | "DEPARTMENT" | "MEMBER" | "CYCLE" | "ISSUE"> = {
  project: "PROJECT",
  team: "TEAM",
  department: "DEPARTMENT",
  member: "MEMBER",
  cycle: "CYCLE",
  issue: "ISSUE",
};

function normalizeText(value: string) {
  return buildNormalizedTextForms(value).normalized;
}

function normalizeFoldedText(value: string) {
  return buildNormalizedTextForms(value).folded;
}

function tokenize(value: string) {
  return [...new Set(normalizeFoldedText(value).split(" ").filter((token) => token.length > 0))];
}

function buildTrigrams(value: string) {
  const normalized = `  ${normalizeFoldedText(value)}  `;
  const trigrams = new Set<string>();
  for (let index = 0; index < normalized.length - 2; index += 1) {
    trigrams.add(normalized.slice(index, index + 3));
  }
  return trigrams;
}

function trigramSimilarity(a: string, b: string) {
  const aTrigrams = buildTrigrams(a);
  const bTrigrams = buildTrigrams(b);
  if (aTrigrams.size === 0 || bTrigrams.size === 0) return 0;
  let overlap = 0;
  for (const value of aTrigrams) {
    if (bTrigrams.has(value)) overlap += 1;
  }
  return (2 * overlap) / (aTrigrams.size + bTrigrams.size);
}

function jaccardSimilarity(a: string[], b: string[]) {
  if (a.length === 0 || b.length === 0) return 0;
  const aSet = new Set(a);
  const bSet = new Set(b);
  const intersection = [...aSet].filter((item) => bSet.has(item)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

function levenshteinDistance(a: string, b: string) {
  const aValue = normalizeFoldedText(a);
  const bValue = normalizeFoldedText(b);
  if (aValue === bValue) return 0;
  if (!aValue.length) return bValue.length;
  if (!bValue.length) return aValue.length;

  const matrix = Array.from({ length: aValue.length + 1 }, () => new Array<number>(bValue.length + 1).fill(0));
  for (let i = 0; i <= aValue.length; i += 1) matrix[i]![0] = i;
  for (let j = 0; j <= bValue.length; j += 1) matrix[0]![j] = j;

  for (let i = 1; i <= aValue.length; i += 1) {
    for (let j = 1; j <= bValue.length; j += 1) {
      const cost = aValue[i - 1] === bValue[j - 1] ? 0 : 1;
      matrix[i]![j] = Math.min(
        matrix[i - 1]![j]! + 1,
        matrix[i]![j - 1]! + 1,
        matrix[i - 1]![j - 1]! + cost,
      );
    }
  }

  return matrix[aValue.length]![bValue.length]!;
}

function editSimilarity(a: string, b: string) {
  const maxLength = Math.max(normalizeFoldedText(a).length, normalizeFoldedText(b).length, 1);
  return 1 - (levenshteinDistance(a, b) / maxLength);
}

function percentileRank(scores: number[], value: number) {
  if (scores.length <= 1) return value;
  const sorted = [...scores].sort((left, right) => left - right);
  const index = sorted.findIndex((item) => item >= value);
  if (index === -1) return 1;
  return sorted.length === 1 ? 1 : index / (sorted.length - 1);
}

function bestNameAndAliasScore(mention: string, candidate: BaseCandidate) {
  const values = [
    { value: candidate.name, locale: undefined, normalized: normalizeFoldedText(candidate.name), exactNormalized: normalizeText(candidate.name) },
    ...candidate.aliases.map((alias) => ({
      value: alias.alias,
      locale: alias.locale,
      normalized: alias.normalized,
      exactNormalized: normalizeText(alias.alias),
    })),
  ];
  let exactScore = 0;
  let fuzzyScore = 0;
  let phraseContainedScore = 0;
  let matchedValue = candidate.name;
  let matchedLocaleBoost = 0;
  const normalizedMention = normalizeText(mention);
  const foldedMention = normalizeFoldedText(mention);

  for (const value of values) {
    const normalizedValue = value.exactNormalized;
    const foldedValue = value.normalized;
    const isExact = normalizedMention === normalizedValue || foldedMention === foldedValue ? 1 : 0;
    const containsExactPhrase = normalizedValue.length >= 3
      && normalizedMention !== normalizedValue
      && (` ${normalizedMention} `).includes(` ${normalizedValue} `);
    const tokenPrefixScore = foldedMention.length >= 3 && tokenize(value.value).some((token) => token.startsWith(foldedMention))
      ? 0.94
      : 0;
    const containsScore = foldedMention.includes(foldedValue) || foldedValue.includes(foldedMention)
      ? 0.88
      : 0;
    const trigramScore = trigramSimilarity(mention, value.value);
    const tokenScore = jaccardSimilarity(tokenize(mention), tokenize(value.value));
    const editScore = editSimilarity(mention, value.value);
    const localeBoost = value.locale && localeMatchesText(value.locale, mention) ? RESOLVER_SCORE_WEIGHTS.localeAliasBoost : 0;
    const blended = Math.max(tokenPrefixScore, containsScore, (trigramScore * 0.45) + (tokenScore * 0.3) + (editScore * 0.25));

    if (
      isExact > exactScore ||
      Number(containsExactPhrase) > phraseContainedScore ||
      blended + localeBoost > fuzzyScore + matchedLocaleBoost
    ) {
      exactScore = Math.max(exactScore, isExact);
      phraseContainedScore = Math.max(phraseContainedScore, containsExactPhrase ? 1 : 0);
      fuzzyScore = Math.max(fuzzyScore, blended);
      matchedValue = value.value;
      matchedLocaleBoost = localeBoost;
    }
  }

  return { exactScore, fuzzyScore, phraseContainedScore, matchedValue, localeBoost: matchedLocaleBoost };
}

function buildContextScore(entityType: ResolvedEntityType, candidateId: string, currentContext?: EntityResolutionRequest["currentContext"]) {
  if (!currentContext) return 0;
  if (entityType === "project" && currentContext.projectId === candidateId) return 0.04;
  if (entityType === "team" && currentContext.teamId === candidateId) return 0.04;
  if (entityType === "department" && currentContext.departmentId === candidateId) return 0.04;
  if (entityType === "cycle" && currentContext.cycleId === candidateId) return 0.04;
  if (entityType === "member" && currentContext.memberId === candidateId) return 0.04;
  return 0;
}

async function loadAliases(workspaceId: string, entityType: ResolvedEntityType, entityIds: string[]) {
  const aliasType = ENTITY_ALIAS_TYPE[entityType];
  if (!aliasType || entityIds.length === 0) return new Map<string, Array<{ alias: string; normalized: string; locale?: string | null }>>();
  const aliases = await (prisma as any).entityAlias.findMany({
    where: {
      workspaceId,
      entityType: aliasType,
      entityId: { in: entityIds },
    },
    select: { entityId: true, alias: true, normalized: true, locale: true },
  }).catch(() => []);

  const result = new Map<string, Array<{ alias: string; normalized: string; locale?: string | null }>>();
  for (const alias of aliases as Array<{ entityId: string; alias: string; normalized: string; locale: string | null }>) {
    const bucket = result.get(alias.entityId) ?? [];
    const normalizedLocale = normalizeLocaleCode(alias.locale);
    bucket.push({
      alias: alias.alias,
      normalized: alias.normalized || normalizeFoldedText(alias.alias),
      ...(normalizedLocale ? { locale: normalizedLocale } : {}),
    });
    result.set(alias.entityId, bucket);
  }
  return result;
}

async function loadBaseCandidatesForType(request: EntityResolutionRequest, entityType: ResolvedEntityType): Promise<BaseCandidate[]> {
  if (entityType === "project") {
    const candidates = await prisma.project.findMany({
      where: {
        workspaceId: request.workspaceId,
        ...(isAdminRole(request.userRole)
          ? {}
          : {
              OR: [
                { visibility: "PUBLIC" },
                { leadId: request.userId },
                { memberships: { some: { userId: request.userId } } },
              ],
            }),
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 100,
    });
    const aliases = await loadAliases(request.workspaceId, entityType, candidates.map((candidate) => candidate.id));
    return candidates.map((candidate) => ({ ...candidate, aliases: aliases.get(candidate.id) ?? [] }));
  }

  if (entityType === "team") {
    const candidates = await prisma.team.findMany({
      where: {
        workspaceId: request.workspaceId,
        ...(isAdminRole(request.userRole)
          ? {}
          : {
              OR: [
                { visibility: "PUBLIC" },
                { leadId: request.userId },
                { memberships: { some: { userId: request.userId } } },
              ],
            }),
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 100,
    });
    const aliases = await loadAliases(request.workspaceId, entityType, candidates.map((candidate) => candidate.id));
    return candidates.map((candidate) => ({ ...candidate, aliases: aliases.get(candidate.id) ?? [] }));
  }

  if (entityType === "department") {
    const candidates = await prisma.department.findMany({
      where: {
        workspaceId: request.workspaceId,
        ...(isAdminRole(request.userRole)
          ? {}
          : {
              OR: [
                { visibility: "PUBLIC" },
                { headId: request.userId },
                { memberships: { some: { userId: request.userId } } },
              ],
            }),
      },
      select: { id: true, name: true },
      orderBy: { name: "asc" },
      take: 100,
    });
    const aliases = await loadAliases(request.workspaceId, entityType, candidates.map((candidate) => candidate.id));
    return candidates.map((candidate) => ({ ...candidate, aliases: aliases.get(candidate.id) ?? [] }));
  }

  if (entityType === "member") {
    const memberships = await prisma.workspaceMembership.findMany({
      where: { workspaceId: request.workspaceId },
      select: { user: { select: { id: true, name: true } } },
      orderBy: { joinedAt: "asc" },
      take: 100,
    });
    const candidates = memberships
      .map((membership) => membership.user)
      .filter((user): user is { id: string; name: string } => Boolean(user?.id && user?.name));
    const aliases = await loadAliases(request.workspaceId, entityType, candidates.map((candidate) => candidate.id));
    return candidates.map((candidate) => ({ ...candidate, aliases: aliases.get(candidate.id) ?? [] }));
  }

  if (entityType === "issue") {
    const candidates = await prisma.issue.findMany({
      where: {
        workspaceId: request.workspaceId,
        ...issueVisibilityWhereLike(request),
      },
      select: { id: true, title: true },
      orderBy: { updatedAt: "desc" },
      take: 100,
    });
    return candidates.map((candidate) => ({
      id: candidate.id,
      name: candidate.title,
      aliases: [{ alias: candidate.id, normalized: normalizeFoldedText(candidate.id) }],
    }));
  }

  const candidates = await (prisma as any).cycle.findMany({
    where: {
      workspaceId: request.workspaceId,
      ...(isAdminRole(request.userRole)
        ? {}
        : {
            OR: [
              { team: { leadId: request.userId } },
              { team: { memberships: { some: { userId: request.userId } } } },
            ],
          }),
    },
    select: { id: true, name: true },
    orderBy: [{ startsAt: "desc" }, { name: "asc" }],
    take: 100,
  });
  const aliases = await loadAliases(request.workspaceId, entityType, candidates.map((candidate: { id: string }) => candidate.id));
  return (candidates as Array<{ id: string; name: string }>).map((candidate) => ({ ...candidate, aliases: aliases.get(candidate.id) ?? [] }));
}

function issueVisibilityWhereLike(request: EntityResolutionRequest): Record<string, unknown> {
  return isAdminRole(request.userRole)
    ? {}
    : {
        OR: [
          { project: { visibility: "PUBLIC" } },
          { project: { leadId: request.userId } },
          { project: { memberships: { some: { userId: request.userId } } } },
        ],
      };
}

async function loadEmbeddingScores(request: EntityResolutionRequest, mention: string, candidates: BaseCandidate[], entityType: ResolvedEntityType) {
  if (request.enableEmbeddings === false || mention.length < 3 || candidates.length === 0) {
    return new Map<string, number>();
  }

  try {
    const embedding = await createEmbedding(mention);
    const ids = candidates.map((candidate) => candidate.id);
    const rows = await prisma.$queryRawUnsafe<Array<{ entityId: string; similarity: number }>>(
      `SELECT "entityId", 1 - ("embedding" <=> $1::vector) AS similarity
       FROM "AiEmbedding"
       WHERE "workspaceId" = $2
         AND "entityType" = $3::"AiEmbeddingEntityType"
         AND "entityId" = ANY($4::text[])
       ORDER BY "embedding" <=> $1::vector
      LIMIT $5`,
      `[${embedding.embedding.map((value) => Number.isFinite(value) ? value : 0).join(",")}]`,
      request.workspaceId,
      ENTITY_EMBEDDING_TYPE[entityType],
      ids,
      Math.min(candidates.length, 10),
    ).catch(() => []);

    return new Map(rows.map((row) => [row.entityId, row.similarity]));
  } catch {
    return new Map<string, number>();
  }
}

function relativeGap(first: number, second: number) {
  return (first - second) / Math.max(first, 0.0001);
}

function buildReason(candidate: BaseCandidate, mention: string, exactScore: number, fuzzyScore: number, embeddingScore: number, contextScore: number, localeBoost: number) {
  if (exactScore >= 1) return `Exact name or alias match for "${mention}" against "${candidate.name}".`;
  const signals = [
    fuzzyScore > 0 ? `fuzzy=${fuzzyScore.toFixed(3)}` : "",
    embeddingScore > 0 ? `embedding=${embeddingScore.toFixed(3)}` : "",
    contextScore > 0 ? `contextBoost=${contextScore.toFixed(3)}` : "",
    localeBoost > 0 ? `localeBoost=${localeBoost.toFixed(3)}` : "",
  ].filter(Boolean);
  return signals.length > 0
    ? `Resolved against "${candidate.name}" using ${signals.join(", ")}.`
    : `Candidate "${candidate.name}" had the strongest available match.`;
}

export async function resolveEntityReference(request: EntityResolutionRequest): Promise<EntityResolutionResult> {
  const requestedEntityTypes = resolveRequestedEntityTypes(request);
  if (requestedEntityTypes.length === 1) {
    return resolveEntityReferenceForType(request, requestedEntityTypes[0]!);
  }

  return resolveEntityReferenceAcrossTypes(request, requestedEntityTypes);
}

function buildRequestedEntityTypeLabel(entityTypes: ResolvedEntityType[]) {
  return entityTypes.length === 1 ? entityTypes[0]! : entityTypes.join("|");
}

function buildLabeledCandidates(
  candidates: Array<EntityResolutionCandidate & { entityType: ResolvedEntityType }>,
  mixedTypes: boolean,
) {
  return candidates.map((candidate) => ({
    id: candidate.id,
    name: mixedTypes ? `${candidate.name} (${candidate.entityType})` : candidate.name,
    entityType: candidate.entityType,
    confidence: candidate.confidence,
    reason: candidate.reason,
  }));
}

async function emitResolutionObservability(input: {
  request: EntityResolutionRequest;
  entityTypeLabel: string;
  expectedEntityTypes: ResolvedEntityType[];
  result: EntityResolutionResult;
  contextOnly: boolean;
}) {
  const { request, entityTypeLabel, expectedEntityTypes, result, contextOnly } = input;
  logAiInfo("entity_resolution_evaluated", {
    workspaceId: request.workspaceId,
    userId: request.userId,
    feature: "entity-resolution",
    success: result.status === "resolved" || result.status === "confirm",
    metadata: {
      requestedEntityType: entityTypeLabel,
      expectedEntityTypes,
      triggeringIntent: request.triggeringIntent ?? "UNKNOWN",
      rawTextFragment: request.mention ?? request.rawMessage,
      accessMode: request.accessMode,
      actionRisk: request.actionRisk,
      chosenCandidate: result.match ?? null,
      confidence: result.confidence ?? null,
      resolutionStatus: result.status,
      confirmationRequired: result.status === "confirm",
      contextOnly,
      memoryAssisted: Boolean(request.currentContext),
      topCandidates: result.candidates ?? [],
      exactMatchRate: result.confidence === 1 ? 1 : 0,
      reason: result.reason,
    },
  });
  void recordAiResolverSnapshot({
    workspaceId: request.workspaceId,
    userId: request.userId,
    conversationId: request.conversationId,
    triggeringIntent: request.triggeringIntent,
    requestedEntityType: entityTypeLabel,
    expectedEntityTypes,
    rawTextFragment: request.mention ?? request.rawMessage,
    accessMode: request.accessMode,
    actionRisk: request.actionRisk,
    chosenCandidate: result.match ?? null,
    confidence: result.confidence ?? null,
    resolutionStatus: result.status,
    confirmationRequired: result.status === "confirm",
    contextOnly,
    memoryAssisted: Boolean(request.currentContext),
    topCandidates: result.candidates,
    reason: result.reason,
    metadata: {
      exactMatchRate: result.confidence === 1 ? 1 : 0,
    },
  });
  void incrementAiMetricCounter({
    workspaceId: request.workspaceId,
    feature: "entity-resolution",
    metric: "resolution_total",
    dimensions: {
      entityType: entityTypeLabel,
      intent: request.triggeringIntent ?? "UNKNOWN",
      status: result.status,
    },
  });
  if (result.confidence === 1) {
    void incrementAiMetricCounter({
      workspaceId: request.workspaceId,
      feature: "entity-resolution",
      metric: "exact_match",
      dimensions: {
        entityType: entityTypeLabel,
        intent: request.triggeringIntent ?? "UNKNOWN",
      },
    });
  }
  if (result.status === "confirm") {
    void incrementAiMetricCounter({
      workspaceId: request.workspaceId,
      feature: "entity-resolution",
      metric: "confirmation_required",
      dimensions: {
        entityType: entityTypeLabel,
        intent: request.triggeringIntent ?? "UNKNOWN",
      },
    });
  }
  if (result.status === "not_found") {
    void incrementAiMetricCounter({
      workspaceId: request.workspaceId,
      feature: "entity-resolution",
      metric: "not_found",
      dimensions: {
        entityType: entityTypeLabel,
        intent: request.triggeringIntent ?? "UNKNOWN",
      },
    });
  }
  if (contextOnly) {
    void incrementAiMetricCounter({
      workspaceId: request.workspaceId,
      feature: "entity-resolution",
      metric: "context_only_resolution",
      dimensions: {
        entityType: entityTypeLabel,
        intent: request.triggeringIntent ?? "UNKNOWN",
      },
    });
  }
  if (request.currentContext) {
    void incrementAiMetricCounter({
      workspaceId: request.workspaceId,
      feature: "entity-resolution",
      metric: "memory_assisted_resolution",
      dimensions: {
        entityType: entityTypeLabel,
        intent: request.triggeringIntent ?? "UNKNOWN",
      },
    });
  }
}

async function resolveEntityReferenceForType(
  request: EntityResolutionRequest,
  entityType: ResolvedEntityType,
  options: {
    suppressObservability?: boolean | undefined;
  } = {},
): Promise<EntityResolutionResult> {
  const explicitMention = normalizeText(request.mention ?? "");
  let contextOnly = false;
  const mention = explicitMention || (request.currentContext ? "" : normalizeText(request.rawMessage));
  const logResolution = (result: EntityResolutionResult) => {
    if (!options.suppressObservability) {
      void emitResolutionObservability({
        request,
        entityTypeLabel: entityType,
        expectedEntityTypes: request.expectedEntityTypes ?? [entityType],
        result,
        contextOnly,
      });
    }
    return result;
  };

  if (!mention && !request.currentContext) {
    return logResolution({
      status: "not_found",
      entityType,
      reason: "No entity mention was available to resolve.",
    });
  }

  const candidates = await loadBaseCandidatesForType(request, entityType);
  if (candidates.length === 0) {
    return logResolution({
      status: "not_found",
      entityType,
      reason: `No visible ${entityType} candidates were available in this workspace.`,
    });
  }

  if (!mention && request.currentContext) {
    contextOnly = true;
    const contextId =
      entityType === "project" ? request.currentContext.projectId
        : entityType === "issue" ? request.currentContext.issueId
        : entityType === "team" ? request.currentContext.teamId
          : entityType === "department" ? request.currentContext.departmentId
            : entityType === "cycle" ? request.currentContext.cycleId
              : request.currentContext.memberId;

    const contextCandidate = contextId
      ? candidates.find((candidate) => candidate.id === contextId)
      : undefined;

    if (contextCandidate) {
      return logResolution({
        status: request.accessMode === "mutation" || request.actionRisk !== "low" ? "confirm" : "resolved",
        entityType,
        match: { id: contextCandidate.id, name: contextCandidate.name },
        confidence: 0.94,
        candidates: [{
          id: contextCandidate.id,
          name: contextCandidate.name,
          confidence: 0.94,
          reason: "Context-only resolution from current conversation scope.",
        }],
        reason: "No explicit entity mention was provided, so the current conversation scope was used.",
      });
    }
  }

  if (!mention) {
    return logResolution({
      status: "not_found",
      entityType,
      reason: "No entity mention was available to resolve.",
    });
  }

  const embeddingScores = await loadEmbeddingScores(request, mention, candidates, entityType);
  const flowPolicy = getResolverFlowPolicy({
    accessMode: request.accessMode,
    actionRisk: request.actionRisk,
  });
  const thresholds = RESOLVER_FLOW_THRESHOLDS[flowPolicy];
  const preliminary = candidates.map((candidate) => {
    const { exactScore, fuzzyScore, phraseContainedScore, localeBoost } = bestNameAndAliasScore(mention, candidate);
    return {
      candidate,
      exactScore,
      fuzzyScore,
      phraseContainedScore,
      localeBoost,
      embeddingScore: Math.max(0, embeddingScores.get(candidate.id) ?? 0),
      contextScore: buildContextScore(entityType, candidate.id, request.currentContext),
    };
  });

  const fuzzyValues = preliminary.map((entry) => entry.fuzzyScore);
  const embeddingValues = preliminary.map((entry) => entry.embeddingScore);

  const scored: ScoredCandidate[] = preliminary
    .map((entry) => {
      const fuzzyRank = percentileRank(fuzzyValues, entry.fuzzyScore);
      const embeddingRank = percentileRank(embeddingValues, entry.embeddingScore);
      const calibratedScore = Math.min(
        1,
        (entry.exactScore * RESOLVER_SCORE_WEIGHTS.exact)
        + (fuzzyRank * RESOLVER_SCORE_WEIGHTS.fuzzy)
        + (embeddingRank * RESOLVER_SCORE_WEIGHTS.embedding)
        + (entry.contextScore * RESOLVER_SCORE_WEIGHTS.context)
        + entry.localeBoost,
      );

      return {
        ...entry.candidate,
        exactScore: entry.exactScore,
        fuzzyScore: entry.fuzzyScore,
        embeddingScore: entry.embeddingScore,
        contextScore: entry.contextScore,
        localeBoost: entry.localeBoost,
        phraseContainedScore: entry.phraseContainedScore,
        calibratedScore,
        reason: buildReason(entry.candidate, mention, entry.exactScore, entry.fuzzyScore, entry.embeddingScore, entry.contextScore, entry.localeBoost),
      };
    })
    .filter((candidate) => candidate.exactScore > 0 || candidate.phraseContainedScore > 0 || candidate.fuzzyScore >= 0.3 || candidate.embeddingScore >= 0.55 || candidate.contextScore > 0)
    .sort((left, right) => {
      if (right.calibratedScore !== left.calibratedScore) return right.calibratedScore - left.calibratedScore;
      return left.name.localeCompare(right.name);
    });

  if (scored.length === 0) {
    return logResolution({
      status: "not_found",
      entityType,
      reason: `I couldn't find a credible ${entityType} match for "${request.mention ?? request.rawMessage}".`,
    });
  }

  const top = scored[0]!;
  const second = scored[1];

  if (top.exactScore >= 1 && (!second || second.exactScore < 1)) {
    return logResolution({
      status: "resolved",
      entityType,
      match: { id: top.id, name: top.name },
      confidence: 1,
      candidates: scored.slice(0, 3).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        confidence: Number(candidate.calibratedScore.toFixed(4)),
        reason: candidate.reason,
      })),
      reason: top.reason,
    });
  }

  if (
    request.accessMode === "read" &&
    request.actionRisk === "low" &&
    top.phraseContainedScore > 0 &&
    top.fuzzyScore >= 0.88 &&
    (!second || second.phraseContainedScore === 0)
  ) {
    return logResolution({
      status: "resolved",
      entityType,
      match: { id: top.id, name: top.name },
      confidence: Math.max(0.9, Number(top.calibratedScore.toFixed(4))),
      candidates: scored.slice(0, 3).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        confidence: Number(Math.max(candidate.calibratedScore, candidate.phraseContainedScore > 0 ? 0.9 : candidate.calibratedScore).toFixed(4)),
        reason: candidate.reason,
      })),
      reason: `The request contains the exact ${entityType} name "${top.name}" inside a broader sentence.`,
    });
  }

  if (
    request.accessMode === "read" &&
    request.actionRisk === "low" &&
    top.fuzzyScore >= 0.9 &&
    (!second || top.fuzzyScore - second.fuzzyScore >= 0.12)
  ) {
    return logResolution({
      status: "resolved",
      entityType,
      match: { id: top.id, name: top.name },
      confidence: Math.max(0.9, Number(top.fuzzyScore.toFixed(4))),
      candidates: scored.slice(0, 3).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        confidence: Number(Math.max(candidate.calibratedScore, candidate.fuzzyScore >= 0.9 ? candidate.fuzzyScore : candidate.calibratedScore).toFixed(4)),
        reason: candidate.reason,
      })),
      reason: `A single ${entityType} candidate was a clear fuzzy winner for this low-risk read request.`,
    });
  }

  if (
    second &&
    (
      relativeGap(top.calibratedScore, second.calibratedScore) < thresholds.ambiguousGap ||
      ((top.calibratedScore - second.calibratedScore) / Math.max(top.calibratedScore, 0.0001)) < thresholds.ambiguousDeltaRatio
    )
  ) {
    return logResolution({
      status: "ambiguous",
      entityType,
      candidates: scored.slice(0, 5).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        confidence: Number(candidate.calibratedScore.toFixed(4)),
        reason: candidate.reason,
      })),
      reason: `Multiple ${entityType} candidates were too close to resolve safely.`,
    });
  }

  const accessThreshold = thresholds.autoResolve;
  const needsConfirmation = request.accessMode === "mutation" &&
    (request.actionRisk !== "low" || top.exactScore === 0 || top.fuzzyScore < 0.95);

  if (top.calibratedScore < thresholds.minimumCredibleScore) {
    return logResolution({
      status: "not_found",
      entityType,
      candidates: scored.slice(0, 3).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        confidence: Number(candidate.calibratedScore.toFixed(4)),
        reason: candidate.reason,
      })),
      reason: `No ${entityType} match was strong enough to resolve safely.`,
    });
  }

  if (needsConfirmation || top.calibratedScore < Math.max(accessThreshold, thresholds.confirm)) {
    return logResolution({
      status: "confirm",
      entityType,
      match: { id: top.id, name: top.name },
      confidence: Number(top.calibratedScore.toFixed(4)),
      candidates: scored.slice(0, 3).map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        confidence: Number(candidate.calibratedScore.toFixed(4)),
        reason: candidate.reason,
      })),
      reason: top.reason,
    });
  }

  return logResolution({
    status: "resolved",
    entityType,
    match: { id: top.id, name: top.name },
    confidence: Number(top.calibratedScore.toFixed(4)),
    candidates: scored.slice(0, 3).map((candidate) => ({
      id: candidate.id,
      name: candidate.name,
      confidence: Number(candidate.calibratedScore.toFixed(4)),
      reason: candidate.reason,
    })),
    reason: top.reason,
  });
}

async function resolveEntityReferenceAcrossTypes(
  request: EntityResolutionRequest,
  entityTypes: ResolvedEntityType[],
): Promise<EntityResolutionResult> {
  const explicitMention = normalizeText(request.mention ?? "");
  const contextOnly = explicitMention.length === 0;
  const results = await Promise.all(
    entityTypes.map(async (entityType) => {
      const result = await resolveEntityReferenceForType({
        ...request,
        entityType,
        expectedEntityTypes: [entityType],
      }, entityType, { suppressObservability: true });
      return { entityType, result };
    }),
  );

  const winners = results
    .filter((entry) => entry.result.status !== "not_found")
    .map((entry) => ({
      entityType: entry.entityType,
      result: entry.result,
      confidence: entry.result.confidence ?? 0,
      match: entry.result.match ?? null,
      candidates: entry.result.candidates ?? [],
    }))
    .filter((entry) => entry.match);

  const entityTypeLabel = buildRequestedEntityTypeLabel(entityTypes);

  if (winners.length === 0) {
    const result: EntityResolutionResult = {
      status: "not_found",
      entityType: entityTypes[0]!,
      reason: `I couldn't find a credible match across ${entityTypes.join(", ")} in this workspace.`,
    };
    void emitResolutionObservability({
      request,
      entityTypeLabel,
      expectedEntityTypes: entityTypes,
      result,
      contextOnly,
    });
    return result;
  }

  const sorted = winners
    .sort((left, right) => {
      if (right.confidence !== left.confidence) return right.confidence - left.confidence;
      return (left.match?.name ?? "").localeCompare(right.match?.name ?? "");
    });
  const top = sorted[0]!;
  const second = sorted[1];
  const mixedTypes = new Set(sorted.map((entry) => entry.entityType)).size > 1;

  if (
    second &&
    (
      relativeGap(top.confidence, second.confidence) < 0.05 ||
      ((top.confidence - second.confidence) / Math.max(top.confidence, 0.0001)) < 0.05
    )
  ) {
    const result: EntityResolutionResult = {
      status: "ambiguous",
      entityType: top.entityType,
      candidates: buildLabeledCandidates(
        sorted.slice(0, 5).map((entry) => ({
          id: entry.match!.id,
          name: entry.match!.name,
          entityType: entry.entityType,
          confidence: Number(entry.confidence.toFixed(4)),
          reason: entry.result.reason,
        })),
        mixedTypes,
      ),
      reason: `Multiple ${entityTypes.join("/")} candidates were too close to resolve safely.`,
    };
    void emitResolutionObservability({
      request,
      entityTypeLabel,
      expectedEntityTypes: entityTypes,
      result,
      contextOnly,
    });
    return result;
  }

  const result: EntityResolutionResult = {
    status: top.result.status,
    entityType: top.entityType,
    confidence: Number(top.confidence.toFixed(4)),
    candidates: buildLabeledCandidates(
      sorted.slice(0, 5).map((entry) => ({
        id: entry.match!.id,
        name: entry.match!.name,
        entityType: entry.entityType,
        confidence: Number(entry.confidence.toFixed(4)),
        reason: entry.result.reason,
      })),
      mixedTypes,
    ),
    reason: top.result.reason,
    ...(top.match ? { match: top.match } : {}),
  };
  void emitResolutionObservability({
    request,
    entityTypeLabel,
    expectedEntityTypes: entityTypes,
    result,
    contextOnly,
  });
  return result;
}
