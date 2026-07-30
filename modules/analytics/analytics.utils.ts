import { AppError } from "../../shared/utils/api-error.js";
import { ERROR_CODES } from "../../shared/errors/error-codes.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const PDFDocument = require("pdfkit") as any;

export interface DateRange {
  from: Date;
  to: Date;
  previousFrom: Date;
  previousTo: Date;
}

const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_ANALYTICS_RANGE_DAYS = 180;

function startOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function endOfDay(date: Date) {
  const copy = new Date(date);
  copy.setHours(23, 59, 59, 999);
  return copy;
}

function addDays(date: Date, days: number) {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

function assertValidDate(value: string | undefined, field: string) {
  if (!value) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, `${field} is required for custom period`);
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, `${field} must be a valid date`);
  }

  return parsed;
}

export function resolveDateRange(period: string, from?: string, to?: string): DateRange {
  if (period === "custom") {
    const customFrom = startOfDay(assertValidDate(from, "from"));
    const customTo = endOfDay(assertValidDate(to, "to"));

    if (customFrom > customTo) {
      throw new AppError(422, ERROR_CODES.VALIDATION_ERROR, "from must be before or equal to to");
    }

    const durationMs = customTo.getTime() - customFrom.getTime() + 1;
    const durationDays = Math.ceil(durationMs / ONE_DAY_MS);
    if (durationDays > MAX_ANALYTICS_RANGE_DAYS) {
      throw new AppError(
        422,
        ERROR_CODES.VALIDATION_ERROR,
        `Custom analytics ranges cannot exceed ${MAX_ANALYTICS_RANGE_DAYS} days`,
      );
    }

    return {
      from: customFrom,
      to: customTo,
      previousFrom: new Date(customFrom.getTime() - durationMs),
      previousTo: new Date(customTo.getTime() - durationMs),
    };
  }

  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;
  const today = new Date();
  const rangeTo = endOfDay(today);
  const rangeFrom = startOfDay(addDays(today, -(days - 1)));
  const previousTo = endOfDay(addDays(rangeFrom, -1));
  const previousFrom = startOfDay(addDays(previousTo, -(days - 1)));

  return {
    from: rangeFrom,
    to: rangeTo,
    previousFrom,
    previousTo,
  };
}

/**
 * Builds a DateRange from a fixed, already-known window (e.g. a cycle's own scheduled
 * start/end dates) instead of a rolling period from today. Burndown/velocity charts for a
 * specific cycle must span that cycle's actual dates — a cycle's window doesn't move just
 * because "today" changed, unlike the 7d/30d/90d rolling periods used elsewhere.
 */
export function resolveFixedDateRange(from: Date, to: Date): DateRange {
  const normalizedFrom = startOfDay(from);
  const normalizedTo = endOfDay(to);
  const durationMs = Math.max(ONE_DAY_MS, normalizedTo.getTime() - normalizedFrom.getTime() + 1);

  return {
    from: normalizedFrom,
    to: normalizedTo,
    previousFrom: new Date(normalizedFrom.getTime() - durationMs),
    previousTo: new Date(normalizedTo.getTime() - durationMs),
  };
}

export function calculateTrend(current: number, previous: number): { value: number; direction: "up" | "down" | "flat" } {
  if (previous === 0 && current === 0) {
    return { value: 0, direction: "flat" };
  }

  if (previous === 0) {
    return { value: 100, direction: "up" };
  }

  const value = Math.round(((current - previous) / previous) * 100);
  return {
    value,
    direction: value > 0 ? "up" : value < 0 ? "down" : "flat",
  };
}

export function avgResolutionTime(issues: Array<{ createdAt: Date; completedAt: Date | null }>): number {
  const completed = issues.filter((issue) => issue.completedAt instanceof Date);
  if (completed.length === 0) {
    return 0;
  }

  const total = completed.reduce((sum, issue) => sum + (issue.completedAt!.getTime() - issue.createdAt.getTime()), 0);
  return Math.round(total / completed.length);
}

export function formatDayKey(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function buildDaySeries(from: Date, to: Date) {
  const start = startOfDay(from);
  const end = startOfDay(to);
  const days: Date[] = [];

  for (let cursor = start; cursor <= end; cursor = addDays(cursor, 1)) {
    days.push(new Date(cursor));
  }

  return days;
}

export function msToReadableUnit(ms: number): { value: number; unit: "hours" | "days" } {
  if (ms >= ONE_DAY_MS) {
    return { value: Number((ms / ONE_DAY_MS).toFixed(1)), unit: "days" };
  }

  return { value: Number((ms / (60 * 60 * 1000)).toFixed(1)), unit: "hours" };
}

function csvEscape(value: unknown): string {
  const raw = value == null ? "" : typeof value === "string" ? value : String(value);
  const safe = raw.replace(/"/g, '""');
  return /[",\n]/.test(safe) ? `"${safe}"` : safe;
}

function csvRow(cells: unknown[]): string {
  return cells.map(csvEscape).join(",");
}

/** One title row + header row + data rows, ready to be joined with other blocks by a blank line. */
function buildCsvTable(title: string, headers: string[], rows: unknown[][]): string {
  if (headers.length === 0) return "";
  return [csvRow([title]), csvRow(headers), ...rows.map(csvRow)].join("\n");
}

// ─── PDF report rendering ─────────────────────────────────────────────────
//
// The PDF is a curated, human-facing report — not a dump of the raw JSON
// payload. Internal IDs, avatar URLs, and machine metadata are stripped;
// percentages/trends/durations are formatted in plain language; long
// day-by-day series are bucketed into weekly rows; and every array renders
// as a real bordered table instead of pipe-separated text.

const HIDDEN_FIELDS = new Set([
  "id", "userId", "teamId", "projectId", "cycleId", "assigneeId", "creatorId",
  "leadId", "scopeId", "issueId", "targetId", "avatar", "metadata",
]);

const PERCENT_FIELDS = new Set([
  "progress", "completionRate", "efficiency", "workloadPercent", "teamWorkload",
]);

const PAGE_WIDTH = 495; // A4 minus 2x 50pt margin
const PAGE_LEFT = 50;
const PAGE_BOTTOM = 780;

function humanizeKey(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatDateHuman(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

function formatNumber(value: number): string {
  return Number.isInteger(value) ? value.toLocaleString("en-US") : value.toFixed(1);
}

/** Renders a single leaf value for a table cell — flattens nested objects to their name/label, formats dates. */
function flattenCellValue(value: unknown): string {
  if (value == null) return "—";
  if (value instanceof Date) return formatDateHuman(value);
  if (typeof value === "number") return formatNumber(value);
  if (typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    if (typeof obj.name === "string") return obj.name;
    if (typeof obj.label === "string") return obj.label;
    const parts = Object.values(obj).filter((v) => typeof v === "string" || typeof v === "number");
    return parts.length > 0 ? parts.join(" ") : "—";
  }
  return String(value);
}

/** Renders a summary metric — handles {value,unit}, {value,trend,direction}, {open,closed} shapes and plain values. */
function formatSummaryValue(key: string, value: unknown): string {
  if (value == null) return "—";

  if (typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;

    if ("open" in v && "closed" in v) {
      return `${v.open} open / ${v.closed} closed`;
    }

    if ("value" in v && "trend" in v && "direction" in v) {
      const suffix = PERCENT_FIELDS.has(key) ? "%" : "";
      const trend = Number(v.trend);
      const direction = v.direction as string;
      const trendText = direction === "flat" || trend === 0
        ? "no change vs previous period"
        : `${direction === "up" ? "+" : "-"}${Math.abs(trend)}% vs previous period`;
      return `${formatNumber(Number(v.value))}${suffix}  (${trendText})`;
    }

    if ("value" in v && "unit" in v) {
      return `${formatNumber(Number(v.value))} ${v.unit}`;
    }

    return Object.entries(v).map(([k, val]) => `${humanizeKey(k)}: ${flattenCellValue(val)}`).join(", ");
  }

  if (typeof value === "number") {
    return PERCENT_FIELDS.has(key) ? `${value}%` : formatNumber(value);
  }

  if (typeof value === "string") {
    return /^[a-z-]+$/i.test(value) && value.includes("-") ? humanizeKey(value) : value;
  }

  return String(value);
}

function isoWeekStart(date: Date): Date {
  const copy = startOfDay(date);
  const day = copy.getDay();
  const diff = (day === 0 ? -6 : 1) - day;
  copy.setDate(copy.getDate() + diff);
  return copy;
}

/** Buckets a long day-by-day series into weekly rows so a 90d report doesn't render 90+ table rows. */
function aggregateWeekly(rows: Array<Record<string, unknown>>, mode: "sum" | "last"): Array<Record<string, unknown>> {
  if (rows.length <= 14) return rows;

  const buckets = new Map<string, Record<string, unknown>>();
  for (const row of rows) {
    const date = new Date(String(row.date));
    const weekKey = formatDayKey(isoWeekStart(date));
    const existing = buckets.get(weekKey);

    if (!existing) {
      buckets.set(weekKey, { ...row, date: weekKey });
      continue;
    }

    for (const [field, fieldValue] of Object.entries(row)) {
      if (field === "date" || typeof fieldValue !== "number") continue;
      existing[field] = mode === "sum" ? (Number(existing[field]) || 0) + fieldValue : fieldValue;
    }
  }

  return [...buckets.values()];
}

// Explicit short labels for keys whose humanized form is too long to fit a table
// column header without wrapping (e.g. "avgResolutionHours" -> "AVG RESOLUTION HOURS").
const SHORT_LABELS: Record<string, string> = {
  avgResolutionHours: "Avg Res. (hrs)",
  completionRate: "Completion %",
  completed: "Done",
  stuckDays: "Stuck (days)",
  memberCount: "Members",
  cycleNumber: "Cycle #",
  cycleName: "Cycle",
  teamName: "Team",
  projectName: "Project",
};

function labelForKey(key: string) {
  return SHORT_LABELS[key] ?? humanizeKey(key);
}

/** Truncates text to fit maxWidth at the doc's current font, appending an ellipsis — done by hand
 * rather than relying on PDFKit's `ellipsis`/`lineBreak` text options, which don't reliably suppress
 * wrapping together and were letting long headers wrap across lines and overlap the row below. */
function fitText(doc: any, text: string, maxWidth: number): string {
  if (doc.widthOfString(text) <= maxWidth) return text;
  let truncated = text;
  while (truncated.length > 1 && doc.widthOfString(`${truncated}…`) > maxWidth) {
    truncated = truncated.slice(0, -1);
  }
  return `${truncated}…`;
}

function rowsToTable(rows: Array<Record<string, unknown>>): { headers: string[]; body: string[][] } {
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((key) => !HIDDEN_FIELDS.has(key));
  const headers = keys.map(labelForKey);
  const body = rows.map((row) =>
    keys.map((key) => {
      const value = row[key];
      if (typeof value === "number" && PERCENT_FIELDS.has(key)) return `${value}%`;
      return flattenCellValue(value);
    }),
  );
  return { headers, body };
}

const WIDE_FIRST_COLUMNS = new Set(["Name", "Title", "Date", "Team Name", "Cycle Name", "Project Name", "Status"]);

function computeColWidths(headers: string[]): number[] {
  const n = headers.length;
  if (n === 0) return [];
  if (n === 1 || !WIDE_FIRST_COLUMNS.has(headers[0]!)) {
    return headers.map(() => PAGE_WIDTH / n);
  }
  const firstWidth = Math.min(PAGE_WIDTH * 0.3, 160);
  const rest = (PAGE_WIDTH - firstWidth) / (n - 1);
  return [firstWidth, ...Array(n - 1).fill(rest)];
}

function drawSectionHeading(doc: any, title: string) {
  if (doc.y > 700) doc.addPage();
  doc.moveDown(0.9);
  doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a").text(title);
  doc.moveDown(0.4);
}

function drawTable(doc: any, headers: string[], rows: string[][]) {
  if (headers.length === 0) {
    doc.font("Helvetica").fontSize(9).fillColor("#64748b").text("No data available.");
    doc.x = PAGE_LEFT;
    return;
  }

  const colWidths = computeColWidths(headers);
  const rowHeight = 20;
  const headerFontSize = headers.length >= 6 ? 7.5 : 8.5;

  // Headers show their full text (wrapped onto multiple lines if needed) rather than being
  // truncated with an ellipsis — the header box height is measured up front so wrapped text
  // never overlaps the row below it.
  const drawHeaderRow = () => {
    const y = doc.y;
    doc.font("Helvetica-Bold").fontSize(headerFontSize);
    const cellHeights = headers.map((header, i) => doc.heightOfString(header.toUpperCase(), { width: colWidths[i]! - 12 }));
    const headerHeight = Math.max(22, Math.max(...cellHeights) + 12);

    doc.rect(PAGE_LEFT, y, PAGE_WIDTH, headerHeight).fill("#f1f5f9");
    doc.fillColor("#0f172a");
    let x = PAGE_LEFT;
    headers.forEach((header, i) => {
      doc.text(header.toUpperCase(), x + 6, y + 6, { width: colWidths[i]! - 12 });
      x += colWidths[i]!;
    });
    doc.x = PAGE_LEFT;
    doc.y = y + headerHeight;
  };

  drawHeaderRow();

  rows.forEach((row, index) => {
    if (doc.y + rowHeight > PAGE_BOTTOM) {
      doc.addPage();
      doc.y = 50;
      drawHeaderRow();
    }

    const y = doc.y;
    if (index % 2 === 1) {
      doc.rect(PAGE_LEFT, y, PAGE_WIDTH, rowHeight).fill("#f8fafc");
    }

    doc.fillColor("#1e293b").font("Helvetica").fontSize(9);
    let x = PAGE_LEFT;
    row.forEach((cell, i) => {
      const cellWidth = colWidths[i]! - 12;
      doc.text(fitText(doc, cell, cellWidth), x + 6, y + 5, { lineBreak: false });
      x += colWidths[i]!;
    });

    doc.strokeColor("#e2e8f0").lineWidth(0.5)
      .moveTo(PAGE_LEFT, y + rowHeight).lineTo(PAGE_LEFT + PAGE_WIDTH, y + rowHeight).stroke();

    doc.y = y + rowHeight;
  });

  // Reset the text cursor to the left margin — otherwise PDFKit remembers the x position of the
  // last cell we drew (near the right edge), and any free-flowing text drawn after this table
  // (e.g. the footer) would start there and wrap into a narrow column instead of using the full
  // page width.
  doc.x = PAGE_LEFT;
  doc.moveDown(0.8);
}

function drawProgressBar(doc: any, percent: number) {
  const width = 220;
  const height = 8;
  const x = PAGE_LEFT;
  const y = doc.y + 3;
  const clamped = Math.max(0, Math.min(100, percent));

  doc.roundedRect(x, y, width, height, height / 2).fill("#e2e8f0");
  if (clamped > 0) {
    doc.roundedRect(x, y, Math.max(height, (width * clamped) / 100), height, height / 2).fill("#4f46e5");
  }

  doc.x = PAGE_LEFT;
  doc.y = y + height + 8;
}

function renderEntitySubtitle(doc: any, entity: Record<string, unknown>) {
  if (typeof entity.name !== "string") return;

  doc.font("Helvetica-Bold").fontSize(13).fillColor("#0f172a").text(entity.name);

  const details: string[] = [];
  if (typeof entity.startDate === "string" || entity.startDate instanceof Date) {
    details.push(`Start ${formatDateHuman(entity.startDate as string)}`);
  }
  if (typeof entity.targetDate === "string" || entity.targetDate instanceof Date) {
    details.push(`Target ${formatDateHuman(entity.targetDate as string)}`);
  }
  if (typeof entity.email === "string") {
    details.push(entity.email);
  }

  if (details.length > 0) {
    doc.font("Helvetica").fontSize(9).fillColor("#64748b").text(details.join("   ·   "));
  }

  doc.moveDown(0.6);
}

function renderChartSection(doc: any, title: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;

  drawSectionHeading(doc, title);

  const isDateSeries = "date" in rows[0]!;
  const displayRows = isDateSeries
    ? aggregateWeekly(rows, "remaining" in rows[0]! ? "last" : "sum")
    : rows;

  const { headers, body } = rowsToTable(displayRows);
  drawTable(doc, headers, body);
}

function renderTableSection(doc: any, title: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return;

  drawSectionHeading(doc, title);
  const { headers, body } = rowsToTable(rows.slice(0, 25));
  drawTable(doc, headers, body);
}

export async function buildAnalyticsPdf(options: {
  title: string;
  scope: string;
  period: string;
  payload: Record<string, unknown>;
}) {
  const { title, scope, period, payload } = options;
  const provenance = payload.provenance as
    | { range?: { from?: string; to?: string }; partialDataNotes?: string[] }
    | undefined;
  const rangeText = provenance?.range?.from && provenance?.range?.to
    ? `${formatDateHuman(provenance.range.from)} – ${formatDateHuman(provenance.range.to)}`
    : null;

  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    info: {
      Title: title,
      Author: "Trussen",
      Subject: `${scope} analytics export`,
    },
  });

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve());
    doc.on("error", reject);

    doc.rect(0, 0, 595, 100).fill("#0f172a");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(22).text(title, 50, 34);
    const subtitle = [`${humanizeKey(scope)} report`, rangeText ? `Range ${rangeText}` : `Period ${period.toUpperCase()}`].join("   ·   ");
    doc.font("Helvetica").fontSize(10).fillColor("#cbd5e1").text(subtitle, 50, 66);

    doc.y = 130;

    const entity = (payload.project ?? payload.team ?? payload.member ?? payload.cycle) as
      | Record<string, unknown>
      | undefined;
    if (entity) renderEntitySubtitle(doc, entity);

    if (payload.summary && typeof payload.summary === "object") {
      drawSectionHeading(doc, "Summary");
      for (const [key, value] of Object.entries(payload.summary as Record<string, unknown>)) {
        if (doc.y > 740) doc.addPage();
        doc.font("Helvetica-Bold").fontSize(10).fillColor("#334155").text(`${humanizeKey(key)}:  `, { continued: true });
        doc.font("Helvetica").fontSize(10).fillColor("#0f172a").text(formatSummaryValue(key, value));

        // Visualize percentage-of-completion metrics (progress, completion rate) as a bar
        // instead of leaving them as plain text.
        const barPercent = key === "progress" && typeof value === "number"
          ? value
          : key === "completionRate" && value && typeof value === "object" && "value" in (value as Record<string, unknown>)
            ? Number((value as Record<string, unknown>).value)
            : null;

        if (barPercent !== null && !Number.isNaN(barPercent)) {
          drawProgressBar(doc, barPercent);
        }
      }
    }

    if (payload.charts && typeof payload.charts === "object") {
      for (const [key, value] of Object.entries(payload.charts as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          renderChartSection(doc, humanizeKey(key), value as Array<Record<string, unknown>>);
        }
      }
    }

    if (payload.tables && typeof payload.tables === "object") {
      for (const [key, value] of Object.entries(payload.tables as Record<string, unknown>)) {
        if (Array.isArray(value)) {
          renderTableSection(doc, humanizeKey(key), value as Array<Record<string, unknown>>);
        }
      }
    }

    doc.moveDown(1);
    if (doc.y > 740) doc.addPage();
    doc.font("Helvetica").fontSize(8).fillColor("#94a3b8");
    doc.text(`Generated ${formatDateHuman(new Date())} by Trussen.`);
    for (const note of provenance?.partialDataNotes ?? []) {
      doc.text(`Note: ${note}`);
    }

    doc.end();
  });

  return Buffer.concat(chunks);
}

// ─── CSV report rendering ─────────────────────────────────────────────────
//
// One CSV file, but structured as a sequence of small, coherent tables (Report Info, Summary,
// then one table per chart/table section) rather than a single sparse table unioning every
// field from every section — the old approach produced a wall of mostly-blank columns since a
// burndown row and a member-workload row share almost no fields. Reuses the same field-cleaning
// (dropped IDs, humanized labels, percent formatting) already built for the PDF renderer.

export function buildAnalyticsCsv(options: {
  title: string;
  scope: string;
  period: string;
  payload: Record<string, unknown>;
}): string {
  const { title, scope, period, payload } = options;
  const provenance = payload.provenance as
    | { range?: { from?: string; to?: string }; partialDataNotes?: string[] }
    | undefined;
  const rangeText = provenance?.range?.from && provenance?.range?.to
    ? `${formatDateHuman(provenance.range.from)} to ${formatDateHuman(provenance.range.to)}`
    : period.toUpperCase();

  const blocks: string[] = [];

  blocks.push(buildCsvTable("Report Info", ["Field", "Value"], [
    ["Report", title],
    ["Scope", humanizeKey(scope)],
    ["Range", rangeText],
    ["Generated", formatDateHuman(new Date())],
  ]));

  const entity = (payload.project ?? payload.team ?? payload.member ?? payload.cycle) as
    | Record<string, unknown>
    | undefined;
  if (entity && typeof entity.name === "string") {
    const entityRows: unknown[][] = [["Name", entity.name]];
    if (entity.startDate) entityRows.push(["Start Date", formatDateHuman(entity.startDate as string)]);
    if (entity.targetDate) entityRows.push(["Target Date", formatDateHuman(entity.targetDate as string)]);
    if (typeof entity.email === "string") entityRows.push(["Email", entity.email]);
    blocks.push(buildCsvTable(humanizeKey(scope), ["Field", "Value"], entityRows));
  }

  if (payload.summary && typeof payload.summary === "object") {
    const rows = Object.entries(payload.summary as Record<string, unknown>).map(
      ([key, value]) => [humanizeKey(key), formatSummaryValue(key, value)],
    );
    blocks.push(buildCsvTable("Summary", ["Metric", "Value"], rows));
  }

  if (payload.charts && typeof payload.charts === "object") {
    for (const [key, value] of Object.entries(payload.charts as Record<string, unknown>)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      const { headers, body } = rowsToTable(value as Array<Record<string, unknown>>);
      blocks.push(buildCsvTable(humanizeKey(key), headers, body));
    }
  }

  if (payload.tables && typeof payload.tables === "object") {
    for (const [key, value] of Object.entries(payload.tables as Record<string, unknown>)) {
      if (!Array.isArray(value) || value.length === 0) continue;
      const { headers, body } = rowsToTable(value as Array<Record<string, unknown>>);
      blocks.push(buildCsvTable(humanizeKey(key), headers, body));
    }
  }

  if (provenance?.partialDataNotes?.length) {
    blocks.push(buildCsvTable("Notes", ["Note"], provenance.partialDataNotes.map((note) => [note])));
  }

  return `${blocks.filter(Boolean).join("\n\n")}\n`;
}
