export async function runWithConcurrency(items, limit, worker) {
  const maxWorkers = Math.max(1, Number(limit) || 1);
  const results = new Array(items.length);
  let index = 0;

  async function runOne() {
    while (index < items.length) {
      const current = index;
      index += 1;
      results[current] = await worker(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(maxWorkers, items.length) }, () => runOne());
  await Promise.all(workers);
  return results;
}
