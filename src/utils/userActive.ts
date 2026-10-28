/** Deactivated users: hidden from lists by default, history untouched. */
export interface ActiveFlag {
  is_active?: boolean | null;
}

/** Missing flag (pre-migration rows / older RPC payloads) counts as active. */
export function isUserActive(u: ActiveFlag | null | undefined): boolean {
  return u?.is_active !== false;
}

export function filterByActive<T extends ActiveFlag>(rows: T[], showDeactivated: boolean): T[] {
  return showDeactivated ? rows : rows.filter(isUserActive);
}

export function countDeactivated(rows: ActiveFlag[]): number {
  return rows.reduce((n, r) => n + (isUserActive(r) ? 0 : 1), 0);
}
