/** Escape text for use in HTML content or a double-quoted attribute. */
export function esc(value: unknown): string {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Insert thousands separators into the integer part of a plain number string. */
function group(s: string): string {
  const [int = "", frac] = s.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return frac === undefined ? grouped : `${grouped}.${frac}`;
}

/**
 * Format a statistic for display: integers with thousands separators, otherwise 4 significant
 * digits, exponent notation only for very large or very small magnitudes. `null` renders as "n/a".
 */
export function fmt(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  if (v === 0) return "0";
  const abs = Math.abs(v);
  if (abs >= 1e9 || abs < 1e-3) return v.toExponential(2);
  if (Number.isInteger(v)) return group(String(v));
  const digits = abs >= 1000 ? 0 : abs >= 100 ? 1 : abs >= 10 ? 2 : abs >= 1 ? 3 : 4;
  return group(String(Number(v.toFixed(digits))));
}

/** Compact form for stat tiles and axis ticks: 12.9K, 4.2M. */
export function compact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "n/a";
  const abs = Math.abs(v);
  if (abs >= 1e6) return `${Number((v / 1e6).toPrecision(3))}M`;
  if (abs >= 1e4) return `${Number((v / 1e3).toPrecision(3))}K`;
  return fmt(v);
}

/** A "nice" set of axis ticks covering [min, max] with roughly `target` intervals. */
export function niceTicks(min: number, max: number, target = 5): { ticks: number[]; lo: number; hi: number } {
  if (!(max > min)) {
    const base = Number.isFinite(min) ? min : 0;
    return { ticks: [base, base + 1], lo: base, hi: base + 1 };
  }
  const raw = (max - min) / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const lo = Math.floor(min / step + 1e-9) * step;
  const hi = Math.ceil(max / step - 1e-9) * step;
  const ticks: number[] = [];
  for (let t = lo; t <= hi + step / 2; t += step) ticks.push(Number(t.toPrecision(12)));
  return { ticks, lo, hi };
}

/** Unit for a time axis spanning `maxSeconds`. */
export function timeUnit(maxSeconds: number): { label: string; divisor: number } {
  if (maxSeconds >= 7200) return { label: "hours", divisor: 3600 };
  if (maxSeconds >= 600) return { label: "minutes", divisor: 60 };
  return { label: "seconds", divisor: 1 };
}

/** Unit suffix shown after a value of the given unit category. */
export function unitSuffix(unit: string): string {
  return unit === "time" ? " s" : unit === "rate" ? " /s" : "";
}
