// ============================================
// NOD — api-messages/index.ts
// Conversation 5: Message Classification Engine
//
// POST /messages/classify — Classify a message under CASL rules
//
// Every endpoint: HMAC auth, RPC for data access, audit trail,
// no PII in errors, try/catch with founder alert on failure.
// ============================================

import { requireAuth } from "../_shared/auth.ts";
import { insertAuditLog, getClientIp } from "../_shared/audit.ts";
import { alertFounder } from "../_shared/alerting.ts";
import { classifyMessage } from "../_shared/classifier.ts";
import type { MessageChannel, AuthResult } from "../_shared/types.ts";

// ---- Constants ----

const VALID_CHANNELS: MessageChannel[] = ["email", "sms"];

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

// ---- Route: POST /messages/classify ----

async function handleClassify(
  request: Request,
  auth: AuthResult,
): Promise<Response> {
  const body = await request.json();

  const {
    subject,
    body: messageBody,
    channel,
    message_type_hint,
    exemption_reason,
  } = body;

  // ---- Validation ----

  if (subject === undefined && messageBody === undefined) {
    return errorResponse(
      "At least one of subject or body is required",
      "MISSING_FIELD",
      400,
    );
  }

  if (typeof subject !== "undefined" && typeof subject !== "string") {
    return errorResponse("subject must be a string", "INVALID_FIELD", 400);
  }

  if (typeof messageBody !== "undefined" && typeof messageBody !== "string") {
    return errorResponse("body must be a string", "INVALID_FIELD", 400);
  }

  if (!channel || !VALID_CHANNELS.includes(channel)) {
    return errorResponse("Invalid channel", "INVALID_CHANNEL", 400, {
      valid_channels: VALID_CHANNELS,
    });
  }

  // Tier 1 exempt requires exemption_reason
  if (message_type_hint === "tier1_exempt") {
    if (
      !exemption_reason ||
      typeof exemption_reason !== "string" ||
      exemption_reason.trim() === ""
    ) {
      return errorResponse(
        "exemption_reason is required when message_type_hint is 'tier1_exempt'",
        "MISSING_EXEMPTION_REASON",
        400,
      );
    }
  }

  // ---- Classify ----

  const result = classifyMessage({
    subject: subject ?? "",
    body: messageBody ?? "",
    message_type_hint,
    exemption_reason,
  });

  // ---- Audit log — message_classified ----

  const clientIp = getClientIp(request);

  // Generate a deterministic entity ID for the audit log entry
  // (no message_checks row yet — that happens in Conv 7A pre-send check)
  const entityId = crypto.randomUUID();

  await insertAuditLog({
    tenantId: auth.tenantId,
    action: "message_classified",
    entityType: "message_classification",
    entityId,
    details: {
      channel,
      classification: result.classification,
      reasons: result.reasons,
      requires_consent: result.requires_consent,
      requires_sender_id: result.requires_sender_id,
      requires_unsubscribe: result.requires_unsubscribe,
      message_type_hint: message_type_hint ?? null,
      exemption_reason: exemption_reason ?? null,
    },
    apiKeyId: auth.apiKeyId,
    ipAddress: clientIp,
  });

  // ---- Return classification result ----

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

    // POST /messages/classify
    if (request.method === "POST") {
      return await handleClassify(request, auth);
    }

    return errorResponse("Method not allowed", "METHOD_NOT_ALLOWED", 405);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Unhandled error in api-messages:", message);

    await alertFounder(
      "api-messages Unhandled Error",
      `<p>Error: ${message}</p><p>Stack: ${err instanceof Error ? err.stack : "N/A"}</p>`,
    );

    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
});
