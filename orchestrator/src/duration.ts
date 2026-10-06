export const DURATION_RE = /^\d+(ms|s|m|h|d)$/;

const UNITS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Parse a duration like `30s`, `10m`, `1h`, `30d` into milliseconds. */
export function parseDurationMs(value: string): number {
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (match === null) throw new Error(`invalid duration "${value}"`);
  const amount = Number(match[1]);
  const unit = match[2] as string;
  return amount * (UNITS[unit] as number);
}
