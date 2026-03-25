// ============================================
// NOD — api-consent/index.ts
// Conversation 1: Express Consent + Consent Status
// Conversation 2: Implied Consent + Contract-Based Expiry
//
// POST /consent/record — Record a new consent event
// GET  /consent/status — Check consent status for a contact
//
// Every endpoint: HMAC auth, RPC for data access, audit trail,
// no PII in errors, try/catch with founder alert on failure.
// ============================================

import { requireAuth } from "../_shared/auth.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { insertAuditLog, getClientIp } from "../_shared/audit.ts";
import { alertFounder } from "../_shared/alerting.ts";
import { calculateExpiryDate } from "../_shared/expiry-calculator.ts";
import type {
  ConsentType,
  QualifyingEventType,
  MessageChannel,
  ConsentRecord,
  ConsentStatusResult,
  AuthResult,
} from "../_shared/types.ts";

// ---- Constants ----

const VALID_CONSENT_TYPES: ConsentType[] = [
  "express",
  "pre_casl_express",
  "implied_ebr",
  "implied_ebr_contract",
  "implied_inquiry",
  "conspicuous_publication",
];

const VALID_CHANNELS: MessageChannel[] = ["email", "sms"];

const VALID_EVENT_TYPES: QualifyingEventType[] = [
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

// Types that require a purpose field
const REQUIRES_PURPOSE: ConsentType[] = ["express", "pre_casl_express"];

// Types that require contract_expiry_date
const REQUIRES_CONTRACT_EXPIRY: ConsentType[] = ["implied_ebr_contract"];

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
    return errorResponse(
      "Invalid consent_type",
      "INVALID_CONSENT_TYPE",
      400,
      { valid_types: VALID_CONSENT_TYPES },
    );
  }

  if (!channel || !VALID_CHANNELS.includes(channel)) {
    return errorResponse("Invalid channel", "INVALID_CHANNEL", 400, {
      valid_channels: VALID_CHANNELS,
    });
  }

  if (
    !qualifying_event_type ||
    !VALID_EVENT_TYPES.includes(qualifying_event_type)
  ) {
    return errorResponse(
      "Invalid qualifying_event_type",
      "INVALID_EVENT_TYPE",
      400,
    );
  }

  if (!qualifying_event || typeof qualifying_event !== "string") {
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

  // Reject future qualifying_event_date
  const eventDate = new Date(qualifying_event_date);
  if (isNaN(eventDate.getTime())) {
    return errorResponse(
      "qualifying_event_date is not a valid date",
      "INVALID_DATE",
      400,
    );
  }
  if (eventDate > new Date()) {
    return errorResponse(
      "qualifying_event_date cannot be in the future",
      "FUTURE_DATE",
      400,
    );
  }

  // Express / pre_casl_express REQUIRE purpose
  if (
    REQUIRES_PURPOSE.includes(consent_type as ConsentType) &&
    (!purpose || typeof purpose !== "string" || purpose.trim() === "")
  ) {
    return errorResponse(
      "purpose is required for express and pre_casl_express consent",
      "MISSING_PURPOSE",
      400,
    );
  }

  // implied_ebr_contract REQUIRES contract_expiry_date
  if (REQUIRES_CONTRACT_EXPIRY.includes(consent_type as ConsentType)) {
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
        "contract_expiry_date is not a valid date",
        "INVALID_DATE",
        400,
      );
    }
  }

  // ---- Calculate expiry_date ----

  const expiryDate = calculateExpiryDate(
    consent_type as ConsentType,
    qualifying_event_date,
    contract_expiry_date,
  );

  // ---- Insert via RPC ----

  const supabase = getSupabaseClient();
  const clientIp = getClientIp(request);

  const { data, error } = await supabase.rpc("insert_consent_record", {
    p_tenant_id: auth.tenantId,
    p_contact_id: contact_id,
    p_consent_type: consent_type,
    p_channel: channel,
    p_qualifying_event_type: qualifying_event_type,
    p_qualifying_event: qualifying_event,
    p_qualifying_event_date: qualifying_event_date,
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
    // Contact not found for this tenant
    if (error.message?.includes("Contact not found")) {
      return errorResponse("Contact not found", "CONTACT_NOT_FOUND", 404);
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

  // RPC returns an array; take the first row
  const record: ConsentRecord = Array.isArray(data) ? data[0] : data;

  // ---- Audit log ----

  await insertAuditLog({
    tenantId: auth.tenantId,
    action: "consent_recorded",
    entityType: "consent_record",
    entityId: record.id,
    details: {
      consent_type: record.consent_type,
      channel: record.channel,
      contact_id: record.contact_id,
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
  const channel = url.searchParams.get("channel");

  if (!contactId) {
    return errorResponse("contact_id query parameter is required", "MISSING_FIELD", 400);
  }

  if (!channel || !VALID_CHANNELS.includes(channel as MessageChannel)) {
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
      `<p>Tenant: ${auth.tenantId}</p><p>Error: ${error.message}</p>`,
    );
    return errorResponse("Failed to check consent status", "STATUS_CHECK_FAILED", 500);
  }

  const result: ConsentStatusResult | null =
    Array.isArray(data) && data.length > 0 ? data[0] : null;

  if (!result) {
    return errorResponse("Contact not found", "CONTACT_NOT_FOUND", 404);
  }

  return jsonResponse(result, 200);
}

// ---- Main Handler ----

Deno.serve(async (request: Request) => {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // Authenticate
    const auth = await requireAuth(request);
    if (auth instanceof Response) return auth;

    // Route
    const url = new URL(request.url);
    const path = url.pathname;

    // POST /consent/record (or just POST to the function root)
    if (request.method === "POST") {
      return await handleRecordConsent(request, auth);
    }

    // GET /consent/status (or just GET to the function root)
    if (request.method === "GET") {
      return await handleGetStatus(request, auth);
    }

    return errorResponse("Method not allowed", "METHOD_NOT_ALLOWED", 405);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Unhandled error in api-consent:", message);

    await alertFounder(
      "api-consent Unhandled Error",
      `<p>Error: ${message}</p><p>Stack: ${err instanceof Error ? err.stack : "N/A"}</p>`,
    );

    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
});
