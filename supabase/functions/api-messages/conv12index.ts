// ============================================
// NOD — api-messages/index.ts
// Conversation 5 + 7A + 7B: Message Classification + Pre-Send Check (Single + Batch)
//
// POST /messages/classify — Classify a message under CASL rules (Conv 5)
// POST /messages/check   — Full pre-send compliance check (Conv 7A single, Conv 7B batch)
//
// Every endpoint: HMAC auth, RPC for data access, audit trail,
// no PII in errors, try/catch with founder alert on failure.
// ============================================

import { requireAuth } from "../_shared/auth.ts";
import { getSupabaseClient } from "../_shared/supabase.ts";
import { insertAuditLog, getClientIp } from "../_shared/audit.ts";
import { alertFounder } from "../_shared/alerting.ts";
import { classifyMessage } from "../_shared/classifier.ts";
import { validateCompliance } from "../_shared/validator.ts";
import {
  checkRateLimit,
  rateLimitExceededResponse,
  rateLimitHeaders,
  apiVersionHeaders,
} from "../_shared/rate-limiter.ts";
import type {
  MessageChannel,
  AuthResult,
  SenderProfile,
  ConsentStatusResult,
  ComplianceResult,
} from "../_shared/types.ts";

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

// ---- Route: POST /messages/classify (Conv 5 — unchanged) ----

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

// ---- Shared types for compliance evaluation ----

interface ComplianceFailure {
  field: string;
  code: string;
  message: string;
}

interface ComplianceWarning {
  type: string;
  message: string;
  days_until_expiry?: number;
}

// ---- Per-contact compliance evaluation (shared by single + batch) ----

function evaluateContactCompliance(
  consentStatus: ConsentStatusResult | null,
  requiresConsent: boolean,
  validationResult: { sender_id_valid: boolean; unsubscribe_valid: boolean; failures: ComplianceFailure[] },
): {
  complianceResult: ComplianceResult;
  failures: ComplianceFailure[];
  warnings: ComplianceWarning[];
  consentTypeUsed: string | null;
} {
  const failures: ComplianceFailure[] = [];
  const warnings: ComplianceWarning[] = [];

  // Consent failures (only when consent was checked)
  if (requiresConsent && consentStatus) {
    if (consentStatus.status === "no_consent") {
      failures.push({
        field: "consent",
        code: "no_valid_consent",
        message:
          "No valid consent on record for this contact and channel",
      });
    }
  }

  // Sender ID + unsubscribe failures (from validator)
  failures.push(...validationResult.failures);

  // Consent warnings (only when consent was checked and is valid)
  if (
    requiresConsent &&
    consentStatus &&
    consentStatus.status !== "no_consent"
  ) {
    // Conspicuous publication → requires manual relevance check
    if (consentStatus.requires_relevance_check) {
      warnings.push({
        type: "requires_relevance_check",
        message:
          "Conspicuous publication consent requires relevance verification before each send",
      });
    }

    // Consent expiring within 30 days
    if (
      consentStatus.days_until_expiry != null &&
      consentStatus.days_until_expiry <= 30
    ) {
      warnings.push({
        type: "consent_expiring",
        message: `Consent expiring in ${consentStatus.days_until_expiry} days — consider re-consent campaign`,
        days_until_expiry: consentStatus.days_until_expiry,
      });
    }
  }

  // Determine final result
  let complianceResult: ComplianceResult;
  if (failures.length > 0) {
    complianceResult = "fail";
  } else if (warnings.length > 0) {
    complianceResult = "warning";
  } else {
    complianceResult = "pass";
  }

  const consentTypeUsed =
    consentStatus && consentStatus.status !== "no_consent"
      ? consentStatus.status
      : null;

  return { complianceResult, failures, warnings, consentTypeUsed };
}

// ---- Route: POST /messages/check (Conv 7A single + Conv 7B batch) ----

async function handleCheck(
  request: Request,
  auth: AuthResult,
): Promise<Response> {
  const body = await request.json();

  // ---- Detect batch vs single mode ----
  const isBatchMode = Array.isArray(body.contact_ids);

  if (isBatchMode) {
    return await handleCheckBatch(request, auth, body);
  } else {
    return await handleCheckSingle(request, auth, body);
  }
}

// ---- Single-contact pre-send check (Conv 7A — logic unchanged) ----

async function handleCheckSingle(
  _request: Request,
  auth: AuthResult,
  body: Record<string, unknown>,
): Promise<Response> {
  const {
    contact_id,
    channel,
    subject,
    body: messageBody,
    message_type_hint,
    exemption_reason,
    sender_profile_id,
    unsubscribe_url,
  } = body;

  // ---- Input validation ----

  if (!contact_id || typeof contact_id !== "string" || (contact_id as string).trim() === "") {
    return errorResponse("contact_id is required", "MISSING_FIELD", 400);
  }

  if (!channel || !VALID_CHANNELS.includes(channel as MessageChannel)) {
    return errorResponse("Invalid channel", "INVALID_CHANNEL", 400, {
      valid_channels: VALID_CHANNELS,
    });
  }

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

  if (
    !sender_profile_id ||
    typeof sender_profile_id !== "string" ||
    (sender_profile_id as string).trim() === ""
  ) {
    return errorResponse("sender_profile_id is required", "MISSING_FIELD", 400);
  }

  // Tier 1 exempt requires exemption_reason
  if (message_type_hint === "tier1_exempt") {
    if (
      !exemption_reason ||
      typeof exemption_reason !== "string" ||
      (exemption_reason as string).trim() === ""
    ) {
      return errorResponse(
        "exemption_reason is required when message_type_hint is 'tier1_exempt'",
        "MISSING_EXEMPTION_REASON",
        400,
      );
    }
  }

  const supabase = getSupabaseClient();

  // ---- Pipeline Step 1: Classify message ----

  const classification = classifyMessage({
    subject: (subject as string) ?? "",
    body: (messageBody as string) ?? "",
    message_type_hint: message_type_hint as string | undefined,
    exemption_reason: exemption_reason as string | undefined,
  });

  // ---- Pipeline Step 2: Check consent (only when required) ----

  let consentStatus: ConsentStatusResult | null = null;

  if (classification.requires_consent) {
    const { data: consentData, error: consentError } = await supabase.rpc(
      "get_consent_status_batch",
      {
        p_contact_ids: [contact_id],
        p_channel: channel,
        p_tenant_id: auth.tenantId,
      },
    );

    if (consentError) {
      console.error("get_consent_status_batch RPC error:", consentError.message);
      await alertFounder(
        "Pre-Send Check: Consent Lookup Failed",
        `<p>Tenant: ${auth.tenantId}</p><p>Contact: ${contact_id}</p><p>Error: ${consentError.message}</p>`,
      );
      return errorResponse(
        "Failed to check consent status",
        "QUERY_FAILED",
        500,
      );
    }

    const results: ConsentStatusResult[] = Array.isArray(consentData)
      ? consentData
      : [];

    if (results.length === 0) {
      // Contact not found in batch results — likely doesn't belong to tenant
      return errorResponse(
        "Contact not found for this tenant",
        "CONTACT_NOT_FOUND",
        404,
      );
    }

    consentStatus = results[0];
  }

  // ---- Pipeline Step 3: Look up sender profile via RPC ----

  const { data: profileData, error: profileError } = await supabase.rpc(
    "get_sender_profile_by_id",
    {
      p_tenant_id: auth.tenantId,
      p_profile_id: sender_profile_id,
    },
  );

  if (profileError) {
    console.error("get_sender_profile_by_id RPC error:", profileError.message);
    await alertFounder(
      "Pre-Send Check: Profile Lookup Failed",
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

  // ---- Pipeline Step 4: Validate sender ID + unsubscribe ----

  const validationResult = validateCompliance({
    sender_profile: senderProfile,
    unsubscribe_url: (unsubscribe_url as string) ?? null,
    classification: classification.classification,
  });

  // ---- Pipeline Step 5: Determine overall compliance_result ----

  const { complianceResult, failures, warnings, consentTypeUsed } =
    evaluateContactCompliance(
      consentStatus,
      classification.requires_consent,
      validationResult,
    );

  // ---- Pipeline Step 6: INSERT into message_checks via RPC ----

  const { data: checkData, error: checkError } = await supabase.rpc(
    "insert_message_check",
    {
      p_tenant_id: auth.tenantId,
      p_contact_id: contact_id,
      p_channel: channel,
      p_message_classification: classification.classification,
      p_classification_reasons: classification.reasons,
      p_exemption_reason: (exemption_reason as string) ?? null,
      p_compliance_result: complianceResult,
      p_compliance_failures:
        failures.length > 0 ? JSON.stringify(failures) : null,
      p_consent_type_used: consentTypeUsed,
      p_consent_record_id: consentStatus?.consent_record_id ?? null,
      p_consent_expiry_at_check: consentStatus?.expiry_date ?? null,
      p_sender_profile_id: sender_profile_id,
      p_sender_id_valid: validationResult.sender_id_valid,
      p_unsubscribe_valid: validationResult.unsubscribe_valid,
      p_message_hash: null,
    },
  );

  if (checkError) {
    console.error("insert_message_check RPC error:", checkError.message);
    await alertFounder(
      "Pre-Send Check: Insert Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Contact: ${contact_id}</p><p>Error: ${checkError.message}</p>`,
    );
    return errorResponse(
      "Failed to record message check",
      "QUERY_FAILED",
      500,
    );
  }

  const checkRows = Array.isArray(checkData) ? checkData : [];
  const checkRow = checkRows.length > 0 ? checkRows[0] : null;

  // ---- Pipeline Step 7: Audit log — message_validated ----

  const clientIp = getClientIp(_request);

  await insertAuditLog({
    tenantId: auth.tenantId,
    action: "message_validated",
    entityType: "message_check",
    entityId: checkRow?.id ?? crypto.randomUUID(),
    details: {
      contact_id,
      channel,
      classification: classification.classification,
      consent_status: consentStatus?.status ?? "not_checked",
      sender_profile_id,
      sender_id_valid: validationResult.sender_id_valid,
      unsubscribe_valid: validationResult.unsubscribe_valid,
      compliance_result: complianceResult,
      failure_count: failures.length,
      warning_count: warnings.length,
    },
    apiKeyId: auth.apiKeyId,
    ipAddress: clientIp,
  });

  // ---- Return full structured result ----

  return jsonResponse(
    {
      message_check_id: checkRow?.id ?? null,
      contact_id,
      channel,
      classification: {
        classification: classification.classification,
        reasons: classification.reasons,
        requires_consent: classification.requires_consent,
        requires_sender_id: classification.requires_sender_id,
        requires_unsubscribe: classification.requires_unsubscribe,
      },
      consent: consentStatus
        ? {
            status: consentStatus.status,
            consent_record_id: consentStatus.consent_record_id,
            expiry_date: consentStatus.expiry_date,
            days_until_expiry: consentStatus.days_until_expiry,
            requires_relevance_check:
              consentStatus.requires_relevance_check ?? false,
          }
        : null,
      sender_validation: {
        sender_profile_id,
        sender_id_valid: validationResult.sender_id_valid,
        unsubscribe_valid: validationResult.unsubscribe_valid,
        failures: validationResult.failures,
      },
      compliance_result: complianceResult,
      compliance_failures: failures,
      warnings,
      checked_at: checkRow?.checked_at ?? new Date().toISOString(),
    },
    200,
  );
}

// ---- Batch pre-send check (Conv 7B) ----

async function handleCheckBatch(
  _request: Request,
  auth: AuthResult,
  body: Record<string, unknown>,
): Promise<Response> {
  const {
    contact_ids,
    channel,
    subject,
    body: messageBody,
    message_type_hint,
    exemption_reason,
    sender_profile_id,
    unsubscribe_url,
  } = body;

  // ---- Input validation ----

  const contactIds = contact_ids as unknown[];

  if (!Array.isArray(contactIds) || contactIds.length === 0) {
    return errorResponse("contact_ids must be a non-empty array", "INVALID_FIELD", 400);
  }

  // Validate each entry is a non-empty string
  for (let i = 0; i < contactIds.length; i++) {
    if (typeof contactIds[i] !== "string" || (contactIds[i] as string).trim() === "") {
      return errorResponse(
        `contact_ids[${i}] must be a non-empty UUID string`,
        "INVALID_FIELD",
        400,
      );
    }
  }

  if (!channel || !VALID_CHANNELS.includes(channel as MessageChannel)) {
    return errorResponse("Invalid channel", "INVALID_CHANNEL", 400, {
      valid_channels: VALID_CHANNELS,
    });
  }

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

  if (
    !sender_profile_id ||
    typeof sender_profile_id !== "string" ||
    (sender_profile_id as string).trim() === ""
  ) {
    return errorResponse("sender_profile_id is required", "MISSING_FIELD", 400);
  }

  // Tier 1 exempt requires exemption_reason
  if (message_type_hint === "tier1_exempt") {
    if (
      !exemption_reason ||
      typeof exemption_reason !== "string" ||
      (exemption_reason as string).trim() === ""
    ) {
      return errorResponse(
        "exemption_reason is required when message_type_hint is 'tier1_exempt'",
        "MISSING_EXEMPTION_REASON",
        400,
      );
    }
  }

  const supabase = getSupabaseClient();

  // ---- Batch Pipeline Step 1: Filter to tenant-owned contacts ----

  const { data: filterData, error: filterError } = await supabase.rpc(
    "filter_tenant_contact_ids",
    {
      p_tenant_id: auth.tenantId,
      p_contact_ids: contactIds,
    },
  );

  if (filterError) {
    console.error("filter_tenant_contact_ids RPC error:", filterError.message);
    await alertFounder(
      "Batch Pre-Send: Contact Filter Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Error: ${filterError.message}</p>`,
    );
    return errorResponse("Failed to validate contacts", "QUERY_FAILED", 500);
  }

  const tenantContactIds: string[] = Array.isArray(filterData)
    ? filterData.map((r: { contact_id: string }) => r.contact_id)
    : [];

  if (tenantContactIds.length === 0) {
    return errorResponse(
      "No valid contacts found for this tenant",
      "NO_VALID_CONTACTS",
      404,
    );
  }

  const batchSize = tenantContactIds.length;

  // ---- Batch Pipeline Step 2: Check monthly message limit BEFORE processing ----

  const { data: limitsData, error: limitsError } = await supabase.rpc(
    "get_tenant_message_limits",
    { p_tenant_id: auth.tenantId },
  );

  if (limitsError) {
    console.error("get_tenant_message_limits RPC error:", limitsError.message);
    await alertFounder(
      "Batch Pre-Send: Limits Check Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Error: ${limitsError.message}</p>`,
    );
    return errorResponse("Failed to check message limits", "QUERY_FAILED", 500);
  }

  const limitsRows = Array.isArray(limitsData) ? limitsData : [];
  if (limitsRows.length === 0) {
    return errorResponse("Tenant not found", "TENANT_NOT_FOUND", 404);
  }

  const { messages_this_month, max_messages_per_month } = limitsRows[0];

  if (messages_this_month + batchSize > max_messages_per_month) {
    return errorResponse(
      "Monthly message limit would be exceeded",
      "MONTHLY_LIMIT_EXCEEDED",
      402,
      {
        messages_this_month,
        max_messages_per_month,
        batch_size: batchSize,
        remaining: max_messages_per_month - messages_this_month,
      },
    );
  }

  // ---- Batch Pipeline Step 3: Classify message ONCE ----

  const classification = classifyMessage({
    subject: (subject as string) ?? "",
    body: (messageBody as string) ?? "",
    message_type_hint: message_type_hint as string | undefined,
    exemption_reason: exemption_reason as string | undefined,
  });

  // ---- Batch Pipeline Step 4: Check consent via single RPC call ----

  let consentMap: Map<string, ConsentStatusResult> = new Map();

  if (classification.requires_consent) {
    const { data: consentData, error: consentError } = await supabase.rpc(
      "get_consent_status_batch",
      {
        p_contact_ids: tenantContactIds,
        p_channel: channel,
        p_tenant_id: auth.tenantId,
      },
    );

    if (consentError) {
      console.error("get_consent_status_batch RPC error:", consentError.message);
      await alertFounder(
        "Batch Pre-Send: Consent Lookup Failed",
        `<p>Tenant: ${auth.tenantId}</p><p>Batch size: ${batchSize}</p><p>Error: ${consentError.message}</p>`,
      );
      return errorResponse("Failed to check consent status", "QUERY_FAILED", 500);
    }

    const consentResults: ConsentStatusResult[] = Array.isArray(consentData)
      ? consentData
      : [];

    for (const result of consentResults) {
      consentMap.set(result.contact_id, result);
    }
  }

  // ---- Batch Pipeline Step 5: Look up sender profile ONCE ----

  const { data: profileData, error: profileError } = await supabase.rpc(
    "get_sender_profile_by_id",
    {
      p_tenant_id: auth.tenantId,
      p_profile_id: sender_profile_id,
    },
  );

  if (profileError) {
    console.error("get_sender_profile_by_id RPC error:", profileError.message);
    await alertFounder(
      "Batch Pre-Send: Profile Lookup Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Profile: ${sender_profile_id}</p><p>Error: ${profileError.message}</p>`,
    );
    return errorResponse("Failed to retrieve sender profile", "QUERY_FAILED", 500);
  }

  const profiles: SenderProfile[] = Array.isArray(profileData)
    ? profileData
    : [];

  if (profiles.length === 0) {
    return errorResponse("Sender profile not found", "PROFILE_NOT_FOUND", 404);
  }

  const senderProfile = profiles[0];

  // ---- Batch Pipeline Step 6: Validate sender ID + unsubscribe ONCE ----

  const validationResult = validateCompliance({
    sender_profile: senderProfile,
    unsubscribe_url: (unsubscribe_url as string) ?? null,
    classification: classification.classification,
  });

  // ---- Batch Pipeline Step 7: Per-contact evaluation + insert message_checks ----

  interface BatchContactResult {
    message_check_id: string | null;
    contact_id: string;
    compliance_result: ComplianceResult;
    consent: {
      status: string;
      consent_record_id: string | null;
      expiry_date: string | null;
      days_until_expiry: number | null;
      requires_relevance_check: boolean;
    } | null;
    compliance_failures: ComplianceFailure[];
    warnings: ComplianceWarning[];
  }

  const contactResults: BatchContactResult[] = [];
  let passCount = 0;
  let failCount = 0;
  let warningCount = 0;

  for (const cid of tenantContactIds) {
    const consentStatus = consentMap.get(cid) ?? null;

    const { complianceResult, failures, warnings, consentTypeUsed } =
      evaluateContactCompliance(
        consentStatus,
        classification.requires_consent,
        validationResult,
      );

    // Insert message_check for this contact
    const { data: checkData, error: checkError } = await supabase.rpc(
      "insert_message_check",
      {
        p_tenant_id: auth.tenantId,
        p_contact_id: cid,
        p_channel: channel,
        p_message_classification: classification.classification,
        p_classification_reasons: classification.reasons,
        p_exemption_reason: (exemption_reason as string) ?? null,
        p_compliance_result: complianceResult,
        p_compliance_failures:
          failures.length > 0 ? JSON.stringify(failures) : null,
        p_consent_type_used: consentTypeUsed,
        p_consent_record_id: consentStatus?.consent_record_id ?? null,
        p_consent_expiry_at_check: consentStatus?.expiry_date ?? null,
        p_sender_profile_id: sender_profile_id,
        p_sender_id_valid: validationResult.sender_id_valid,
        p_unsubscribe_valid: validationResult.unsubscribe_valid,
        p_message_hash: null,
      },
    );

    if (checkError) {
      console.error(`insert_message_check RPC error for contact ${cid}:`, checkError.message);
      // Continue processing remaining contacts — don't fail entire batch
      // Log but don't abort
    }

    const checkRows = Array.isArray(checkData) ? checkData : [];
    const checkRow = checkRows.length > 0 ? checkRows[0] : null;

    // Track summary counts
    if (complianceResult === "pass") passCount++;
    else if (complianceResult === "fail") failCount++;
    else if (complianceResult === "warning") warningCount++;

    contactResults.push({
      message_check_id: checkRow?.id ?? null,
      contact_id: cid,
      compliance_result: complianceResult,
      consent: consentStatus
        ? {
            status: consentStatus.status,
            consent_record_id: consentStatus.consent_record_id,
            expiry_date: consentStatus.expiry_date,
            days_until_expiry: consentStatus.days_until_expiry,
            requires_relevance_check:
              consentStatus.requires_relevance_check ?? false,
          }
        : null,
      compliance_failures: failures,
      warnings,
    });
  }

  // ---- Batch Pipeline Step 8: Atomic counter increment ----

  const { error: incrementError } = await supabase.rpc(
    "increment_messages_this_month",
    {
      p_tenant_id: auth.tenantId,
      p_count: batchSize,
    },
  );

  if (incrementError) {
    console.error("increment_messages_this_month RPC error:", incrementError.message);
    await alertFounder(
      "Batch Pre-Send: Counter Increment Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Batch size: ${batchSize}</p><p>Error: ${incrementError.message}</p>`,
    );
    // Don't fail the response — checks are already recorded
    // Counter will be corrected on next monthly reset worst case
  }

  // ---- Batch Pipeline Step 9: Audit log ----

  const clientIp = getClientIp(_request);

  await insertAuditLog({
    tenantId: auth.tenantId,
    action: "message_validated",
    entityType: "message_check_batch",
    entityId: crypto.randomUUID(),
    details: {
      batch_size: batchSize,
      contacts_submitted: (contactIds as string[]).length,
      contacts_excluded: (contactIds as string[]).length - batchSize,
      channel,
      classification: classification.classification,
      sender_profile_id,
      sender_id_valid: validationResult.sender_id_valid,
      unsubscribe_valid: validationResult.unsubscribe_valid,
      summary: { total: batchSize, pass: passCount, fail: failCount, warning: warningCount },
    },
    apiKeyId: auth.apiKeyId,
    ipAddress: clientIp,
  });

  // ---- Return batch results ----

  return jsonResponse(
    {
      batch: true,
      channel,
      classification: {
        classification: classification.classification,
        reasons: classification.reasons,
        requires_consent: classification.requires_consent,
        requires_sender_id: classification.requires_sender_id,
        requires_unsubscribe: classification.requires_unsubscribe,
      },
      sender_validation: {
        sender_profile_id,
        sender_id_valid: validationResult.sender_id_valid,
        unsubscribe_valid: validationResult.unsubscribe_valid,
        failures: validationResult.failures,
      },
      summary: {
        total: batchSize,
        pass: passCount,
        fail: failCount,
        warning: warningCount,
        contacts_submitted: (contactIds as string[]).length,
        contacts_excluded: (contactIds as string[]).length - batchSize,
      },
      results: contactResults,
    },
    200,
  );
}

// ---- Path Routing Helper ----

/**
 * Extract the sub-route from the URL path.
 * Supabase Edge Function URLs: /functions/v1/api-messages/{sub-route}
 * Uses segment-based extraction (proven pattern from Conv 3 + Conv 6).
 */
function getSubRoute(request: Request): string {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);
  const lastSegment = segments[segments.length - 1];

  // If last segment is the function name itself, no sub-route
  if (lastSegment === "api-messages") {
    return "classify"; // backward compat: bare POST defaults to classify
  }

  return lastSegment;
}

// ---- Response Header Augmentation ----

/**
 * Clone a Response with additional headers added on top.
 * Used to inject rate limit + API version headers onto handler responses
 * without modifying any handler logic.
 */
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

    if (request.method !== "POST") {
      return addHeaders(
        errorResponse("Method not allowed", "METHOD_NOT_ALLOWED", 405),
        extraHeaders,
      );
    }

    // Route based on path
    const subRoute = getSubRoute(request);

    let response: Response;

    switch (subRoute) {
      case "classify":
        response = await handleClassify(request, auth);
        break;
      case "check":
        response = await handleCheck(request, auth);
        break;
      default:
        response = errorResponse(
          "Unknown route. Valid routes: /messages/classify, /messages/check",
          "UNKNOWN_ROUTE",
          404,
        );
        break;
    }

    return addHeaders(response, extraHeaders);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Unhandled error in api-messages:", message);

    await alertFounder(
      "api-messages Unhandled Error",
      `<p>Error: ${message}</p><p>Stack: ${err instanceof Error ? err.stack : "N/A"}</p>`,
    );

    return addHeaders(
      errorResponse("Internal server error", "INTERNAL_ERROR", 500),
      apiVersionHeaders(),
    );
  }
});
