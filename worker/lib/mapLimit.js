export async function mapLimit(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const concurrency = Math.max(1, Math.trunc(Number(limit) || 1));
  const results = new Array(list.length);
  let idx = 0;
  let active = 0;

  return new Promise((resolve) => {
    const launch = () => {
      while (active < concurrency && idx < list.length) {
        const current = idx++;
        active++;
        Promise.resolve(worker(list[current], current))
          .then((value) => results[current] = value)
          .catch((err) => results[current] = { ok: false, error: err?.message || String(err) })
          .finally(() => {
            active--;
            if (idx >= list.length && active === 0) return resolve(results);
            launch();
          });
      }
    };
    launch();
  });
}

