export function normalize(value, min, max) {
  if (value === null || value === undefined) return null;
  const v = Number(value);
  if (!Number.isFinite(v)) return null;
  if (max === min) return 0;
  const clamped = Math.max(min, Math.min(max, v));
  return (clamped - min) / (max - min);
}
