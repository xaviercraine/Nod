// ============================================
// NOD — health-check/index.ts
// Daily system validation endpoint.
// Auth: CRON_SECRET header (not API key HMAC).
// Deployed with --no-verify-jwt.
//
// Checks:
//   1. Database connectivity (SELECT 1 via get_active_tenants)
//   2. RESEND_API_KEY configured
//   3. STRIPE_WEBHOOK_SECRET configured
//
// Returns structured JSON health status.
// ============================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";

serve(async (req: Request) => {
  try {
    // ---- Auth: verify CRON_SECRET ----
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (!cronSecret) {
      console.error("CRON_SECRET is not configured");
      return new Response(
        JSON.stringify({ error: "Server misconfiguration", code: "MISSING_CRON_SECRET" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const providedSecret = req.headers.get("x-cron-secret");
    if (providedSecret !== cronSecret) {
      return new Response(
        JSON.stringify({ error: "Unauthorized", code: "INVALID_CRON_SECRET" }),
        { status: 401, headers: { "Content-Type": "application/json" } },
      );
    }

    // ---- Check 1: Database connectivity ----
    const supabase = getSupabaseClient();
    let dbStatus = "ok";
    let dbError: string | null = null;
    let tenantCount = 0;

    const { data: tenants, error: dbErr } = await supabase.rpc("get_active_tenants");

    if (dbErr) {
      dbStatus = "error";
      dbError = dbErr.message;
    } else {
      tenantCount = tenants?.length ?? 0;
    }

    // ---- Check 2: Resend API key configured ----
    const resendKey = Deno.env.get("RESEND_API_KEY");
    const resendStatus = resendKey ? "ok" : "missing";

    // ---- Check 3: Stripe webhook secret configured ----
    const stripeSecret = Deno.env.get("STRIPE_WEBHOOK_SECRET");
    const stripeStatus = stripeSecret ? "ok" : "missing";

    // ---- Overall status ----
    const allOk = dbStatus === "ok" && resendStatus === "ok" && stripeStatus === "ok";

    const result = {
      status: allOk ? "healthy" : "degraded",
      timestamp: new Date().toISOString(),
      checks: {
        database: {
          status: dbStatus,
          active_tenants: tenantCount,
          ...(dbError && { error: dbError }),
        },
        resend_api_key: { status: resendStatus },
        stripe_webhook_secret: { status: stripeStatus },
      },
    };

    return new Response(JSON.stringify(result, null, 2), {
      status: allOk ? 200 : 503,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Health check failed:", message);
    return new Response(
      JSON.stringify({
        status: "error",
        timestamp: new Date().toISOString(),
        error: message,
      }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
