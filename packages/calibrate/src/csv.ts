/** Thrown when a data file cannot be read as a column of numbers or times. */
export class DataParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DataParseError";
  }
}

export interface ColumnOptions {
  /** A column name (matched against the header row, ignoring case) or a 0-based index. Default: the first numeric column. */
  column?: string | number;
  /**
   * "number" reads plain numbers. "time" also accepts dates such as 2024-05-01T12:00:03Z (as exported by monitoring
   * tools) and converts them to seconds. Default "number".
   */
  kind?: "number" | "time";
}

export interface ParsedColumn {
  values: number[];
  /** The column that was read (its header name, or "column N"). */
  column: string;
  hasHeader: boolean;
  /** Data rows seen. */
  rows: number;
  /** Rows whose cell could not be read. */
  skipped: number;
}

function cellValue(cell: string, kind: "number" | "time"): number | null {
  const c = cell.trim().replace(/^"|"$/g, "");
  if (c === "") return null;
  const n = Number(c);
  if (Number.isFinite(n)) return n;
  if (kind === "time" && /\d{4}-\d{2}-\d{2}/.test(c)) {
    const ms = Date.parse(c);
    if (Number.isFinite(ms)) return ms / 1000;
  }
  return null;
}

/**
 * Read one column of numbers (or times) from CSV, TSV or whitespace-separated text. Blank lines and lines starting
 * with # are ignored, a header row is detected automatically, and cells that cannot be read are skipped and counted.
 */
export function parseColumn(text: string, options: ColumnOptions = {}): ParsedColumn {
  const kind = options.kind ?? "number";
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l !== "" && !l.startsWith("#"));
  if (lines.length === 0) throw new DataParseError("the file has no data");
  const first = lines[0] as string;
  const delimiter = [",", "\t", ";"].map((d) => ({ d, n: first.split(d).length - 1 })).sort((a, b) => b.n - a.n)[0] as { d: string; n: number };
  const split = (line: string): string[] => (delimiter.n > 0 ? line.split(delimiter.d) : line.split(/\s+/));
  const header = split(first);
  const second = lines.length > 1 ? split(lines[1] as string) : [];

  let index: number;
  let hasHeader: boolean;
  if (typeof options.column === "string") {
    index = header.findIndex((h) => h.trim().replace(/^"|"$/g, "").toLowerCase() === (options.column as string).toLowerCase());
    if (index === -1) {
      throw new DataParseError(`no column named "${options.column}" (the header has: ${header.map((h) => h.trim()).join(", ")})`);
    }
    hasHeader = true;
  } else if (typeof options.column === "number") {
    index = options.column;
    hasHeader = cellValue(header[index] ?? "", kind) === null && cellValue(second[index] ?? "", kind) !== null;
  } else {
    // First column that holds a readable value in the first row, or in the second row when the first is a header.
    const firstReadable = header.findIndex((c) => cellValue(c, kind) !== null);
    if (firstReadable !== -1) {
      index = firstReadable;
      hasHeader = false;
    } else {
      index = second.findIndex((c) => cellValue(c, kind) !== null);
      hasHeader = index !== -1;
      if (index === -1) throw new DataParseError("no column of numbers was found");
    }
  }

  const body = hasHeader ? lines.slice(1) : lines;
  const values: number[] = [];
  let skipped = 0;
  for (const line of body) {
    const v = cellValue(split(line)[index] ?? "", kind);
    if (v === null) skipped++;
    else values.push(v);
  }
  if (values.length === 0) throw new DataParseError(`column ${typeof options.column === "string" ? `"${options.column}"` : index} has no readable ${kind === "time" ? "times" : "numbers"}`);
  const name = hasHeader ? (header[index] ?? "").trim().replace(/^"|"$/g, "") : `column ${index}`;
  return { values, column: name, hasHeader, rows: body.length, skipped };
}
