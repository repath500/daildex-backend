import { AppError } from "@daildex/shared";
import { z } from "zod";

export const API_LICENCE = {
  name: "Oireachtas (Open Data) PSI Licence",
  url: "https://www.oireachtas.ie/en/open-data/",
  attribution: "Contains Parliamentary information licensed under the Oireachtas (Open Data) PSI Licence.",
} as const;

export type ValidationField = { field: string; issue: string };

/** A 400 that carries structured per-field issues for the /v1 error envelope. */
export class PublicApiValidationError extends AppError {
  readonly fields: ValidationField[];

  constructor(message: string, fields: ValidationField[]) {
    super("INVALID_REQUEST", message, 400);
    this.name = "PublicApiValidationError";
    this.fields = fields;
  }
}

export type PublicMeta = {
  count: number;
  limit: number;
  next_cursor: string | null;
  has_more: boolean;
  licence: typeof API_LICENCE;
  fetched_at: string;
};

export function buildMeta(count: number, limit: number, nextCursor: string | null): PublicMeta {
  return {
    count,
    limit,
    next_cursor: nextCursor,
    has_more: nextCursor !== null,
    licence: API_LICENCE,
    fetched_at: new Date().toISOString(),
  };
}

/** Parse query parameters, rejecting unknown keys and reporting each problem as a field. */
export function parseStrict<Shape extends z.ZodRawShape>(
  shape: Shape,
  query: Record<string, string | undefined>,
  refine?: (value: z.infer<z.ZodObject<Shape>>) => ValidationField[],
): z.infer<z.ZodObject<Shape>> {
  const fields: ValidationField[] = [];
  const allowed = new Set(Object.keys(shape));
  for (const key of Object.keys(query)) {
    if (!allowed.has(key)) {
      fields.push({ field: key, issue: `Unknown parameter. Allowed: ${[...allowed].sort().join(", ") || "none"}.` });
    }
  }
  const known = Object.fromEntries(Object.entries(query).filter(([key]) => allowed.has(key)));
  const result = z.object(shape).safeParse(known);
  if (!result.success) {
    for (const issue of result.error.issues) {
      fields.push({ field: issue.path.join(".") || "query", issue: issue.message });
    }
  } else if (refine && fields.length === 0) {
    fields.push(...refine(result.data));
  }
  if (fields.length > 0) {
    throw new PublicApiValidationError(
      `Invalid request: ${fields.map((entry) => `${entry.field} — ${entry.issue}`).join("; ")}`,
      fields,
    );
  }
  return (result as { data: z.infer<z.ZodObject<Shape>> }).data;
}

export const paging = {
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).max(10_000).default(0),
  cursor: z.string().trim().min(1).max(300).optional(),
};

export const dateRange = {
  date_start: z.iso.date().optional(),
  date_end: z.iso.date().optional(),
};

export function checkDateRange(value: { date_start?: string; date_end?: string }): ValidationField[] {
  return value.date_start && value.date_end && value.date_start > value.date_end
    ? [{ field: "date_start", issue: "date_start must be on or before date_end" }]
    : [];
}

export function checkPaging(value: { offset: number; cursor?: string }): ValidationField[] {
  return value.cursor && value.offset > 0
    ? [{ field: "offset", issue: "Use either cursor or offset, not both." }]
    : [];
}

export type Cursor = { k: string; i: string };

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeCursor(value: string | undefined): Cursor | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as unknown;
    if (
      parsed && typeof parsed === "object"
      && typeof (parsed as Cursor).k === "string" && typeof (parsed as Cursor).i === "string"
      && (parsed as Cursor).k.length <= 80 && (parsed as Cursor).i.length <= 120
    ) {
      return parsed as Cursor;
    }
  } catch {
    // fall through
  }
  throw new PublicApiValidationError("Invalid request: cursor — Not a cursor issued by this API.", [
    { field: "cursor", issue: "Not a cursor issued by this API." },
  ]);
}

/** Escape `%`, `_` and `\` so user input is matched literally by LIKE. */
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

export function likePattern(value: string | undefined): string {
  return `%${escapeLike((value ?? "").toLocaleLowerCase("en-IE"))}%`;
}

export function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Oireachtas answers arrive as light HTML; return plain text with paragraph breaks kept. */
export function htmlToText(value: string | null | undefined): string | null {
  if (!value) return null;
  const text = value
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;|&apos;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text || null;
}
