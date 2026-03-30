// ============================================
// NOD — api-messages-validate/index.ts
// Conversation 6: CEM Compliance Validation Endpoint
//
// POST /messages/validate
//   - Accepts { sender_profile_id, unsubscribe_url?, classification }
//   - Looks up sender profile by ID + tenant via RPC
//   - Validates sender ID fields [CASL s.6(2)]
//   - Validates unsubscribe mechanism [CASL s.11] (if required)
//   - Returns { sender_id_valid, unsubscribe_valid, compliance_result, failures[] }
//   - Audit log entry: message_validated
//
// Every endpoint: HMAC auth, RPC for data access, audit trail,
// no PII in errors, try/catch with founder alert on failure.
// ============================================

import { requireAuth } from "../_shared/auth.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { insertAuditLog, getClientIp } from "../_shared/audit.ts";
import { alertFounder } from "../_shared/alerting.ts";
import { validateCompliance } from "../_shared/validator.ts";

import {
  checkRateLimit,
  rateLimitExceededResponse,
  rateLimitHeaders,
  apiVersionHeaders,
} from "../_shared/rate-limiter.ts";
import type {
  MessageClassification,
  SenderProfile,
  AuthResult,
} from "../_shared/types.ts";

// ---- Constants ----

const VALID_CLASSIFICATIONS: MessageClassification[] = [
  "cem",
  "tier2_exempt",
  "tier1_exempt",
  "transactional",
  "non_commercial",
];

// ---- CORS Headers ----

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type, x-nod-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
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

// ---- Route: POST /messages/validate ----

async function handleValidate(
  request: Request,
  auth: AuthResult,
): Promise<Response> {
  const body = await request.json();

  const { sender_profile_id, unsubscribe_url, classification } = body;

  // ---- Validation ----

  if (
    !sender_profile_id ||
    typeof sender_profile_id !== "string" ||
    sender_profile_id.trim() === ""
  ) {
    return errorResponse(
      "sender_profile_id is required",
      "MISSING_FIELD",
      400,
    );
  }

  if (
    !classification ||
    !VALID_CLASSIFICATIONS.includes(classification)
  ) {
    return errorResponse(
      "Invalid classification",
      "INVALID_CLASSIFICATION",
      400,
      { valid_classifications: VALID_CLASSIFICATIONS },
    );
  }

  // ---- Step 1: Look up sender profile via RPC ----

  const supabase = getSupabaseClient();

  const { data: profileData, error: profileError } = await supabase.rpc(
    "get_sender_profile_by_id",
    {
      p_tenant_id: auth.tenantId,
      p_profile_id: sender_profile_id,
    },
  );

  if (profileError) {
    console.error(
      "get_sender_profile_by_id RPC error:",
      profileError.message,
    );
    await alertFounder(
      "Validate: Profile Lookup Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Profile: ${sender_profile_id}</p><p>Error: ${profileError.message}</p>`,
    );
    return errorResponse(
      "Failed to retrieve sender profile",
      "QUERY_FAILED",
      500,
    );
  }

  const profiles: SenderProfile[] = Array.isArray(profileData)
    ? profileData
    : [];

  if (profiles.length === 0) {
    return errorResponse(
      "Sender profile not found",
      "PROFILE_NOT_FOUND",
      404,
    );
  }

  const senderProfile = profiles[0];

  // ---- Step 2: Run compliance validation ----

  const result = validateCompliance({
    sender_profile: senderProfile,
    unsubscribe_url: unsubscribe_url ?? null,
    classification,
  });

  // ---- Step 3: Audit log — message_validated ----

  const clientIp = getClientIp(request);

  await insertAuditLog({
    tenantId: auth.tenantId,
    action: "message_validated",
    entityType: "sender_profile",
    entityId: sender_profile_id,
    details: {
      classification,
      sender_id_valid: result.sender_id_valid,
      unsubscribe_valid: result.unsubscribe_valid,
      compliance_result: result.compliance_result,
      failure_count: result.failures.length,
      unsubscribe_url_provided: !!unsubscribe_url,
    },
    apiKeyId: auth.apiKeyId,
    ipAddress: clientIp,
  });

  // ---- Return validation result ----

  return jsonResponse({
    sender_profile_id,
    classification,
    sender_id_valid: result.sender_id_valid,
    unsubscribe_valid: result.unsubscribe_valid,
    compliance_result: result.compliance_result,
    failures: result.failures,
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

    // POST /messages/validate
    if (request.method === "POST") {
      return addHeaders(await handleValidate(request, auth), extraHeaders);
    }

    return addHeaders(errorResponse("Method not allowed", "METHOD_NOT_ALLOWED", 405), extraHeaders);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Unhandled error in api-messages-validate:", message);

    await alertFounder(
      "api-messages-validate Unhandled Error",
      `<p>Error: ${message}</p><p>Stack: ${err instanceof Error ? err.stack : "N/A"}</p>`,
    );

    return addHeaders(
      errorResponse("Internal server error", "INTERNAL_ERROR", 500),
      apiVersionHeaders(),
    );
  }
});
