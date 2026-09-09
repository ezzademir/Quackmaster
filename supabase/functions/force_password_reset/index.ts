import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req),
    });
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

    const { data: profile, error: profileErr } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", caller.id)
      .maybeSingle();

    if (profileErr) {
      return jsonResponse({ error: `Profile check failed: ${profileErr.message}` }, req, 500);
    }

    if (profile?.role !== "admin") {
      return jsonResponse({ error: "Forbidden: admin only" }, req, 403);
    }

    const body = await req.json() as { userId?: string };
    const userId = typeof body.userId === "string" ? body.userId.trim() : "";

    if (!userId) {
      return jsonResponse({ error: "userId is required" }, req, 400);
    }

    const { error: updateErr } = await adminClient
      .from("profiles")
      .update({ password_reset_required: true })
      .eq("id", userId);

    if (updateErr) {
      return jsonResponse({ error: `Failed to update profile: ${updateErr.message}` }, req, 400);
    }

    return jsonResponse({
      success: true,
      message: "Password reset required flag set",
    }, req);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonResponse({ error: `Server error: ${message}` }, req, 500);
  }
});
