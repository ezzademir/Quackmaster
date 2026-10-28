import { describe, expect, it } from 'vitest';
import { fetchAllPages } from '../../supabase/functions/sync_storehub_sales/pager';

function source(n: number) {
  const rows = Array.from({ length: n }, (_, i) => i);
  const calls: Array<[number, number]> = [];
  const fetch = async (a: number, b: number) => { calls.push([a, b]); return { data: rows.slice(a, b + 1), error: null }; };
  return { fetch, calls };
}

describe('fetchAllPages', () => {
  it.each([0, 1, 999, 1000, 1001, 2500])('returns all %i rows', async (n) => {
    const s = source(n);
    const out = await fetchAllPages(s.fetch, 1000);
    expect(out).toHaveLength(n);
    expect(out[n - 1]).toBe(n - 1 >= 0 ? n - 1 : undefined);
    expect(s.calls[0]).toEqual([0, 999]);
    expect(s.calls).toHaveLength(Math.floor(n / 1000) + 1);
  });
  it('throws on error', async () => {
    await expect(fetchAllPages(async () => ({ data: null, error: { message: 'boom' } }))).rejects.toThrow('boom');
  });
  it('null data = end', async () => {
    expect(await fetchAllPages(async () => ({ data: null, error: null }))).toEqual([]);
  });
});
