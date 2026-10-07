/** Fetch all rows via repeated .range() pages (PostgREST caps responses, default 1000). */
export const PAGE_SIZE = 1000;

export async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = PAGE_SIZE,
  maxPages = 10_000,
): Promise<T[]> {
  if (!(pageSize > 0)) throw new Error("pageSize must be > 0");
  const out: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const from = page * pageSize;
    const { data, error } = await fetchPage(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const rows = data ?? [];
    out.push(...rows);
    if (rows.length < pageSize) return out;
  }
  throw new Error("fetchAllPages: maxPages exceeded");
}
