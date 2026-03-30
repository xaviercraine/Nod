// ============================================
// NOD — cron-expiry-alerts/index.ts
// Daily consent expiry alert scanner (9 AM EST / 2 PM UTC).
// Auth: CRON_SECRET header (not API key HMAC).
// Deployed with --no-verify-jwt.
//
// READ-ONLY on consent_records. Does NOT update consent_records.
// Iterates ALL active tenants.
// For each tenant: calls get_consent_status_batch() on all active
// contacts for email channel.
// Buckets contacts by days_until_expiry: 7, 14, 30 days.
// Sends one Resend email per tenant (only if expiring contacts exist).
// Audit log entry per tenant processed.
// ============================================

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { insertAuditLog } from "../_shared/audit.ts";
import { sendAlert, alertFounder } from "../_shared/alerting.ts";

interface ExpiringContact {
  contact_id: string;
  full_name: string;
  email: string | null;
  status: string;
  days_until_expiry: number;
  expiry_date: string;
}

interface ExpiryBuckets {
  within_7d: ExpiringContact[];
  within_14d: ExpiringContact[];
  within_30d: ExpiringContact[];
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
        "Cron: Expiry Alerts Failed",
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
      expiring_contacts: number;
      email_sent: boolean;
      error?: string;
    }> = [];

    for (const tenant of tenants ?? []) {
      try {
        // Get all active contact IDs for this tenant
        const { data: contactRows, error: contactErr } = await supabase.rpc(
          "get_tenant_active_contact_ids",
          { p_tenant_id: tenant.id },
        );

        if (contactErr) {
          console.error(`get_tenant_active_contact_ids failed for ${tenant.name}:`, contactErr.message);
          results.push({
            tenant_id: tenant.id,
            tenant_name: tenant.name,
            expiring_contacts: 0,
            email_sent: false,
            error: contactErr.message,
          });
          continue;
        }

        const contactIds = (contactRows ?? []).map((r: { contact_id: string }) => r.contact_id);

        if (contactIds.length === 0) {
          results.push({
            tenant_id: tenant.id,
            tenant_name: tenant.name,
            expiring_contacts: 0,
            email_sent: false,
          });
          continue;
        }

        // Get consent status for all contacts (email channel)
        const { data: consentStatuses, error: consentErr } = await supabase.rpc(
          "get_consent_status_batch",
          {
            p_contact_ids: contactIds,
            p_channel: "email",
            p_tenant_id: tenant.id,
          },
        );

        if (consentErr) {
          console.error(`get_consent_status_batch failed for ${tenant.name}:`, consentErr.message);
          results.push({
            tenant_id: tenant.id,
            tenant_name: tenant.name,
            expiring_contacts: 0,
            email_sent: false,
            error: consentErr.message,
          });
          continue;
        }

        // Filter to contacts with expiry within 30 days
        const expiringStatuses = (consentStatuses ?? []).filter(
          (cs: { days_until_expiry: number | null }) =>
            cs.days_until_expiry !== null && cs.days_until_expiry > 0 && cs.days_until_expiry <= 30,
        );

        if (expiringStatuses.length === 0) {
          results.push({
            tenant_id: tenant.id,
            tenant_name: tenant.name,
            expiring_contacts: 0,
            email_sent: false,
          });

          // Audit even when no expiring contacts
          await insertAuditLog({
            tenantId: tenant.id,
            action: "cron_executed",
            entityType: "cron_job",
            entityId: tenant.id,
            details: {
              job: "cron-expiry-alerts",
              expiring_contacts: 0,
              email_sent: false,
              executed_at: new Date().toISOString(),
            },
          });

          continue;
        }

        // Fetch contact details for expiring contacts
        const expiringContactIds = expiringStatuses.map((cs: { contact_id: string }) => cs.contact_id);

        const { data: contactDetails, error: detailsErr } = await supabase
          .from("contacts")
          .select("id, full_name, email")
          .in("id", expiringContactIds);

        if (detailsErr) {
          console.error(`Contact details fetch failed for ${tenant.name}:`, detailsErr.message);
        }

        const contactMap = new Map<string, { full_name: string; email: string | null }>();
        for (const c of contactDetails ?? []) {
          contactMap.set(c.id, { full_name: c.full_name, email: c.email });
        }

        // Bucket contacts by urgency
        const buckets: ExpiryBuckets = {
          within_7d: [],
          within_14d: [],
          within_30d: [],
        };

        for (const cs of expiringStatuses) {
          const contact = contactMap.get(cs.contact_id);
          const entry: ExpiringContact = {
            contact_id: cs.contact_id,
            full_name: contact?.full_name ?? "Unknown",
            email: contact?.email ?? null,
            status: cs.status,
            days_until_expiry: cs.days_until_expiry,
            expiry_date: cs.expiry_date,
          };

          if (cs.days_until_expiry <= 7) {
            buckets.within_7d.push(entry);
          } else if (cs.days_until_expiry <= 14) {
            buckets.within_14d.push(entry);
          } else {
            buckets.within_30d.push(entry);
          }
        }

        // Build and send alert email
        const html = buildExpiryEmailHtml(tenant.name, buckets);

        const emailResult = await sendAlert({
          to: tenant.contact_email,
          subject: `[Nod] ${expiringStatuses.length} consent(s) expiring soon — ${tenant.name}`,
          html,
        });

        if (!emailResult.success) {
          console.error(`Expiry alert email failed for ${tenant.name}:`, emailResult.error);
        }

        // Audit log
        await insertAuditLog({
          tenantId: tenant.id,
          action: "cron_executed",
          entityType: "cron_job",
          entityId: tenant.id,
          details: {
            job: "cron-expiry-alerts",
            expiring_contacts: expiringStatuses.length,
            within_7d: buckets.within_7d.length,
            within_14d: buckets.within_14d.length,
            within_30d: buckets.within_30d.length,
            email_sent: emailResult.success,
            executed_at: new Date().toISOString(),
          },
        });

        results.push({
          tenant_id: tenant.id,
          tenant_name: tenant.name,
          expiring_contacts: expiringStatuses.length,
          email_sent: emailResult.success,
        });
      } catch (tenantErr) {
        const msg = tenantErr instanceof Error ? tenantErr.message : "Unknown error";
        console.error(`cron-expiry-alerts error for ${tenant.name}:`, msg);
        results.push({
          tenant_id: tenant.id,
          tenant_name: tenant.name,
          expiring_contacts: 0,
          email_sent: false,
          error: msg,
        });
      }
    }

    const totalExpiring = results.reduce((sum, r) => sum + r.expiring_contacts, 0);

    const result = {
      success: true,
      job: "cron-expiry-alerts",
      tenants_processed: results.length,
      total_expiring_contacts: totalExpiring,
      results,
      executed_at: new Date().toISOString(),
    };

    console.log("cron-expiry-alerts completed:", JSON.stringify(result));

    return new Response(JSON.stringify(result, null, 2), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("cron-expiry-alerts failed:", message);
    await alertFounder(
      "Cron: Expiry Alerts Error",
      `<p>Unhandled error in cron-expiry-alerts:</p><pre>${message}</pre>`,
    );
    return new Response(
      JSON.stringify({ error: "Internal error", code: "INTERNAL_ERROR" }),
      { status: 500, headers: { "Content-Type": "application/json" } },
    );
  }
});

// ---- Email HTML builder ----

function buildExpiryEmailHtml(tenantName: string, buckets: ExpiryBuckets): string {
  const sections: string[] = [];

  if (buckets.within_7d.length > 0) {
    sections.push(buildBucketHtml("Expiring within 7 days", buckets.within_7d, "#dc2626"));
  }
  if (buckets.within_14d.length > 0) {
    sections.push(buildBucketHtml("Expiring within 14 days", buckets.within_14d, "#ea580c"));
  }
  if (buckets.within_30d.length > 0) {
    sections.push(buildBucketHtml("Expiring within 30 days", buckets.within_30d, "#ca8a04"));
  }

  return `
    <div style="font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #1e293b;">Consent Expiry Alert — ${escapeHtml(tenantName)}</h2>
      <p style="color: #475569;">The following contacts have consent expiring soon. Consider initiating re-consent campaigns to maintain compliance.</p>
      ${sections.join("")}
      <hr style="border: none; border-top: 1px solid #e2e8f0; margin: 24px 0;" />
      <p style="color: #94a3b8; font-size: 12px;">This is an automated alert from Nod CASL Compliance. Generated ${new Date().toISOString()}</p>
    </div>
  `;
}

function buildBucketHtml(title: string, contacts: ExpiringContact[], color: string): string {
  const rows = contacts
    .sort((a, b) => a.days_until_expiry - b.days_until_expiry)
    .map(
      (c) => `
      <tr>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f1f5f9;">${escapeHtml(c.full_name)}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f1f5f9;">${escapeHtml(c.email ?? "—")}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f1f5f9;">${escapeHtml(c.status)}</td>
        <td style="padding: 8px 12px; border-bottom: 1px solid #f1f5f9; font-weight: 600; color: ${color};">${c.days_until_expiry}d</td>
      </tr>`,
    )
    .join("");

  return `
    <div style="margin: 16px 0;">
      <h3 style="color: ${color}; margin-bottom: 8px;">${title} (${contacts.length})</h3>
      <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
        <thead>
          <tr style="background: #f8fafc;">
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e2e8f0;">Name</th>
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e2e8f0;">Email</th>
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e2e8f0;">Consent</th>
            <th style="padding: 8px 12px; text-align: left; border-bottom: 2px solid #e2e8f0;">Expires</th>
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
