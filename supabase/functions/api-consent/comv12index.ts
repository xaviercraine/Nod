// ============================================
// NOD — api-consent/index.ts
// Conversation 1 + 2: Express Consent + Implied Consent
// Conversation 12: Rate Limiting + API Versioning
//
// POST /consent/record — Record consent (express, pre_casl_express, implied, withdrawal)
// GET  /consent/status — Check consent status (single contact via batch RPC)
//
// Every endpoint: HMAC auth, RPC for data access, audit trail,
// no PII in errors, try/catch with founder alert on failure.
// ============================================

import { requireAuth } from "../_shared/auth.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { insertAuditLog, getClientIp } from "../_shared/audit.ts";
import { alertFounder } from "../_shared/alerting.ts";
import { calculateExpiryDate } from "../_shared/expiry-calculator.ts";
import {
  checkRateLimit,
  rateLimitExceededResponse,
  rateLimitHeaders,
  apiVersionHeaders,
} from "../_shared/rate-limiter.ts";
import type {
  MessageChannel,
  ConsentType,
  QualifyingEventType,
  AuthResult,
} from "../_shared/types.ts";

// ---- Constants ----

const VALID_CHANNELS: MessageChannel[] = ["email", "sms"];
const VALID_CONSENT_TYPES: ConsentType[] = [
  "express",
  "pre_casl_express",
  "implied_ebr",
  "implied_ebr_contract",
  "implied_inquiry",
  "conspicuous_publication",
];
const VALID_QUALIFYING_EVENT_TYPES: QualifyingEventType[] = [
  "purchase",
  "lease",
  "service",
  "test_drive",
  "inquiry",
  "financing_contract",
  "service_contract",
  "lease_contract",
  "bartering",
  "other",
];

// ---- CORS Headers ----

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-nod-version",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
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

// ---- Route: POST /consent/record ----

async function handleRecordConsent(
  request: Request,
  auth: AuthResult,
): Promise<Response> {
  const body = await request.json();

  const {
    contact_id,
    consent_type,
    channel,
    qualifying_event_type,
    qualifying_event,
    qualifying_event_date,
    contract_expiry_date,
    purpose,
    evidence_type,
    evidence_url,
    source_description,
    obtained_by,
    idempotency_key,
    notes,
  } = body;

  // ---- Validation ----

  if (!contact_id || typeof contact_id !== "string") {
    return errorResponse("contact_id is required", "MISSING_FIELD", 400);
  }

  if (!consent_type || !VALID_CONSENT_TYPES.includes(consent_type)) {
    return errorResponse("Invalid consent_type", "INVALID_CONSENT_TYPE", 400, {
      valid_types: VALID_CONSENT_TYPES,
    });
  }

  if (!channel || !VALID_CHANNELS.includes(channel)) {
    return errorResponse("Invalid channel", "INVALID_CHANNEL", 400, {
      valid_channels: VALID_CHANNELS,
    });
  }

  if (
    !qualifying_event_type ||
    !VALID_QUALIFYING_EVENT_TYPES.includes(qualifying_event_type)
  ) {
    return errorResponse(
      "Invalid qualifying_event_type",
      "INVALID_QUALIFYING_EVENT_TYPE",
      400,
      { valid_types: VALID_QUALIFYING_EVENT_TYPES },
    );
  }

  if (
    !qualifying_event ||
    typeof qualifying_event !== "string" ||
    qualifying_event.trim() === ""
  ) {
    return errorResponse(
      "qualifying_event is required",
      "MISSING_FIELD",
      400,
    );
  }

  if (!qualifying_event_date) {
    return errorResponse(
      "qualifying_event_date is required",
      "MISSING_FIELD",
      400,
    );
  }

  const eventDate = new Date(qualifying_event_date);
  if (isNaN(eventDate.getTime())) {
    return errorResponse(
      "Invalid qualifying_event_date format",
      "INVALID_DATE",
      400,
    );
  }

  // Reject future qualifying_event_date
  if (eventDate > new Date()) {
    return errorResponse(
      "qualifying_event_date cannot be in the future",
      "FUTURE_DATE",
      400,
    );
  }

  // Express and pre_casl_express require purpose
  if (
    (consent_type === "express" || consent_type === "pre_casl_express") &&
    (!purpose || typeof purpose !== "string" || purpose.trim() === "")
  ) {
    return errorResponse(
      "purpose is required for express and pre_casl_express consent",
      "MISSING_PURPOSE",
      400,
    );
  }

  // implied_ebr_contract requires contract_expiry_date
  if (consent_type === "implied_ebr_contract") {
    if (!contract_expiry_date) {
      return errorResponse(
        "contract_expiry_date is required for implied_ebr_contract",
        "MISSING_CONTRACT_EXPIRY",
        400,
      );
    }
    const contractDate = new Date(contract_expiry_date);
    if (isNaN(contractDate.getTime())) {
      return errorResponse(
        "Invalid contract_expiry_date format",
        "INVALID_DATE",
        400,
      );
    }
  }

  // ---- Calculate expiry_date ----

  const expiryDate = calculateExpiryDate(
    consent_type,
    qualifying_event_date,
    contract_expiry_date ?? undefined,
  );

  // ---- Insert via RPC ----

  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc("insert_consent_record", {
    p_tenant_id: auth.tenantId,
    p_contact_id: contact_id,
    p_consent_type: consent_type,
    p_channel: channel,
    p_qualifying_event_type: qualifying_event_type,
    p_qualifying_event: qualifying_event,
    p_qualifying_event_date: eventDate.toISOString(),
    p_expiry_date: expiryDate,
    p_contract_expiry_date: contract_expiry_date ?? null,
    p_purpose: purpose ?? null,
    p_evidence_type: evidence_type ?? null,
    p_evidence_url: evidence_url ?? null,
    p_source_description: source_description ?? null,
    p_obtained_by: obtained_by ?? null,
    p_is_withdrawal: false,
    p_withdrawal_method: null,
    p_idempotency_key: idempotency_key ?? null,
    p_notes: notes ?? null,
  });

  if (error) {
    // Contact not found
    if (error.message?.includes("Contact not found")) {
      return errorResponse(
        "Contact not found for this tenant",
        "CONTACT_NOT_FOUND",
        404,
      );
    }

    console.error("insert_consent_record RPC error:", error.message);
    await alertFounder(
      "Consent Record Insert Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Error: ${error.message}</p>`,
    );
    return errorResponse(
      "Failed to record consent",
      "INSERT_FAILED",
      500,
    );
  }

  const rows = Array.isArray(data) ? data : [];
  const record = rows.length > 0 ? rows[0] : null;

  // ---- Audit log ----

  const clientIp = getClientIp(request);

  await insertAuditLog({
    tenantId: auth.tenantId,
    action: "consent_recorded",
    entityType: "consent_record",
    entityId: record?.id ?? crypto.randomUUID(),
    details: {
      contact_id,
      consent_type,
      channel,
      qualifying_event_type,
      qualifying_event_date,
      expiry_date: expiryDate,
      has_evidence: !!evidence_url,
      idempotency_key: idempotency_key ?? null,
    },
    apiKeyId: auth.apiKeyId,
    ipAddress: clientIp,
  });

  return jsonResponse(record, 201);
}

// ---- Route: GET /consent/status ----

async function handleGetStatus(
  request: Request,
  auth: AuthResult,
): Promise<Response> {
  const url = new URL(request.url);

  const contactId = url.searchParams.get("contact_id");
  const channel = url.searchParams.get("channel") as MessageChannel | null;

  if (!contactId) {
    return errorResponse("contact_id query parameter is required", "MISSING_FIELD", 400);
  }

  if (!channel || !VALID_CHANNELS.includes(channel)) {
    return errorResponse("Invalid or missing channel query parameter", "INVALID_CHANNEL", 400, {
      valid_channels: VALID_CHANNELS,
    });
  }

  const supabase = getSupabaseClient();

  const { data, error } = await supabase.rpc("get_consent_status_batch", {
    p_contact_ids: [contactId],
    p_channel: channel,
    p_tenant_id: auth.tenantId,
  });

  if (error) {
    console.error("get_consent_status_batch RPC error:", error.message);
    await alertFounder(
      "Consent Status Check Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Contact: ${contactId}</p><p>Error: ${error.message}</p>`,
    );
    return errorResponse("Failed to check consent status", "QUERY_FAILED", 500);
  }

  const results = Array.isArray(data) ? data : [];

  if (results.length === 0) {
    return errorResponse(
      "Contact not found for this tenant",
      "CONTACT_NOT_FOUND",
      404,
    );
  }

  const status = results[0];

  // ---- Audit log ----

  const clientIp = getClientIp(request);

  await insertAuditLog({
    tenantId: auth.tenantId,
    action: "consent_evaluated",
    entityType: "consent_record",
    entityId: status.consent_record_id ?? contactId,
    details: {
      contact_id: contactId,
      channel,
      status: status.status,
      expiry_date: status.expiry_date,
      days_until_expiry: status.days_until_expiry,
      requires_relevance_check: status.requires_relevance_check,
    },
    apiKeyId: auth.apiKeyId,
    ipAddress: clientIp,
  });

  return jsonResponse(status, 200);
}

// ---- Path Routing Helper ----

function getSubRoute(request: Request): string {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1];

  if (lastSegment === "api-consent") {
    return "record"; // default
  }

  return lastSegment;
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

    const subRoute = getSubRoute(request);

    // POST /consent/record
    if (request.method === "POST" && subRoute === "record") {
      return addHeaders(await handleRecordConsent(request, auth), extraHeaders);
    }

    // GET /consent/status
    if (request.method === "GET" && subRoute === "status") {
      return addHeaders(await handleGetStatus(request, auth), extraHeaders);
    }

    return addHeaders(
      errorResponse("Method not allowed or unknown route", "METHOD_NOT_ALLOWED", 405),
      extraHeaders,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Unhandled error in api-consent:", message);

    await alertFounder(
      "api-consent Unhandled Error",
      `<p>Error: ${message}</p><p>Stack: ${err instanceof Error ? err.stack : "N/A"}</p>`,
    );

    return addHeaders(
      errorResponse("Internal server error", "INTERNAL_ERROR", 500),
      apiVersionHeaders(),
    );
  }
});
