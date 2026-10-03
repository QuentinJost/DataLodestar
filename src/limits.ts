/**
 * Bounds of the size settings, also applied on read: VS Code does not enforce a schema `maximum` on a
 * value it returns, and a trusted workspace can set any number (a huge maxRows keeps every row of a
 * result in the extension host's memory).
 */
const LIMITS = {
  maxRows: { fallback: 1000, min: 1, max: 100_000 },
  maxCellChars: { fallback: 500, min: 20, max: 100_000 },
} as const;

/** The setting `key` from `settings`, rounded down and kept within its bounds; the default if not a number. */
export function boundedSetting(settings: { get<T>(key: string, fallback: T): T }, key: keyof typeof LIMITS): number {
  const { fallback, min, max } = LIMITS[key];
  const value = Number(settings.get<unknown>(key, fallback));
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(value)));
}
