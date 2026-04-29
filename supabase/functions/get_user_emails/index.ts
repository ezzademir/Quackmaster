import "jsr:@supabase/functions-js/edge-runtime.d.ts";

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

    // Verify JWT and get user
    const jwtResponse = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: {
        Authorization: authHeader,
        apikey: supabaseKey!,
      },
    });

    if (!jwtResponse.ok) {
      return jsonResponse({ error: "Unauthorized" }, req, 401);
    }

    // Check if user is admin
    const supabaseAdminUrl = `${supabaseUrl}/rest/v1/profiles?id=eq.${
      (await jwtResponse.json()).id
    }&select=role`;

    const adminCheckResponse = await fetch(supabaseAdminUrl, {
      headers: {
        apikey: supabaseKey!,
        Authorization: authHeader,
      },
    });

    const adminData = await adminCheckResponse.json();
    if (
      !Array.isArray(adminData) ||
      adminData.length === 0 ||
      adminData[0].role !== "admin"
    ) {
      return jsonResponse(
        { error: "Only admins can fetch user emails" },
        req,
        403,
      );
    }

    // Get all user emails from auth.users
    const usersResponse = await fetch(
      `${supabaseUrl}/rest/v1/auth.users?select=id,email`,
      {
        headers: {
          apikey: supabaseKey!,
          Authorization: `Bearer ${supabaseKey}`,
        },
      }
    );

    if (!usersResponse.ok) {
      throw new Error("Failed to fetch users from auth.users");
    }

    const users = await usersResponse.json();
    const emails: { [key: string]: string } = {};

    users.forEach(
      (user: { id: string; email: string }) => {
        emails[user.id] = user.email;
      }
    );

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
