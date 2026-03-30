// ============================================
// NOD — cron-message-reset/index.ts
// Monthly message counter reset (1st of month, 5 AM UTC / midnight EST).
// Auth: CRON_SECRET header (not API key HMAC).
// Deployed with --no-verify-jwt.
//
// Calls reset_all_message_counters() RPC — resets messages_this_month
// to 0 for all tenants where counter > 0.
// Audit log entry with count of tenants reset.
// ============================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { insertAuditLog } from "../_shared/audit.ts";
import { alertFounder } from "../_shared/alerting.ts";

serve(async (req: Request) => {
  try {
    // ---- Auth: verify CRON_SECRET ----
    const cronSecret = Deno.env.get("CRON_SECRET");
    if (!cronSecret) {
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

    // ---- Reset all message counters ----
    const supabase = getSupabaseClient();

    const { data, error } = await supabase.rpc("reset_all_message_counters");

    if (error) {
      console.error("reset_all_message_counters failed:", error.message);
      await alertFounder(
        "Cron: Message Reset Failed",
        `<p>reset_all_message_counters() failed:</p><pre>${error.message}</pre>`,
      );
      return new Response(
        JSON.stringify({ error: "Reset failed", code: "RESET_FAILED", details: error.message }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    const tenantsReset = data?.[0]?.tenants_reset ?? 0;

    // ---- Audit log (system-level, use a nil UUID for tenant_id) ----
    const systemTenantId = "00000000-0000-0000-0000-000000000000";
    await insertAuditLog({
      tenantId: systemTenantId,
      action: "cron_executed",
      entityType: "cron_job",
      entityId: systemTenantId,
      details: {
        job: "cron-message-reset",
        tenants_reset: tenantsReset,
        executed_at: new Date().toISOString(),
      },
    });

    const result = {
      success: true,
      job: "cron-message-reset",
      tenants_reset: tenantsReset,
      executed_at: new Date().toISOString(),
    };

    console.log("cron-message-reset completed:", JSON.stringify(result));

    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("cron-message-reset failed:", message);
    await alertFounder(
      "Cron: Message Reset Error",
      `<p>Unhandled error in cron-message-reset:</p><pre>${message}</pre>`,
    );
    return new Response(
      JSON.stringify({ error: "Internal error", code: "INTERNAL_ERROR" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
