import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

/** Reflect Origin / requested headers so browser CORS checks pass from gh-pages etc. */
function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin");
  const allowHeaders = req.headers.get("Access-Control-Request-Headers") ??
    "authorization, content-type, x-client-info, apikey";
  return {
    "Access-Control-Allow-Origin": origin ?? "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
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

/** auth.users is NOT exposed via PostgREST; use Auth Admin API with service role. */
async function listAllUserEmails(
  serviceUrl: string,
  serviceKey: string,
): Promise<Record<string, string>> {
  const admin = createClient(serviceUrl, serviceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const emails: Record<string, string> = {};
  let page = 1;
  const perPage = 1000;

  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage });
    if (error) throw error;
    const batch = data.users ?? [];
    if (batch.length === 0) break;
    for (const u of batch) {
      emails[u.id] = u.email ?? "";
    }
    if (batch.length < perPage) break;
    page += 1;
  }

  return emails;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: corsHeaders(req),
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ error: "Missing authorization header" }, req, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) {
      return jsonResponse({ error: "Missing Supabase configuration" }, req, 500);
    }

    const jwtResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: authHeader,
        apikey: supabaseKey,
      },
    });

    if (!jwtResponse.ok) {
      return jsonResponse({ error: "Unauthorized" }, req, 401);
    }

    const jwtUser = (await jwtResponse.json()) as { id?: string };
    const adminClient = createClient(supabaseUrl, supabaseKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    const { data: profile, error: profileErr } = await adminClient
      .from("profiles")
      .select("role")
      .eq("id", jwtUser.id ?? "")
      .maybeSingle();

    if (profileErr) {
      console.error("profile lookup:", profileErr);
      return jsonResponse({ error: "Failed to verify admin" }, req, 500);
    }

    if (profile?.role !== "admin") {
      return jsonResponse(
        { error: "Only admins can fetch user emails" },
        req,
        403,
      );
    }

    const emails = await listAllUserEmails(supabaseUrl, supabaseKey);
    return jsonResponse({ emails }, req);
  } catch (error) {
    console.error("Error:", error);
    return jsonResponse(
      {
        error: error instanceof Error ? error.message : "Unknown error",
      },
      req,
      500,
    );
  }
});
