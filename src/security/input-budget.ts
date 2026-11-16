/** Bounded JSON topology before patched Zod 4 validation. No parsing or execution here. */
export function assertInputBudget(value: unknown) {
  const pending: [unknown, number][] = [[value, 0]]; let nodes = 0;
  while (pending.length) {
    const [v, depth] = pending.pop()!;
    if (++nodes > 150000 || depth > 60) throw new Error('Input exceeds the structural budget (150000 nodes / depth 60)');
    if (!v || typeof v !== 'object') continue;
    if (Array.isArray(v) && v.length > 65536) throw new Error('Input array exceeds 65536 elements');
    for (const child of Object.values(v)) pending.push([child, depth + 1]);
  }
}
