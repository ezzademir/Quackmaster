/** Pure handler for admin_set_user_active (no Deno / npm imports so it can be unit tested). */

export const BAN_FOREVER = "876000h"; // ~100 years
export const UNBAN = "none";

export interface ApplyResult {
  success: boolean;
  error?: string;
  message?: string;
  unchanged?: boolean;
  is_active?: boolean;
  sessions_revoked?: number;
}

export interface SetUserActiveDeps {
  /** Resolve the caller from their JWT; null when invalid. isActiveAdmin is checked before any ban change. */
  getCaller(jwt: string): Promise<{ id: string; isActiveAdmin: boolean } | null>;
  /** Service-role RPC public.admin_apply_user_active (does admin / self / last-admin checks atomically). */
  applyActive(actorId: string, targetId: string, active: boolean, reason: string | null): Promise<ApplyResult>;
  /** Auth admin API ban: returns an error message or null. */
  setBan(targetId: string, banDuration: string): Promise<string | null>;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function statusForRpcError(code: string | undefined): number {
  switch (code) {
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "last_admin":
      return 409;
    case "invalid_target":
    case "invalid_input":
      return 400;
    default:
      return 500;
  }
}

export async function handleSetUserActive(
  deps: SetUserActiveDeps,
  authHeader: string | null,
  rawBody: unknown,
): Promise<HandlerResult> {
  if (!authHeader?.startsWith("Bearer ")) {
    return { status: 401, body: { error: "Missing or invalid Authorization header" } };
  }
  const caller = await deps.getCaller(authHeader.replace(/^Bearer\s+/i, ""));
  if (!caller) return { status: 401, body: { error: "Invalid session" } };

  const body = (rawBody ?? {}) as { userId?: unknown; active?: unknown; reason?: unknown };
  const userId = typeof body.userId === "string" ? body.userId.trim() : "";
  if (!UUID_RE.test(userId)) return { status: 400, body: { error: "userId (uuid) is required" } };
  if (typeof body.active !== "boolean") return { status: 400, body: { error: "active (boolean) is required" } };
  const active = body.active;
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim().slice(0, 500) : null;

  if (userId === caller.id) {
    return { status: 400, body: { error: "invalid_target", message: "You cannot deactivate or reactivate yourself" } };
  }

  // Authorization before any service-role ban change. Reactivate used to unban first and
  // only then call admin_apply_user_active, so any signed-in user could lift a ban.
  if (!caller.isActiveAdmin) {
    return { status: 403, body: { error: "forbidden", message: "Only admins can change account status" } };
  }

  if (!active) {
    // DB first: profile inactive + sessions revoked + ledger (atomic). Then auth ban.
    const r = await deps.applyActive(caller.id, userId, false, reason);
    if (!r.success) {
      return { status: statusForRpcError(r.error), body: { error: r.error ?? "failed", message: r.message } };
    }
    const banErr = await deps.setBan(userId, BAN_FOREVER);
    if (banErr) {
      // Keep DB and Auth consistent: undo the profile change.
      if (!r.unchanged) await deps.applyActive(caller.id, userId, true, "rollback: auth ban failed");
      return { status: 502, body: { error: "auth_ban_failed", message: banErr } };
    }
    return { status: 200, body: { success: true, is_active: false, sessions_revoked: r.sessions_revoked ?? 0 } };
  }

  // Reactivate: lift the auth ban first, then mark active. Re-ban if the profile write does not stick.
  const unbanErr = await deps.setBan(userId, UNBAN);
  if (unbanErr) return { status: 502, body: { error: "auth_unban_failed", message: unbanErr } };
  let r: ApplyResult;
  try {
    r = await deps.applyActive(caller.id, userId, true, reason);
  } catch (e) {
    const rebanErr = await deps.setBan(userId, BAN_FOREVER);
    if (rebanErr) return { status: 502, body: { error: "auth_reban_failed", message: rebanErr } };
    throw e;
  }
  if (!r.success) {
    const rebanErr = await deps.setBan(userId, BAN_FOREVER);
    if (rebanErr) return { status: 502, body: { error: "auth_reban_failed", message: rebanErr } };
    return { status: statusForRpcError(r.error), body: { error: r.error ?? "failed", message: r.message } };
  }
  return { status: 200, body: { success: true, is_active: true } };
}
