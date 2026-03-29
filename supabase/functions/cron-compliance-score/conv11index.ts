// ============================================
// NOD — cron-compliance-score/index.ts
// Weekly compliance score recalculation (Monday 9 AM EST / 2 PM UTC).
// Auth: CRON_SECRET header (not API key HMAC).
// Deployed with --no-verify-jwt.
//
// Iterates all active tenants.
// For each: calls get_compliance_score() RPC (built Conv 9),
// then update_tenant_compliance_score() to persist the score.
// Audit log entry per tenant processed.
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

    // ---- Get all active tenants ----
    const supabase = getSupabaseClient();

    const { data: tenants, error: tenantsErr } = await supabase.rpc("get_active_tenants");

    if (tenantsErr) {
      console.error("get_active_tenants failed:", tenantsErr.message);
      await alertFounder(
        "Cron: Compliance Score Failed",
        `<p>get_active_tenants() failed:</p><pre>${tenantsErr.message}</pre>`,
      );
      return new Response(
        JSON.stringify({ error: "Failed to fetch tenants", code: "TENANT_FETCH_FAILED" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    // ---- Process each tenant ----
    const results: Array<{ tenant_id: string; tenant_name: string; score: number | null; error?: string }> = [];

    for (const tenant of tenants ?? []) {
      try {
        // Get compliance score
        const { data: scoreData, error: scoreErr } = await supabase.rpc("get_compliance_score", {
          p_tenant_id: tenant.id,
        });

        if (scoreErr) {
          console.error(`get_compliance_score failed for ${tenant.name}:`, scoreErr.message);
          results.push({ tenant_id: tenant.id, tenant_name: tenant.name, score: null, error: scoreErr.message });
          continue;
        }

        const overallScore = scoreData?.[0]?.overall_score ?? null;

        // Update tenant row
        const { error: updateErr } = await supabase.rpc("update_tenant_compliance_score", {
          p_tenant_id: tenant.id,
          p_score: overallScore,
        });

        if (updateErr) {
          console.error(`update_tenant_compliance_score failed for ${tenant.name}:`, updateErr.message);
          results.push({ tenant_id: tenant.id, tenant_name: tenant.name, score: overallScore, error: updateErr.message });
          continue;
        }

        // Audit log per tenant
        await insertAuditLog({
          tenantId: tenant.id,
          action: "cron_executed",
          entityType: "cron_job",
          entityId: tenant.id,
          details: {
            job: "cron-compliance-score",
            compliance_score: overallScore,
            executed_at: new Date().toISOString(),
          },
        });

        results.push({ tenant_id: tenant.id, tenant_name: tenant.name, score: overallScore });
      } catch (tenantErr) {
        const msg = tenantErr instanceof Error ? tenantErr.message : "Unknown error";
        console.error(`cron-compliance-score error for ${tenant.name}:`, msg);
        results.push({ tenant_id: tenant.id, tenant_name: tenant.name, score: null, error: msg });
      }
    }

    const result = {
      success: true,
      job: "cron-compliance-score",
      tenants_processed: results.length,
      tenants_failed: results.filter((r) => r.error).length,
      results,
      executed_at: new Date().toISOString(),
    };

    console.log("cron-compliance-score completed:", JSON.stringify(result));

    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("cron-compliance-score failed:", message);
    await alertFounder(
      "Cron: Compliance Score Error",
      `<p>Unhandled error in cron-compliance-score:</p><pre>${message}</pre>`,
    );
    return new Response(
      JSON.stringify({ error: "Internal error", code: "INTERNAL_ERROR" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});
