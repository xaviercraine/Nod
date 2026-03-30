// ============================================
// NOD — cron-unsub-deadline/index.ts
// Daily CRM sync deadline scanner (9 AM EST / 2 PM UTC).
// Auth: CRON_SECRET header (not API key HMAC).
// Deployed with --no-verify-jwt.
//
// Iterates ALL active tenants with pending unsubscribe syncs.
// For each tenant: identifies requests approaching deadline
// (within 3 business days) and overdue.
// Business day calculation uses holiday-calculator.ts.
// Sends alert email per tenant (only if approaching/overdue exist).
// Audit log entry per tenant processed.
// ============================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { insertAuditLog } from "../_shared/audit.ts";
import { sendAlert, alertFounder } from "../_shared/alerting.ts";
import { isBusinessDay } from "../_shared/holiday-calculator.ts";

interface PendingRequest {
  id: string;
  contact_id: string;
  contact_name: string;
  contact_email: string | null;
  channel: string;
  request_date: string;
  deadline_date: string;
  method: string;
  business_days_remaining: number;
  urgency: "overdue" | "approaching";
}

/**
 * Count business days between now (UTC) and a deadline date.
 * Returns negative if overdue, 0 if today is the deadline, positive if in future.
 */
function businessDaysUntil(deadlineDateStr: string): number {
  const now = new Date();
  const deadline = new Date(deadlineDateStr);

  // Normalize both to UTC date only (strip time)
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const deadlineUtc = new Date(Date.UTC(deadline.getUTCFullYear(), deadline.getUTCMonth(), deadline.getUTCDate()));

  if (deadlineUtc < todayUtc) {
    // Overdue — count business days backwards
    let count = 0;
    const cursor = new Date(deadlineUtc.getTime());
    while (cursor < todayUtc) {
      cursor.setUTCDate(cursor.getUTCDate() + 1);
      if (isBusinessDay(cursor)) {
        count++;
      }
    }
    return -count;
  }

  if (deadlineUtc.getTime() === todayUtc.getTime()) {
    return 0;
  }

  // Future — count business days forward
  let count = 0;
  const cursor = new Date(todayUtc.getTime());
  while (cursor < deadlineUtc) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    if (isBusinessDay(cursor)) {
      count++;
    }
  }
  return count;
}

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
        "Cron: Unsub Deadline Failed",
        `<p>get_active_tenants() failed:</p><pre>${tenantsErr.message}</pre>`,
      );
      return new Response(
        JSON.stringify({ error: "Failed to fetch tenants", code: "TENANT_FETCH_FAILED" }),
        { status: 500, headers: { "Content-Type": "application/json" } },
      );
    }

    // ---- Process each tenant ----
    const results: Array<{
      tenant_id: string;
      tenant_name: string;
      overdue: number;
      approaching: number;
      email_sent: boolean;
      error?: string;
    }> = [];

    for (const tenant of tenants ?? []) {
      try {
        // Get pending unsubscribe requests for this tenant
        const { data: pendingRows, error: pendingErr } = await supabase.rpc(
          "get_pending_unsubscribe_requests",
          { p_tenant_id: tenant.id },
        );

        if (pendingErr) {
          console.error(`get_pending_unsubscribe_requests failed for ${tenant.name}:`, pendingErr.message);
          results.push({
            tenant_id: tenant.id,
            tenant_name: tenant.name,
            overdue: 0,
            approaching: 0,
            email_sent: false,
            error: pendingErr.message,
          });
          continue;
        }

        if (!pendingRows || pendingRows.length === 0) {
          results.push({
            tenant_id: tenant.id,
            tenant_name: tenant.name,
            overdue: 0,
            approaching: 0,
            email_sent: false,
          });

          await insertAuditLog({
            tenantId: tenant.id,
            action: "cron_executed",
            entityType: "cron_job",
            entityId: tenant.id,
            details: {
              job: "cron-unsub-deadline",
              pending_requests: 0,
              overdue: 0,
              approaching: 0,
              email_sent: false,
              executed_at: new Date().toISOString(),
            },
          });

          continue;
        }

        // Classify each pending request
        const actionable: PendingRequest[] = [];

        for (const row of pendingRows) {
          const bDaysRemaining = businessDaysUntil(row.deadline_date);

          if (bDaysRemaining <= 3) {
            actionable.push({
              id: row.id,
              contact_id: row.contact_id,
              contact_name: row.contact_name,
              contact_email: row.contact_email,
              channel: row.channel,
              request_date: row.request_date,
              deadline_date: row.deadline_date,
              method: row.method,
              business_days_remaining: bDaysRemaining,
              urgency: bDaysRemaining <= 0 ? "overdue" : "approaching",
            });
          }
        }

        const overdueCount = actionable.filter((r) => r.urgency === "overdue").length;
        const approachingCount = actionable.filter((r) => r.urgency === "approaching").length;

        let emailSent = false;

        if (actionable.length > 0) {
          const html = buildDeadlineEmailHtml(tenant.name, actionable);

          const emailResult = await sendAlert({
            to: tenant.contact_email,
            subject: `[Nod] ${overdueCount > 0 ? "OVERDUE: " : ""}${actionable.length} CRM sync deadline(s) — ${tenant.name}`,
            html,
          });

          emailSent = emailResult.success;

          if (!emailResult.success) {
            console.error(`Unsub deadline email failed for ${tenant.name}:`, emailResult.error);
          }
        }

        // Audit log
        await insertAuditLog({
          tenantId: tenant.id,
          action: "cron_executed",
          entityType: "cron_job",
          entityId: tenant.id,
          details: {
            job: "cron-unsub-deadline",
            pending_requests: pendingRows.length,
            overdue: overdueCount,
            approaching: approachingCount,
            email_sent: emailSent,
            executed_at: new Date().toISOString(),
          },
        });

        results.push({
          tenant_id: tenant.id,
          tenant_name: tenant.name,
          overdue: overdueCount,
          approaching: approachingCount,
          email_sent: emailSent,
        });
      } catch (tenantErr) {
        const msg = tenantErr instanceof Error ? tenantErr.message : "Unknown error";
        console.error(`cron-unsub-deadline error for ${tenant.name}:`, msg);
        results.push({
          tenant_id: tenant.id,
          tenant_name: tenant.name,
          overdue: 0,
          approaching: 0,
          email_sent: false,
          error: msg,
        });
      }
    }

    const totalOverdue = results.reduce((sum, r) => sum + r.overdue, 0);
    const totalApproaching = results.reduce((sum, r) => sum + r.approaching, 0);

    const result = {
      success: true,
      job: "cron-unsub-deadline",
      tenants_processed: results.length,
      total_overdue: totalOverdue,
      total_approaching: totalApproaching,
      results,
      executed_at: new Date().toISOString(),
    };

    console.log("cron-unsub-deadline completed:", JSON.stringify(result));

    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("cron-unsub-deadline failed:", message);
    await alertFounder(
      "Cron: Unsub Deadline Error",
      `<p>Unhandled error in cron-unsub-deadline:</p><pre>${message}</pre>`,
    );
    return new Response(
      JSON.stringify({ error: "Internal error", code: "INTERNAL_ERROR" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

// ---- Email HTML builder ----

function buildDeadlineEmailHtml(tenantName: string, requests: PendingRequest[]): string {
  const overdue = requests.filter((r) => r.urgency === "overdue");
  const approaching = requests.filter((r) => r.urgency === "approaching");

  const sections: string[] = [];

  if (overdue.length > 0) {
    sections.push(buildDeadlineTableHtml("OVERDUE — Immediate Action Required", overdue, "#dc2626"));
  }
  if (approaching.length > 0) {
    sections.push(buildDeadlineTableHtml("Approaching Deadline (within 3 business days)", approaching, "#ea580c"));
  }

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">CRM Sync Deadline Alert — ${escapeHtml(tenantName)}</h2>
      <p style="color: #475569;">CASL requires unsubscribe requests to be processed within 10 business days. The following requests need attention.</p>
      ${sections.join("")}
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <p style="color: #94a3b8; font-size: 12px;">This is an automated alert from Nod CASL Compliance. Generated ${new Date().toISOString()}</p>
    </div>
  `;
}

function buildDeadlineTableHtml(title: string, requests: PendingRequest[], color: string): string {
  const rows = requests
    .sort((a, b) => a.business_days_remaining - b.business_days_remaining)
    .map(
      (r) => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f1f5f9;">${escapeHtml(r.contact_name)}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f1f5f9;">${escapeHtml(r.contact_email ?? "—")}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f1f5f9;">${escapeHtml(r.channel)}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f1f5f9;">${new Date(r.deadline_date).toLocaleDateString("en-CA")}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f1f5f9; font-weight: 600; color: ${color};">${r.business_days_remaining <= 0 ? "OVERDUE" : r.business_days_remaining + "d"}</td>
      </tr>`,
    )
    .join("");

  return `
    <div style="margin: 16px 0;">
      <h3 style="color: ${color}; margin-bottom: 8px;">${title} (${requests.length})</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <thead>
          <tr style="background: #f8fafc;">
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e2e8f0;">Name</th>
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e2e8f0;">Email</th>
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e2e8f0;">Channel</th>
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e2e8f0;">Deadline</th>
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e2e8f0;">Status</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>
  `;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
