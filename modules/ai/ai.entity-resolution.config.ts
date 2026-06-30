export type ResolverFlowPolicy = "read" | "navigation" | "low_risk_mutation" | "high_risk_mutation";

export type ResolverScoreWeights = {
  exact: number;
  fuzzy: number;
  embedding: number;
  context: number;
  localeAliasBoost: number;
};

export type ResolverFlowThresholds = {
  autoResolve: number;
  confirm: number;
  ambiguousGap: number;
  ambiguousDeltaRatio: number;
  minimumCredibleScore: number;
};

export const RESOLVER_SCORE_WEIGHTS: ResolverScoreWeights = {
  exact: 0.55,
  fuzzy: 0.25,
  embedding: 0.15,
  context: 1,
  localeAliasBoost: 0.04,
};

export const RESOLVER_FLOW_THRESHOLDS: Record<ResolverFlowPolicy, ResolverFlowThresholds> = {
  read: {
    autoResolve: 0.92,
    confirm: 0.8,
    ambiguousGap: 0.05,
    ambiguousDeltaRatio: 0.05,
    minimumCredibleScore: 0.8,
  },
  navigation: {
    autoResolve: 0.9,
    confirm: 0.78,
    ambiguousGap: 0.05,
    ambiguousDeltaRatio: 0.05,
    minimumCredibleScore: 0.78,
  },
  low_risk_mutation: {
    autoResolve: 0.88,
    confirm: 0.8,
    ambiguousGap: 0.05,
    ambiguousDeltaRatio: 0.05,
    minimumCredibleScore: 0.8,
  },
  high_risk_mutation: {
    autoResolve: 0.94,
    confirm: 0.86,
    ambiguousGap: 0.04,
    ambiguousDeltaRatio: 0.04,
    minimumCredibleScore: 0.86,
  },
};

export function getResolverFlowPolicy(input: {
  accessMode: "read" | "mutation";
  actionRisk: "low" | "medium" | "high";
  navigationIntent?: boolean | undefined;
}): ResolverFlowPolicy {
  if (input.navigationIntent) return "navigation";
  if (input.accessMode === "read") return "read";
  if (input.actionRisk === "high") return "high_risk_mutation";
  return "low_risk_mutation";
}
