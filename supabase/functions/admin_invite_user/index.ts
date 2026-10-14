import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";
import { handleInviteUser } from "./core.ts";

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

function json(body: unknown, req: Request, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json" },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, req, 405);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !anonKey || !serviceKey) return json({ error: "Missing Supabase configuration" }, req, 500);

  try {
    const authHeader = req.headers.get("Authorization");
    const admin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
    const userClient = createClient(supabaseUrl, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { headers: { Authorization: authHeader ?? "" } },
    });
    let body: unknown = {};
    try {
      body = await req.json();
    } catch {
      body = {};
    }

    const result = await handleInviteUser(
      {
        async getCaller(jwt) {
          const { data, error } = await userClient.auth.getUser(jwt);
          return error || !data.user ? null : { id: data.user.id, email: data.user.email };
        },
        async getProfile(userId) {
          const { data, error } = await admin.from("profiles").select("role, is_active").eq("id", userId)
            .maybeSingle();
          if (error) throw new Error(error.message);
          return data;
        },
        async invite(email, fullName, redirectTo) {
          const { data, error } = await admin.auth.admin.inviteUserByEmail(email, {
            data: { full_name: fullName },
            redirectTo,
          });
          return {
            userId: data?.user?.id ?? null,
            error: error ? { message: error.message, status: error.status } : null,
          };
        },
        async writeLedger(row) {
          const { error } = await admin.from("data_ledger").insert(row);
          if (error) console.error("[data_ledger]", error.message);
          return error ? error.message : null;
        },
      },
      authHeader,
      body,
    );
    return json(result.body, req, result.status);
  } catch (e) {
    return json({ error: `Server error: ${e instanceof Error ? e.message : String(e)}` }, req, 500);
  }
});
