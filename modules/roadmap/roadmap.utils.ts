const MS_PER_DAY = 1000 * 60 * 60 * 24;

export type RoadmapView = "MONTH" | "QUARTER";
export type RoadmapHealth = "ON_TRACK" | "AT_RISK" | "OFF_TRACK" | "BLOCKED" | "NO_SIGNAL";

export interface RoadmapWindow {
  view: RoadmapView;
  from: string;
  to: string;
  label: string;
  previous: { from: string; to: string; label: string };
  next: { from: string; to: string; label: string };
}

function toUtcDate(value: Date | string) {
  const date = value instanceof Date ? value : new Date(value);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addUtcDays(date: Date, days: number) {
  return new Date(date.getTime() + (days * MS_PER_DAY));
}

function startOfUtcMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function endOfUtcMonth(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0));
}

function startOfUtcQuarter(date: Date) {
  const month = Math.floor(date.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(date.getUTCFullYear(), month, 1));
}

function endOfUtcQuarter(date: Date) {
  const month = Math.floor(date.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(date.getUTCFullYear(), month + 3, 0));
}

function addUtcMonths(date: Date, months: number) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1));
}

function formatMonthLabel(date: Date) {
  return date.toLocaleString("en-US", {
    month: "short",
    year: "numeric",
    timeZone: "UTC",
  });
}

function formatQuarterLabel(date: Date) {
  const quarter = Math.floor(date.getUTCMonth() / 3) + 1;
  return `Q${quarter} ${date.getUTCFullYear()}`;
}

export function toIsoDate(value: Date | string | null | undefined) {
  if (!value) return null;
  return toUtcDate(value).toISOString().slice(0, 10);
}

export function toIsoDateTime(value: Date | string | null | undefined) {
  if (!value) return null;
  return new Date(value).toISOString();
}

export function inclusiveDaySpan(start: Date | string, end: Date | string) {
  const from = toUtcDate(start);
  const to = toUtcDate(end);
  return Math.max(1, Math.floor((to.getTime() - from.getTime()) / MS_PER_DAY) + 1);
}

export function getRoadmapWindow(view: RoadmapView, from?: string, to?: string): RoadmapWindow {
  const seed = from ? toUtcDate(from) : toUtcDate(new Date());

  const currentFrom = view === "MONTH" ? startOfUtcMonth(seed) : startOfUtcQuarter(seed);
  const currentTo = to ? toUtcDate(to) : view === "MONTH" ? endOfUtcMonth(seed) : endOfUtcQuarter(seed);

  const previousSeed = view === "MONTH" ? addUtcMonths(currentFrom, -1) : addUtcMonths(currentFrom, -3);
  const nextSeed = view === "MONTH" ? addUtcMonths(currentFrom, 1) : addUtcMonths(currentFrom, 3);

  const previousFrom = view === "MONTH" ? startOfUtcMonth(previousSeed) : startOfUtcQuarter(previousSeed);
  const previousTo = view === "MONTH" ? endOfUtcMonth(previousSeed) : endOfUtcQuarter(previousSeed);
  const nextFrom = view === "MONTH" ? startOfUtcMonth(nextSeed) : startOfUtcQuarter(nextSeed);
  const nextTo = view === "MONTH" ? endOfUtcMonth(nextSeed) : endOfUtcQuarter(nextSeed);

  return {
    view,
    from: toIsoDate(currentFrom)!,
    to: toIsoDate(currentTo)!,
    label: view === "MONTH" ? formatMonthLabel(currentFrom) : formatQuarterLabel(currentFrom),
    previous: {
      from: toIsoDate(previousFrom)!,
      to: toIsoDate(previousTo)!,
      label: view === "MONTH" ? formatMonthLabel(previousFrom) : formatQuarterLabel(previousFrom),
    },
    next: {
      from: toIsoDate(nextFrom)!,
      to: toIsoDate(nextTo)!,
      label: view === "MONTH" ? formatMonthLabel(nextFrom) : formatQuarterLabel(nextFrom),
    },
  };
}

export function getTimelineLayout(
  projectStart: Date | string | null | undefined,
  projectTarget: Date | string | null | undefined,
  windowFrom: string,
  windowTo: string,
) {
  if (!projectStart || !projectTarget) {
    return null;
  }

  const start = toUtcDate(projectStart);
  const target = toUtcDate(projectTarget);
  const from = toUtcDate(windowFrom);
  const to = toUtcDate(windowTo);

  const totalDays = inclusiveDaySpan(from, to);
  const visibleStart = start < from ? from : start;
  const visibleEnd = target > to ? to : target;
  const overlaps = visibleStart <= to && visibleEnd >= from;

  const offsetDays = Math.max(0, Math.floor((visibleStart.getTime() - from.getTime()) / MS_PER_DAY));
  const widthDays = overlaps ? inclusiveDaySpan(visibleStart, visibleEnd) : 0;

  return {
    startsBeforeWindow: start < from,
    endsAfterWindow: target > to,
    overlapsWindow: overlaps,
    offsetPercent: Number(((offsetDays / totalDays) * 100).toFixed(2)),
    widthPercent: Number(((widthDays / totalDays) * 100).toFixed(2)),
    durationDays: inclusiveDaySpan(start, target),
  };
}

export function getExpectedProgressPercent(
  startDate: Date | string | null | undefined,
  targetDate: Date | string | null | undefined,
  now = new Date(),
) {
  if (!startDate || !targetDate) {
    return null;
  }

  const start = toUtcDate(startDate);
  const target = toUtcDate(targetDate);
  const current = toUtcDate(now);
  const totalDays = inclusiveDaySpan(start, target);

  if (current <= start) return 0;
  if (current >= target) return 100;

  const elapsedDays = inclusiveDaySpan(start, current);
  return Math.max(0, Math.min(100, Math.round((elapsedDays / totalDays) * 100)));
}

export function getForecastStatus(progress: number, expectedProgress: number | null) {
  if (expectedProgress === null) {
    return {
      expectedProgress: null,
      variance: null,
      status: "NO_SIGNAL" as const,
    };
  }

  const variance = progress - expectedProgress;

  if (variance <= -25) {
    return { expectedProgress, variance, status: "OFF_TRACK" as const };
  }
  if (variance <= -10) {
    return { expectedProgress, variance, status: "AT_RISK" as const };
  }

  return { expectedProgress, variance, status: "ON_TRACK" as const };
}

export function computeRoadmapHealth(input: {
  startDate?: Date | string | null;
  targetDate?: Date | string | null;
  progress: number;
  blocked: boolean;
  overdueMilestoneCount: number;
  projectStatus: string;
  now?: Date;
}) {
  const now = input.now ?? new Date();
  const reasons: string[] = [];

  if (input.blocked) {
    reasons.push("BLOCKED_BY_DEPENDENCY");
    return { status: "BLOCKED" as RoadmapHealth, reasons };
  }

  if (!input.startDate || !input.targetDate) {
    reasons.push("MISSING_SCHEDULE");
    return { status: "NO_SIGNAL" as RoadmapHealth, reasons };
  }

  const targetDate = toUtcDate(input.targetDate);
  const today = toUtcDate(now);
  const expectedProgress = getExpectedProgressPercent(input.startDate, input.targetDate, now);
  const forecast = getForecastStatus(input.progress, expectedProgress);

  if (input.projectStatus !== "COMPLETED" && targetDate < today) {
    reasons.push("TARGET_DATE_PASSED");
  }
  if (input.overdueMilestoneCount > 0) {
    reasons.push("OVERDUE_MILESTONES");
  }
  if (forecast.variance !== null && forecast.variance <= -10) {
    reasons.push("PROGRESS_LAGGING");
  }

  if (reasons.includes("TARGET_DATE_PASSED") || input.overdueMilestoneCount > 1 || forecast.status === "OFF_TRACK") {
    return { status: "OFF_TRACK" as RoadmapHealth, reasons };
  }

  if (input.overdueMilestoneCount > 0 || forecast.status === "AT_RISK") {
    return { status: "AT_RISK" as RoadmapHealth, reasons };
  }

  return { status: "ON_TRACK" as RoadmapHealth, reasons };
}

export function getHealthSeverityValue(status: RoadmapHealth) {
  switch (status) {
    case "BLOCKED":
      return 5;
    case "OFF_TRACK":
      return 4;
    case "AT_RISK":
      return 3;
    case "NO_SIGNAL":
      return 2;
    case "ON_TRACK":
    default:
      return 1;
  }
}

export function isDateOutsideRange(
  date: Date | string,
  startDate: Date | string | null | undefined,
  targetDate: Date | string | null | undefined,
) {
  if (!startDate || !targetDate) {
    return false;
  }

  const value = new Date(date);
  const start = new Date(startDate);
  const target = new Date(targetDate);

  return value < start || value > target;
}

export function uniqueIds(values: string[]) {
  return [...new Set(values)];
}

export function buildDependencyGraphEdges(rows: Array<{ blockingProjectId: string; blockedProjectId: string }>) {
  const graph = new Map<string, Set<string>>();

  for (const row of rows) {
    const current = graph.get(row.blockingProjectId) ?? new Set<string>();
    current.add(row.blockedProjectId);
    graph.set(row.blockingProjectId, current);
  }

  return graph;
}

export function detectDependencyCycle(
  rows: Array<{ blockingProjectId: string; blockedProjectId: string }>,
  blockingProjectId: string,
  blockedProjectId: string,
) {
  const graph = buildDependencyGraphEdges(rows);

  const stack: string[] = [blockedProjectId];
  const visited = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === blockingProjectId) {
      return true;
    }
    if (visited.has(current)) {
      continue;
    }
    visited.add(current);
    const next = graph.get(current);
    if (!next) continue;
    for (const value of next) {
      stack.push(value);
    }
  }

  return false;
}

export function getNowIsoDate() {
  return toIsoDate(new Date())!;
}

export function getDateDiffDays(from: Date | string, to: Date | string) {
  return Math.floor((toUtcDate(to).getTime() - toUtcDate(from).getTime()) / MS_PER_DAY);
}

export function addDaysToIsoDate(value: Date | string, days: number) {
  return toIsoDate(addUtcDays(toUtcDate(value), days))!;
}
