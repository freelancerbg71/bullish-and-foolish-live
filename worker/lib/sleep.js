function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitter(baseMs, jitterPct = 0.2) {
  const base = Math.max(0, Number(baseMs) || 0);
  const pct = Math.max(0, Math.min(1, Number(jitterPct) || 0));
  const span = base * pct;
  const delta = (Math.random() * 2 - 1) * span;
  return Math.max(0, Math.round(base + delta));
}

export async function sleepWithJitter(baseMs, jitterPct = 0.2) {
  const ms = jitter(baseMs, jitterPct);
  if (ms <= 0) return;
  await sleep(ms);
}

