// ============================================
// NOD — api-unsubscribe/index.ts
// Conversation 3: Consent Withdrawal + Re-Consent After Withdrawal
//
// POST /unsubscribe — Process a consent withdrawal
// PATCH /unsubscribe/{id}/synced — Confirm CRM sync
//
// Every endpoint: HMAC auth, RPC for data access, audit trail,
// no PII in errors, try/catch with founder alert on failure.
// ============================================

import { requireAuth } from "../_shared/auth.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { insertAuditLog, getClientIp } from "../_shared/audit.ts";
import { alertFounder } from "../_shared/alerting.ts";
import { addBusinessDays } from "../_shared/holiday-calculator.ts";

import {
  checkRateLimit,
  rateLimitExceededResponse,
  rateLimitHeaders,
  apiVersionHeaders,
} from "../_shared/rate-limiter.ts";
import type {
  MessageChannel,
  ConsentRecord,
  UnsubscribeRequest,
  AuthResult,
} from "../_shared/types.ts";

// ---- Constants ----

const VALID_CHANNELS: MessageChannel[] = ["email", "sms"];

// ---- CORS Headers ----

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-nod-version",
  "Access-Control-Allow-Methods": "GET, POST, PATCH, OPTIONS",
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

// ---- Route: POST /unsubscribe ----

async function handleUnsubscribe(
  request: Request,
  auth: AuthResult,
): Promise<Response> {
  const body = await request.json();

  const {
    contact_id,
    channel,
    method,
    notes,
    idempotency_key,
  } = body;

  // ---- Validation ----

  if (!contact_id || typeof contact_id !== "string") {
    return errorResponse("contact_id is required", "MISSING_FIELD", 400);
  }

  if (!channel || !VALID_CHANNELS.includes(channel)) {
    return errorResponse("Invalid channel", "INVALID_CHANNEL", 400, {
      valid_channels: VALID_CHANNELS,
    });
  }

  if (!method || typeof method !== "string" || method.trim() === "") {
    return errorResponse(
      "method is required (e.g. 'email_link', 'reply_stop', 'phone_call')",
      "MISSING_METHOD",
      400,
    );
  }

  // ---- Step 1: Insert withdrawal consent record via insert_consent_record() ----

  const supabase = getSupabaseClient();
  const clientIp = getClientIp(request);
  const requestDate = new Date();

  const { data: withdrawalData, error: withdrawalError } = await supabase.rpc(
    "insert_consent_record",
    {
      p_tenant_id: auth.tenantId,
      p_contact_id: contact_id,
      p_consent_type: "express", // Withdrawal records use express as the type
      p_channel: channel,
      p_qualifying_event_type: "other",
      p_qualifying_event: `Consent withdrawal via ${method}`,
      p_qualifying_event_date: requestDate.toISOString(),
      p_expiry_date: null,
      p_contract_expiry_date: null,
      p_purpose: null,
      p_evidence_type: null,
      p_evidence_url: null,
      p_source_description: null,
      p_obtained_by: null,
      p_is_withdrawal: true,
      p_withdrawal_method: method,
      p_idempotency_key: idempotency_key ?? null,
      p_notes: notes ?? null,
    },
  );

  if (withdrawalError) {
    if (withdrawalError.message?.includes("Contact not found")) {
      return errorResponse("Contact not found", "CONTACT_NOT_FOUND", 404);
    }

    console.error(
      "insert_consent_record (withdrawal) RPC error:",
      withdrawalError.message,
    );
    await alertFounder(
      "Withdrawal Record Insert Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Error: ${withdrawalError.message}</p>`,
    );
    return errorResponse(
      "Failed to record withdrawal",
      "INSERT_FAILED",
      500,
    );
  }

  const withdrawalRecord: ConsentRecord = Array.isArray(withdrawalData)
    ? withdrawalData[0]
    : withdrawalData;

  // ---- Step 2: Calculate 10-business-day deadline ----

  const deadlineDate = addBusinessDays(requestDate, 10);

  // ---- Step 3: Insert unsubscribe request via insert_unsubscribe_request() ----

  const { data: unsubData, error: unsubError } = await supabase.rpc(
    "insert_unsubscribe_request",
    {
      p_tenant_id: auth.tenantId,
      p_contact_id: contact_id,
      p_channel: channel,
      p_consent_withdrawal_id: withdrawalRecord.id,
      p_request_date: requestDate.toISOString(),
      p_deadline_date: deadlineDate.toISOString(),
      p_method: method,
    },
  );

  if (unsubError) {
    console.error(
      "insert_unsubscribe_request RPC error:",
      unsubError.message,
    );
    await alertFounder(
      "Unsubscribe Request Insert Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Error: ${unsubError.message}</p>`,
    );
    return errorResponse(
      "Failed to create unsubscribe request",
      "INSERT_FAILED",
      500,
    );
  }

  const unsubRecord: UnsubscribeRequest = Array.isArray(unsubData)
    ? unsubData[0]
    : unsubData;

  // ---- Step 4: Audit log — consent_withdrawn ----

  await insertAuditLog({
    tenantId: auth.tenantId,
    action: "consent_withdrawn",
    entityType: "consent_record",
    entityId: withdrawalRecord.id,
    details: {
      channel,
      contact_id,
      method,
      unsubscribe_request_id: unsubRecord.id,
      deadline_date: unsubRecord.deadline_date,
    },
    apiKeyId: auth.apiKeyId,
    ipAddress: clientIp,
  });

  // ---- Return both records ----

  return jsonResponse(
    {
      withdrawal: withdrawalRecord,
      unsubscribe_request: unsubRecord,
    },
    201,
  );
}

// ---- Route: PATCH /unsubscribe/{id}/synced ----

async function handleCrmSync(
  request: Request,
  auth: AuthResult,
  unsubscribeRequestId: string,
): Promise<Response> {
  const supabase = getSupabaseClient();
  const clientIp = getClientIp(request);

  const { data, error } = await supabase.rpc("update_unsubscribe_crm_sync", {
    p_tenant_id: auth.tenantId,
    p_unsubscribe_request_id: unsubscribeRequestId,
  });

  if (error) {
    if (error.message?.includes("not found")) {
      return errorResponse(
        "Unsubscribe request not found",
        "NOT_FOUND",
        404,
      );
    }

    console.error(
      "update_unsubscribe_crm_sync RPC error:",
      error.message,
    );
    await alertFounder(
      "CRM Sync Update Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Error: ${error.message}</p>`,
    );
    return errorResponse(
      "Failed to update CRM sync status",
      "UPDATE_FAILED",
      500,
    );
  }

  const record: UnsubscribeRequest = Array.isArray(data) ? data[0] : data;

  // ---- Audit log — unsubscribe_processed ----

  await insertAuditLog({
    tenantId: auth.tenantId,
    action: "unsubscribe_processed",
    entityType: "unsubscribe_request",
    entityId: record.id,
    details: {
      crm_sync_status: "synced",
      contact_id: record.contact_id,
      channel: record.channel,
    },
    apiKeyId: auth.apiKeyId,
    ipAddress: clientIp,
  });

  return jsonResponse(record, 200);
}

// ---- Path Parsing Helper ----

/**
 * Extract the unsubscribe request ID from a PATCH path.
 * Expected pattern: .../{uuid}/synced
 * Returns the UUID string or null if the path doesn't match.
 */
function extractUnsubIdFromPath(pathname: string): string | null {
  const segments = pathname.split("/").filter(Boolean);
  // Look for a segment that looks like a UUID followed by "synced"
  for (let i = 0; i < segments.length - 1; i++) {
    const uuidPattern =
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    if (uuidPattern.test(segments[i]) && segments[i + 1] === "synced") {
      return segments[i];
    }
  }
  return null;
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

Deno.serve(async (request: Request) => {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...corsHeaders, ...apiVersionHeaders() },
    });
  }

  try {
    // Authenticate
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

    const url = new URL(request.url);

    // POST /unsubscribe — Process withdrawal
    if (request.method === "POST") {
      return addHeaders(await handleUnsubscribe(request, auth), extraHeaders);
    }

    // PATCH /unsubscribe/{id}/synced — CRM sync confirmation
    if (request.method === "PATCH") {
      const unsubId = extractUnsubIdFromPath(url.pathname);
      if (!unsubId) {
        return addHeaders(errorResponse(
          "Invalid path. Expected: /unsubscribe/{id}/synced",
          "INVALID_PATH",
          400,
        ), extraHeaders);
      }
      return addHeaders(await handleCrmSync(request, auth, unsubId), extraHeaders);
    }

    return addHeaders(errorResponse("Method not allowed", "METHOD_NOT_ALLOWED", 405), extraHeaders);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Unhandled error in api-unsubscribe:", message);

    await alertFounder(
      "api-unsubscribe Unhandled Error",
      `<p>Error: ${message}</p><p>Stack: ${err instanceof Error ? err.stack : "N/A"}</p>`,
    );

    return addHeaders(
      errorResponse("Internal server error", "INTERNAL_ERROR", 500),
      apiVersionHeaders(),
    );
  }
});
