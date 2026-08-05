/**
 * `ModelProperties.createdDate` — the model's AUTHORED creation date, as an ISO
 * calendar date string (`YYYY-MM-DD`).
 *
 * Why authored and not derived: the Models Library used to stamp each card with
 * the `.gcaproj` file's mtime, which every build / checkout churns, so the date
 * said "when this working copy was written", never "when the model was made".
 * Filesystem birthtime is no better (a git checkout recreates files). So the
 * date is a plain optional metadata field the author sets, travelling inside the
 * `.gcaproj` like the rest of the presentation metadata.
 *
 * A model with NO date shows no stamp at all — deliberately preferring silence
 * over a misleading number.
 */

/** `YYYY-MM-DD` — the value shape of an `<input type="date">`. */
export const CREATED_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Parse an authored `YYYY-MM-DD` into a LOCAL-midnight Date, or null when the
 * value is absent / malformed / not a real calendar day (`2026-02-31`).
 *
 * NB the local-midnight construction is load-bearing: `new Date('2026-04-07')`
 * parses as UTC midnight, which renders as the PREVIOUS day anywhere west of
 * Greenwich — so a card would show a date one off from what the author typed.
 */
export function parseCreatedDate(value: unknown): Date | null {
  if (typeof value !== 'string' || !CREATED_DATE_RE.test(value)) return null;
  const y = Number(value.slice(0, 4));
  const m = Number(value.slice(5, 7));
  const d = Number(value.slice(8, 10));
  const dt = new Date(y, m - 1, d);
  // Round-trip check rejects overflow dates (month 13, Feb 31, …), which the
  // Date constructor would silently roll forward instead of failing.
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return dt;
}

/** Sortable timestamp for an authored date, or null when there isn't one. */
export function createdDateTimestamp(value: unknown): number | null {
  const dt = parseCreatedDate(value);
  return dt ? dt.getTime() : null;
}

/** Locale-formatted date, or `''` when the value isn't a usable date. */
export function formatCreatedDate(value: unknown, long: boolean): string {
  const dt = parseCreatedDate(value);
  if (!dt) return '';
  try {
    return long
      ? dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
      : dt.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
  } catch {
    return '';
  }
}

/** Today as `YYYY-MM-DD` in LOCAL time (never `toISOString`, which is UTC). */
export function todayCreatedDate(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
