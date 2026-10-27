import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const MIN_PASSWORD_LENGTH = 6;

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const allowHeaders = req.headers.get("Access-Control-Request-Headers") ??
    "authorization, content-type, x-client-info, apikey";
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": allowHeaders,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function jsonResponse(body: unknown, req: Request, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders(req),
      "Content-Type": "application/json",
    },
  });
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }

  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, req, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader?.startsWith("Bearer ")) {
      return jsonResponse({ error: "Missing or invalid Authorization header" }, req, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !anonKey || !serviceKey) {
      return jsonResponse({ error: "Missing Supabase configuration" }, req, 500);
    }

    const jwt = authHeader.replace(/^Bearer\s+/i, "");
    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authHeader } },
    });

    const {
      data: { user: caller },
      error: callerErr,
    } = await userClient.auth.getUser(jwt);

    if (callerErr || !caller) {
      return jsonResponse({ error: "Invalid session" }, req, 401);
    }

    const adminClient = createClient(supabaseUrl, serviceKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: callerProfile, error: profileErr } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .maybeSingle();

    if (profileErr) {
      return jsonResponse({ error: `Profile check failed: ${profileErr.message}` }, req, 500);
    }

    if (callerProfile?.role !== "admin") {
      return jsonResponse({ error: "Forbidden: admin only" }, req, 403);
    }

    const body = await req.json() as {
      email?: string;
      fullName?: string;
      password?: string;
      role?: string;
      assignedOutletId?: string | null;
      pages?: unknown;
      features?: unknown;
    };

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const fullName = typeof body.fullName === "string" ? body.fullName.trim() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const role = typeof body.role === "string" ? body.role.trim().toLowerCase() : "";
    const assignedOutletId = typeof body.assignedOutletId === "string" ? body.assignedOutletId.trim() : "";
    const pages = stringList(body.pages);
    const features = stringList(body.features);

    if (!email || !email.includes("@")) {
      return jsonResponse({ error: "A valid email is required" }, req, 400);
    }
    if (!fullName) {
      return jsonResponse({ error: "Display name is required" }, req, 400);
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      return jsonResponse({
        error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters`,
      }, req, 400);
    }
    if (role !== "staff" && role !== "supervisor") {
      return jsonResponse({ error: "Role must be staff or supervisor" }, req, 400);
    }
    if (role === "supervisor" && !assignedOutletId) {
      return jsonResponse({ error: "Supervisors require an assigned outlet" }, req, 400);
    }

    if (role === "supervisor") {
      const { data: outlet, error: outletErr } = await adminClient
        .from("outlets")
        .select("id")
        .eq("id", assignedOutletId)
        .maybeSingle();
      if (outletErr) {
        return jsonResponse({ error: outletErr.message }, req, 400);
      }
      if (!outlet) {
        return jsonResponse({ error: "Outlet not found" }, req, 400);
      }
    }

    const { data: created, error: createErr } = await adminClient.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: fullName },
    });

    if (createErr || !created.user) {
      return jsonResponse({ error: createErr?.message ?? "Could not create user" }, req, 400);
    }

    const userId = created.user.id;

    const { data: updated, error: updateErr } = await adminClient
      .from("profiles")
      .update({
        full_name: fullName,
        role,
        assigned_outlet_id: role === "supervisor" ? assignedOutletId : null,
        password_reset_required: true,
      })
      .eq("id", userId)
      .select("id");

    if (updateErr || !updated?.length) {
      await adminClient.auth.admin.deleteUser(userId);
      return jsonResponse({
        error: updateErr?.message ?? "Profile was not created for the new user",
      }, req, 500);
    }

    const { data: accessData, error: accessErr } = await adminClient.rpc("admin_set_profile_access", {
      p_target_user_id: userId,
      p_pages: pages,
      p_features: features,
    });

    const accessPayload = accessData as { success?: boolean; message?: string; error?: string } | null;
    if (accessErr || !accessPayload?.success) {
      await adminClient.auth.admin.deleteUser(userId);
      return jsonResponse({
        error: accessErr?.message ?? accessPayload?.message ?? accessPayload?.error ?? "Could not save page access",
      }, req, 400);
    }

    return jsonResponse({ success: true, userId, email }, req);
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return jsonResponse({ error: `Server error: ${message}` }, req, 500);
  }
});
