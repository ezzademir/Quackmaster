import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, {
      status: 200,
      headers: corsHeaders,
    });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
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
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        {
          status: 401,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
      );
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
      !adminData ||
      adminData.length === 0 ||
      adminData[0].role !== "admin"
    ) {
      return new Response(
        JSON.stringify({ error: "Only admins can fetch user emails" }),
        {
          status: 403,
          headers: { ...corsHeaders, "Content-Type": "application/json" },
        }
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

    return new Response(
      JSON.stringify({ emails }),
      {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  } catch (error) {
    console.error("Error:", error);
    return new Response(
      JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error",
      }),
      {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      }
    );
  }
});
