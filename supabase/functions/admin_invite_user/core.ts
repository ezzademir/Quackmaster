/** Pure handler for admin_invite_user (no Deno / npm imports so it can be unit tested). */
import { type CallerProfile, isActiveAdmin } from "../_shared/activeAdmin.ts";

export const INVITE_REDIRECT_TO = "https://ezzademir.github.io/Quackmaster/";
export const MAX_NAME_LENGTH = 120;

// Pragmatic check: one @, no spaces, a dot in the domain. Auth does the final validation.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface InviteDeps {
  /** Resolve the caller from their JWT; null when invalid. */
  getCaller(jwt: string): Promise<{ id: string; email?: string | null } | null>;
  /** Service-role lookup of the caller's profile; throws on DB error. */
  getProfile(userId: string): Promise<CallerProfile | null>;
  /** Service-role auth.admin.inviteUserByEmail. */
  invite(
    email: string,
    fullName: string,
    redirectTo: string,
  ): Promise<{ userId: string | null; error: { message: string; status?: number } | null }>;
  /** Append a data_ledger row; returns an error message or null. Failure does not fail the invite. */
  writeLedger(row: Record<string, unknown>): Promise<string | null>;
}

export interface HandlerResult {
  status: number;
  body: Record<string, unknown>;
}

export function normaliseEmail(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

export async function handleInviteUser(
  deps: InviteDeps,
  authHeader: string | null,
  rawBody: unknown,
): Promise<HandlerResult> {
  if (!authHeader?.startsWith("Bearer ")) {
    return { status: 401, body: { error: "Missing or invalid Authorization header" } };
  }
  const caller = await deps.getCaller(authHeader.replace(/^Bearer\s+/i, ""));
  if (!caller) return { status: 401, body: { error: "Invalid session" } };

  let profile: CallerProfile | null;
  try {
    profile = await deps.getProfile(caller.id);
  } catch (e) {
    return { status: 500, body: { error: `Profile check failed: ${e instanceof Error ? e.message : String(e)}` } };
  }
  if (!isActiveAdmin(profile)) {
    return { status: 403, body: { error: "Forbidden: active admin only" } };
  }

  const body = (rawBody ?? {}) as { email?: unknown; fullName?: unknown };
  const email = normaliseEmail(body.email);
  if (!email) return { status: 400, body: { error: "A valid email is required" } };
  const fullName = typeof body.fullName === "string" ? body.fullName.trim().slice(0, MAX_NAME_LENGTH) : "";
  if (!fullName) return { status: 400, body: { error: "fullName is required" } };

  const { userId, error } = await deps.invite(email, fullName, INVITE_REDIRECT_TO);
  if (error) {
    const already = error.status === 422 || /already (been )?registered|already exists/i.test(error.message);
    return already
      ? { status: 409, body: { error: "already_registered", message: "A user with this email already exists" } }
      : { status: 502, body: { error: "invite_failed", message: error.message } };
  }

  // New account lands as role 'pending' via the on_auth_user_created trigger; an admin still approves it.
  const ledgerErr = await deps.writeLedger({
    user_id: caller.id,
    user_email: caller.email ?? "",
    action: "invited",
    entity_type: "profile",
    entity_id: userId ?? email,
    module: "users",
    operation: "event",
    after_data: { email, full_name: fullName, role: "pending" },
    metadata: { source: "admin_invite_user", redirect_to: INVITE_REDIRECT_TO },
  });

  return {
    status: 200,
    body: { success: true, userId, email, ledger_written: ledgerErr === null },
  };
}
