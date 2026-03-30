// ============================================
// NOD — api-compliance/index.ts
// Conversation 8: GET /compliance/proof/{contact_id}
// Conversation 9: GET /compliance/audit
//
// GET /compliance/proof/{contact_id} — Generate CASL s.13 proof dossier
// GET /compliance/audit — Tenant compliance audit + scoring
//
// Every endpoint: HMAC auth, RPC for data access, audit trail,
// no PII in errors, try/catch with founder alert on failure.
// ============================================

import { requireAuth } from "../_shared/auth.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { insertAuditLog, getClientIp } from "../_shared/audit.ts";
import { alertFounder } from "../_shared/alerting.ts";

import {
  checkRateLimit,
  rateLimitExceededResponse,
  rateLimitHeaders,
  apiVersionHeaders,
} from "../_shared/rate-limiter.ts";
import {
  generateProofDossier,
  generateProofHtml,
} from "../_shared/proof-generator.ts";
import type {
  AuthResult,
  Contact,
  ConsentRecord,
  MessageCheck,
  AuditLogEntry,
  ConsentStatusResult,
} from "../_shared/types.ts";

// ---- UUID regex ----

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- CORS Headers ----

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-nod-version",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
};

// ---- JSON Response Helpers ----

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders },
  });
}

function errorResponse(
  error: string,
  code: string,
  status: number,
  details?: Record<string, unknown>,
): Response {
  return jsonResponse({ error, code, ...(details ? { details } : {}) }, status);
}

// ---- Route: GET /compliance/proof/{contact_id} ----

async function handleProof(
  request: Request,
  auth: AuthResult,
  contactId: string,
): Promise<Response> {
  const supabase = getSupabaseClient();
  const ipAddress = getClientIp(request);

  // 1. Validate contact belongs to tenant via get_consent_status_batch (single-element)
  const { data: statusData, error: statusError } = await supabase.rpc(
    "get_consent_status_batch",
    {
      p_contact_ids: [contactId],
      p_channel: "email",
      p_tenant_id: auth.tenantId,
    },
  );

  if (statusError) {
    console.error("get_consent_status_batch error:", statusError.message);
    return errorResponse(
      "Failed to check consent status",
      "INTERNAL_ERROR",
      500,
    );
  }

  if (!statusData || statusData.length === 0) {
    return errorResponse("Contact not found", "CONTACT_NOT_FOUND", 404);
  }

  const consentStatus: ConsentStatusResult = statusData[0];

  // 2. Fetch contact details
  const { data: contactData, error: contactError } = await supabase.rpc(
    "get_contact_by_id",
    {
      p_tenant_id: auth.tenantId,
      p_contact_id: contactId,
    },
  );

  if (contactError) {
    console.error("get_contact_by_id error:", contactError.message);
    return errorResponse("Failed to fetch contact", "INTERNAL_ERROR", 500);
  }

  if (!contactData || contactData.length === 0) {
    return errorResponse("Contact not found", "CONTACT_NOT_FOUND", 404);
  }

  const contact: Contact = contactData[0];

  // 3. Fetch consent timeline
  const { data: timelineData, error: timelineError } = await supabase.rpc(
    "get_contact_consent_timeline",
    {
      p_tenant_id: auth.tenantId,
      p_contact_id: contactId,
    },
  );

  if (timelineError) {
    console.error(
      "get_contact_consent_timeline error:",
      timelineError.message,
    );
    return errorResponse(
      "Failed to fetch consent timeline",
      "INTERNAL_ERROR",
      500,
    );
  }

  // Timeline rows don't have tenant_id/contact_id — map to ConsentRecord shape
  const consentTimeline: ConsentRecord[] = (timelineData ?? []).map(
    (row: Record<string, unknown>) => ({
      ...row,
      tenant_id: auth.tenantId,
      contact_id: contactId,
    }),
  ) as ConsentRecord[];

  // 4. Fetch message checks
  const { data: checksData, error: checksError } = await supabase.rpc(
    "get_contact_message_checks",
    {
      p_tenant_id: auth.tenantId,
      p_contact_id: contactId,
    },
  );

  if (checksError) {
    console.error("get_contact_message_checks error:", checksError.message);
    return errorResponse(
      "Failed to fetch message checks",
      "INTERNAL_ERROR",
      500,
    );
  }

  // Map to MessageCheck shape — RPC omits tenant_id/contact_id
  const messageChecks: MessageCheck[] = (checksData ?? []).map(
    (row: Record<string, unknown>) => ({
      ...row,
      tenant_id: auth.tenantId,
      contact_id: contactId,
    }),
  ) as MessageCheck[];

  // 5. Fetch audit trail
  const { data: auditData, error: auditError } = await supabase.rpc(
    "get_consent_audit_trail",
    {
      p_tenant_id: auth.tenantId,
      p_contact_id: contactId,
    },
  );

  if (auditError) {
    console.error("get_consent_audit_trail error:", auditError.message);
    return errorResponse(
      "Failed to fetch audit trail",
      "INTERNAL_ERROR",
      500,
    );
  }

  // Map to AuditLogEntry shape — RPC omits tenant_id
  const auditTrail: AuditLogEntry[] = (auditData ?? []).map(
    (row: Record<string, unknown>) => ({
      ...row,
      tenant_id: auth.tenantId,
    }),
  ) as AuditLogEntry[];

  // 6. Assemble proof dossier
  const proof = generateProofDossier({
    tenantId: auth.tenantId,
    contact,
    consentStatus,
    consentTimeline,
    messageChecks,
    auditTrail,
  });

  // 7. Generate PDF HTML
  const html = generateProofHtml(proof);
  const htmlBytes = new TextEncoder().encode(html);

  // 8. Upload to compliance-reports storage bucket
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const storagePath = `${auth.tenantId}/${contactId}/proof_${timestamp}.html`;


  const { error: uploadError } = await supabase.storage
    .from("compliance-reports")
    .upload(storagePath, htmlBytes, {
      contentType: "text/html",
      upsert: false,
    });

  let fileUrl: string | null = null;

  if (uploadError) {
    // Log but don't fail — the JSON proof is still valuable
    console.error("Storage upload error:", uploadError.message);
  } else {
    // Generate a signed URL (valid for 7 days)
    const { data: signedUrlData, error: signedUrlError } = await supabase
      .storage
      .from("compliance-reports")
      .createSignedUrl(storagePath, 7 * 24 * 60 * 60);

    if (signedUrlError) {
      console.error("Signed URL error:", signedUrlError.message);
    } else {
      fileUrl = signedUrlData.signedUrl;
    }
  }

  // 9. Insert compliance_reports row
  const { data: reportData, error: reportError } = await supabase.rpc(
    "insert_compliance_report",
    {
      p_tenant_id: auth.tenantId,
      p_report_type: "consent_proof",
      p_data: proof,
      p_contact_id: contactId,
      p_file_url: fileUrl,
    },
  );

  if (reportError) {
    console.error("insert_compliance_report error:", reportError.message);
    // Don't fail — proof is still returned
  }

  const reportId =
    reportData && reportData.length > 0 ? reportData[0].id : null;

  // 10. Audit log
  await insertAuditLog({
    tenantId: auth.tenantId,
    action: "proof_generated",
    entityType: "compliance_report",
    entityId: reportId ?? contactId,
    details: {
      contact_id: contactId,
      consent_records_count: proof.consent_timeline.length,
      message_checks_count: proof.message_checks.length,
      audit_entries_count: proof.chain_of_custody.length,
      file_url: fileUrl,
    },
    apiKeyId: auth.apiKeyId,
    ipAddress: ipAddress,
  });

  // 11. Return JSON proof + metadata
  return jsonResponse({
    proof,
    report_id: reportId,
    pdf_url: fileUrl,
  });
}

// ---- Findings Builder ----

interface Finding {
  severity: "critical" | "warning" | "info";
  code: string;
  message: string;
  count: number;
}

function buildFindings(metrics: Record<string, unknown>): Finding[] {
  const findings: Finding[] = [];

  const overdueSync = (metrics.overdue_crm_syncs as number) ?? 0;
  if (overdueSync > 0) {
    findings.push({
      severity: "critical",
      code: "OVERDUE_CRM_SYNCS",
      message: `${overdueSync} unsubscribe request(s) past the 10-business-day CRM sync deadline [CASL s.11]`,
      count: overdueSync,
    });
  }

  const expiredRecentChecks =
    (metrics.expired_consent_with_recent_checks as number) ?? 0;
  if (expiredRecentChecks > 0) {
    findings.push({
      severity: "critical",
      code: "EXPIRED_CONSENT_RECENT_CHECKS",
      message: `${expiredRecentChecks} contact(s) with expired/no consent had message checks in the last 30 days — potential CASL violation`,
      count: expiredRecentChecks,
    });
  }

  const noConsent = (metrics.contacts_no_consent as number) ?? 0;
  if (noConsent > 0) {
    findings.push({
      severity: "warning",
      code: "CONTACTS_NO_CONSENT",
      message: `${noConsent} active contact(s) have no valid consent on record`,
      count: noConsent,
    });
  }

  const pendingSync = (metrics.pending_crm_syncs as number) ?? 0;
  if (pendingSync > 0) {
    findings.push({
      severity: "warning",
      code: "PENDING_CRM_SYNCS",
      message: `${pendingSync} unsubscribe request(s) pending CRM sync`,
      count: pendingSync,
    });
  }

  const missingEvidence =
    (metrics.express_missing_evidence as number) ?? 0;
  if (missingEvidence > 0) {
    findings.push({
      severity: "warning",
      code: "EXPRESS_MISSING_EVIDENCE",
      message: `${missingEvidence} express consent record(s) missing evidence URL — weakens s.13 proof`,
      count: missingEvidence,
    });
  }

  const spIncomplete =
    (metrics.sender_profiles_incomplete as number) ?? 0;
  if (spIncomplete > 0) {
    findings.push({
      severity: "warning",
      code: "SENDER_PROFILES_INCOMPLETE",
      message: `${spIncomplete} sender profile(s) missing one or more contact methods (phone, email, website)`,
      count: spIncomplete,
    });
  }

  const expiring7d = (metrics.expiring_7d as number) ?? 0;
  if (expiring7d > 0) {
    findings.push({
      severity: "warning",
      code: "CONSENT_EXPIRING_7D",
      message: `${expiring7d} contact(s) with consent expiring within 7 days — immediate re-consent campaign recommended`,
      count: expiring7d,
    });
  }

  const expiring14d = (metrics.expiring_14d as number) ?? 0;
  if (expiring14d > 0) {
    findings.push({
      severity: "info",
      code: "CONSENT_EXPIRING_14D",
      message: `${expiring14d} contact(s) with consent expiring within 8–14 days`,
      count: expiring14d,
    });
  }

  const expiring30d = (metrics.expiring_30d as number) ?? 0;
  if (expiring30d > 0) {
    findings.push({
      severity: "info",
      code: "CONSENT_EXPIRING_30D",
      message: `${expiring30d} contact(s) with consent expiring within 15–30 days`,
      count: expiring30d,
    });
  }

  const failChecks = (metrics.checks_fail_30d as number) ?? 0;
  if (failChecks > 0) {
    findings.push({
      severity: "info",
      code: "CHECKS_FAILING",
      message: `${failChecks} message check(s) failed in the last 30 days`,
      count: failChecks,
    });
  }

  return findings;
}

// ---- Route: GET /compliance/audit ----

async function handleAudit(
  request: Request,
  auth: AuthResult,
): Promise<Response> {
  const supabase = getSupabaseClient();
  const ipAddress = getClientIp(request);

  // 1. Get audit summary metrics
  const { data: summaryData, error: summaryError } = await supabase.rpc(
    "get_tenant_audit_summary",
    { p_tenant_id: auth.tenantId },
  );

  if (summaryError) {
    console.error("get_tenant_audit_summary error:", summaryError.message);
    return errorResponse(
      "Failed to generate audit summary",
      "INTERNAL_ERROR",
      500,
    );
  }

  if (!summaryData || summaryData.length === 0) {
    return errorResponse(
      "No audit data available",
      "NO_DATA",
      404,
    );
  }

  const metrics = summaryData[0];

  // 2. Get compliance score
  const { data: scoreData, error: scoreError } = await supabase.rpc(
    "get_compliance_score",
    { p_tenant_id: auth.tenantId },
  );

  if (scoreError) {
    console.error("get_compliance_score error:", scoreError.message);
    return errorResponse(
      "Failed to calculate compliance score",
      "INTERNAL_ERROR",
      500,
    );
  }

  if (!scoreData || scoreData.length === 0) {
    return errorResponse(
      "No score data available",
      "NO_DATA",
      404,
    );
  }

  const scoreRow = scoreData[0];

  const score = {
    overall: scoreRow.overall_score,
    components: {
      consent_coverage: {
        score: Number(scoreRow.consent_coverage_score),
        weight: 40,
        percentage: Number(scoreRow.consent_coverage_pct),
      },
      crm_sync_timeliness: {
        score: Number(scoreRow.crm_sync_score),
        weight: 20,
        percentage: Number(scoreRow.crm_sync_pct),
      },
      sender_profile_completeness: {
        score: Number(scoreRow.sender_profile_score),
        weight: 15,
        percentage: Number(scoreRow.sender_profile_pct),
      },
      check_pass_rate: {
        score: Number(scoreRow.check_pass_rate_score),
        weight: 15,
        percentage: Number(scoreRow.check_pass_rate_pct),
      },
      audit_completeness: {
        score: Number(scoreRow.audit_completeness_score),
        weight: 10,
        percentage: Number(scoreRow.audit_completeness_pct),
      },
    },
  };

  // 3. Build expiry alerts with contact details
  // Fetch all active contacts (service role bypasses RLS; explicit tenant_id filter)
  const { data: contactsData, error: contactsError } = await supabase
    .from("contacts")
    .select("id, full_name, email, phone")
    .eq("tenant_id", auth.tenantId)
    .eq("is_active", true);

  if (contactsError) {
    console.error("contacts fetch error:", contactsError.message);
    return errorResponse(
      "Failed to fetch contacts for expiry alerts",
      "INTERNAL_ERROR",
      500,
    );
  }

  const contacts: Array<{
    id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
  }> = contactsData ?? [];

  // Build contact lookup map
  const contactMap = new Map(
    contacts.map((c) => [c.id, c]),
  );

  // Get consent status for all contacts to find expiring ones
  interface ExpiryAlert {
    contact_id: string;
    full_name: string;
    email: string | null;
    phone: string | null;
    consent_type: string;
    expiry_date: string | null;
    days_until_expiry: number;
  }

  const expiryAlerts: {
    "7_days": ExpiryAlert[];
    "14_days": ExpiryAlert[];
    "30_days": ExpiryAlert[];
  } = {
    "7_days": [],
    "14_days": [],
    "30_days": [],
  };

  if (contacts.length > 0) {
    const contactIds = contacts.map((c) => c.id);

    const { data: statusData, error: statusError } = await supabase.rpc(
      "get_consent_status_batch",
      {
        p_contact_ids: contactIds,
        p_channel: "email",
        p_tenant_id: auth.tenantId,
      },
    );

    if (statusError) {
      console.error(
        "get_consent_status_batch for expiry error:",
        statusError.message,
      );
      // Non-fatal — continue with empty expiry alerts
    } else if (statusData) {
      for (const row of statusData as ConsentStatusResult[]) {
        if (
          row.days_until_expiry !== null &&
          row.days_until_expiry > 0 &&
          row.days_until_expiry <= 30
        ) {
          const contact = contactMap.get(row.contact_id);
          const alert: ExpiryAlert = {
            contact_id: row.contact_id,
            full_name: contact?.full_name ?? "Unknown",
            email: contact?.email ?? null,
            phone: contact?.phone ?? null,
            consent_type: row.status,
            expiry_date: row.expiry_date,
            days_until_expiry: row.days_until_expiry,
          };

          if (row.days_until_expiry <= 7) {
            expiryAlerts["7_days"].push(alert);
          } else if (row.days_until_expiry <= 14) {
            expiryAlerts["14_days"].push(alert);
          } else {
            expiryAlerts["30_days"].push(alert);
          }
        }
      }
    }
  }

  // 4. Build findings
  const findings = buildFindings(metrics);

  // 5. Build response data for compliance_reports storage
  const auditData = {
    score,
    metrics,
    findings,
    expiry_alerts: expiryAlerts,
  };

  // 6. Insert compliance_reports row
  const { data: reportData, error: reportError } = await supabase.rpc(
    "insert_compliance_report",
    {
      p_tenant_id: auth.tenantId,
      p_report_type: "compliance_audit",
      p_data: auditData,
      p_contact_id: null,
      p_file_url: null,
    },
  );

  if (reportError) {
    console.error("insert_compliance_report error:", reportError.message);
    // Non-fatal — continue without report_id
  }

  const reportId =
    reportData && reportData.length > 0 ? reportData[0].id : null;
  const generatedAt =
    reportData && reportData.length > 0
      ? reportData[0].generated_at
      : new Date().toISOString();

  // 7. Audit log
  await insertAuditLog({
    tenantId: auth.tenantId,
    action: "proof_generated",
    entityType: "compliance_report",
    entityId: reportId ?? auth.tenantId,
    details: {
      report_type: "compliance_audit",
      overall_score: score.overall,
      findings_count: findings.length,
      critical_findings: findings.filter((f) => f.severity === "critical")
        .length,
      expiring_7d: expiryAlerts["7_days"].length,
      expiring_14d: expiryAlerts["14_days"].length,
      expiring_30d: expiryAlerts["30_days"].length,
    },
    apiKeyId: auth.apiKeyId,
    ipAddress: ipAddress,
  });

  // 8. Return structured response
  return jsonResponse({
    score,
    metrics,
    findings,
    expiry_alerts: expiryAlerts,
    report_id: reportId,
    generated_at: generatedAt,
  });
}

// ---- Response Header Augmentation ----

function addHeaders(
  response: Response,
  extraHeaders: Record<string, string>,
): Response {
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(extraHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}

// ---- Main Handler ----

Deno.serve(async (request: Request): Promise<Response> => {
  // CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders, ...apiVersionHeaders() },
    });
  }

  try {
    // Auth
    const auth = await requireAuth(request);
    if (auth instanceof Response) return addHeaders(auth, apiVersionHeaders());

    // Rate limit check (after auth so we have the API key ID)
    const rlResult = await checkRateLimit(auth.apiKeyId, auth.tenantId);
    if (rlResult && !rlResult.allowed) {
      return rateLimitExceededResponse(rlResult, corsHeaders);
    }

    // Build extra headers: rate limit + API version
    const extraHeaders: Record<string, string> = {
      ...apiVersionHeaders(),
      ...(rlResult ? rateLimitHeaders(rlResult) : {}),
    };

    // Parse URL path
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    // Expected patterns:
    //   [..., "api-compliance", "proof", "{contact_id}"]
    //   [..., "api-compliance", "audit"]

    if (request.method !== "GET") {
      return addHeaders(errorResponse("Method not allowed", "METHOD_NOT_ALLOWED", 405), extraHeaders);
    }

    // Find "proof" segment and extract contact_id after it
    const proofIndex = segments.indexOf("proof");
    if (proofIndex !== -1 && proofIndex + 1 < segments.length) {
      const contactId = segments[proofIndex + 1];

      if (!UUID_REGEX.test(contactId)) {
        return addHeaders(errorResponse(
          "Invalid contact_id format",
          "INVALID_CONTACT_ID",
          400,
        ), extraHeaders);
      }

      return addHeaders(await handleProof(request, auth, contactId), extraHeaders);
    }

    // Find "audit" segment
    const auditIndex = segments.indexOf("audit");
    if (auditIndex !== -1) {
      return addHeaders(await handleAudit(request, auth), extraHeaders);
    }

    return addHeaders(errorResponse("Not found", "NOT_FOUND", 404), extraHeaders);
  } catch (err) {
    console.error("Unhandled error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";

    await alertFounder(
      "api-compliance unhandled error",
      `<p>Error: ${message}</p>`,
    );

    return addHeaders(
      errorResponse("Internal server error", "INTERNAL_ERROR", 500),
      apiVersionHeaders(),
    );
  }
});
