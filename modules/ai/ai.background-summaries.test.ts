import test from "node:test";
import assert from "node:assert/strict";
import { aggregateMetrics } from "./ai.background-summaries.js";

test("stored summaries keep aggregate numbers and drop per-person data (F-43)", () => {
  const teamSummary = {
    velocity: { value: 12, direction: "down", series: [1, 2] },
    avgResolutionTime: { value: 30, unit: "hours" },
    openIssues: 9,
    timelineHealth: "behind",
    workloadDistribution: [{ userId: "u1", name: "Mike", assigned: 9, open: 9 }],
    completionRatePerMember: [{ userId: "u1", name: "Mike", completionRate: 10 }],
    overduePerMember: [{ userId: "u1", overdue: 9 }],
    lead: { user: { id: "u2", name: "Lena" } },
  };
  assert.deepEqual(aggregateMetrics(teamSummary), {
    velocity: { value: 12, direction: "down" },
    avgResolutionTime: { value: 30, unit: "hours" },
    openIssues: 9,
    timelineHealth: "behind",
  });
  assert.deepEqual(aggregateMetrics(undefined), {});
});
