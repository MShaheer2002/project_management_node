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

export function toCsv(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) {
    return "section\nempty\n";
  }

  const headers = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const escape = (value: unknown) => {
    const raw = value == null ? "" : typeof value === "string" ? value : JSON.stringify(value);
    const safe = raw.replace(/"/g, '""');
    return /[",\n]/.test(safe) ? `"${safe}"` : safe;
  };

  return [
    headers.join(","),
    ...rows.map((row) => headers.map((header) => escape(row[header])).join(",")),
  ].join("\n");
}

function humanizeKey(value: string) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_.-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatPrimitive(value: unknown): string {
  if (value == null) return "-";
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

function drawSectionHeading(doc: any, title: string) {
  if (doc.y > 700) doc.addPage();
  doc.moveDown(0.8);
  doc.font("Helvetica-Bold").fontSize(15).fillColor("#0f172a").text(title);
  doc.moveDown(0.2);
  doc.strokeColor("#cbd5e1").moveTo(50, doc.y).lineTo(545, doc.y).stroke();
  doc.moveDown(0.5);
}

function drawKeyValueBlock(doc: any, title: string, data: Record<string, unknown>) {
  drawSectionHeading(doc, title);
  for (const [key, value] of Object.entries(data)) {
    if (doc.y > 730) doc.addPage();
    doc.font("Helvetica-Bold").fontSize(10).fillColor("#334155").text(`${humanizeKey(key)}:`, { continued: true });
    doc.font("Helvetica").fillColor("#111827").text(` ${formatPrimitive(value)}`);
  }
}

function drawSimpleTable(doc: any, title: string, rows: Array<Record<string, unknown>>) {
  drawSectionHeading(doc, title);

  if (rows.length === 0) {
    doc.font("Helvetica").fontSize(10).fillColor("#64748b").text("No data available.");
    return;
  }

  const headers = Object.keys(rows[0] ?? {}).slice(0, 6);
  doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a").text(headers.map((header) => humanizeKey(header)).join(" | "));
  doc.moveDown(0.2);

  for (const row of rows.slice(0, 40)) {
    if (doc.y > 730) {
      doc.addPage();
      doc.font("Helvetica-Bold").fontSize(9).fillColor("#0f172a").text(headers.map((header) => humanizeKey(header)).join(" | "));
      doc.moveDown(0.2);
    }

    const values = headers.map((header) => {
      const value = row[header];
      if (value && typeof value === "object" && !Array.isArray(value)) {
        return JSON.stringify(value);
      }
      return formatPrimitive(value);
    });

    doc.font("Helvetica").fontSize(9).fillColor("#111827").text(values.join(" | "));
  }
}

function drawArraySection(doc: any, title: string, items: unknown[]) {
  if (items.length > 0 && typeof items[0] === "object" && items[0] !== null && !Array.isArray(items[0])) {
    drawSimpleTable(doc, title, items as Array<Record<string, unknown>>);
    return;
  }

  drawSectionHeading(doc, title);
  for (const item of items) {
    if (doc.y > 730) doc.addPage();
    doc.font("Helvetica").fontSize(10).fillColor("#111827").text(`- ${formatPrimitive(item)}`);
  }
}

function renderObjectSection(doc: any, title: string, data: Record<string, unknown>) {
  const primitiveEntries = Object.entries(data).filter(([, value]) => value == null || typeof value !== "object");
  const objectEntries = Object.entries(data).filter(([, value]) => value && typeof value === "object");

  if (primitiveEntries.length > 0) {
    drawKeyValueBlock(doc, title, Object.fromEntries(primitiveEntries));
  }

  for (const [key, value] of objectEntries) {
    const nextTitle = `${title} - ${humanizeKey(key)}`;

    if (Array.isArray(value)) {
      drawArraySection(doc, nextTitle, value);
      continue;
    }

    renderObjectSection(doc, nextTitle, value as Record<string, unknown>);
  }
}

export async function buildAnalyticsPdf(options: {
  title: string;
  scope: string;
  period: string;
  payload: Record<string, unknown>;
}) {
  const { title, scope, period, payload } = options;
  const doc = new PDFDocument({
    size: "A4",
    margin: 50,
    info: {
      Title: title,
      Author: "Trussen Backend",
      Subject: `${scope} analytics export`,
    },
  });

  const chunks: Buffer[] = [];
  await new Promise<void>((resolve, reject) => {
    doc.on("data", (chunk: Buffer) => chunks.push(chunk));
    doc.on("end", () => resolve());
    doc.on("error", reject);

    doc.rect(0, 0, 595, 110).fill("#0f172a");
    doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(24).text(title, 50, 38);
    doc.font("Helvetica").fontSize(10).fillColor("#cbd5e1").text(`Scope: ${humanizeKey(scope)}`, 50, 74);
    doc.text(`Period: ${period}`, 180, 74);
    doc.text(`Generated: ${new Date().toISOString()}`, 320, 74);

    doc.moveDown(6);

    for (const [key, value] of Object.entries(payload)) {
      const sectionTitle = humanizeKey(key);

      if (Array.isArray(value)) {
        drawArraySection(doc, sectionTitle, value);
        continue;
      }

      if (value && typeof value === "object") {
        renderObjectSection(doc, sectionTitle, value as Record<string, unknown>);
        continue;
      }

      drawKeyValueBlock(doc, sectionTitle, { value });
    }

    doc.end();
  });

  return Buffer.concat(chunks);
}
