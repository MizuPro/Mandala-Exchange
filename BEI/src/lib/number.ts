export function toNumber(value: string | number | null | undefined, fallback = 0) {
  if (value === null || value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function money(value: number) {
  return value.toFixed(2);
}

export function decimal(value: number, scale = 4) {
  return value.toFixed(scale);
}
