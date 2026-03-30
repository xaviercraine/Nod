// ============================================
// NOD — api-contacts/index.ts
// Conversation 4: Batch Contact Import + Consent Classification
//
// POST /contacts/import — Batch import contacts with consent classification
// GET  /contacts       — List contacts with pagination, search, consent filter
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
  ConsentStatusResult,
  AuthResult,
} from "../_shared/types.ts";

// ---- Constants ----

const MAX_BATCH_SIZE = 500;
const VALID_CHANNELS: MessageChannel[] = ["email", "sms"];
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const E164_REGEX = /^\+[1-9]\d{6,14}$/;

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

// ---- Consent Classification Types ----

interface ConsentClassification {
  consent_type: ConsentType;
  channel: MessageChannel;
  qualifying_event_type: QualifyingEventType;
  qualifying_event: string;
  qualifying_event_date: string;
  expiry_date: string | null;
  contract_expiry_date?: string | null;
  purpose?: string | null;
  evidence_type?: string | null;
  evidence_url?: string | null;
  source_description?: string | null;
  obtained_by?: string | null;
}

interface ImportContact {
  full_name: string;
  email?: string | null;
  phone?: string | null;
  external_id?: string | null;
  company?: string | null;
  source?: string | null;
  tags?: string[];
  // DMS consent data
  purchase_date?: string | null;
  inquiry_date?: string | null;
  financing_contract_start?: string | null;
  financing_contract_end?: string | null;
  express_consent_date?: string | null;
  express_purpose?: string | null;
  express_evidence_type?: string | null;
  express_evidence_url?: string | null;
  express_obtained_by?: string | null;
  // Channel override (default: email)
  channel?: MessageChannel | null;
}

// ---- Consent Classification Logic ----

function classifyConsent(
  contact: ImportContact,
  contactId: string,
  now: Date,
): { classifications: ConsentClassification[]; errors: string[] } {
  const classifications: ConsentClassification[] = [];
  const errors: string[] = [];
  const channel: MessageChannel = contact.channel && VALID_CHANNELS.includes(contact.channel)
    ? contact.channel
    : "email";

  // Purchase → implied_ebr
  if (contact.purchase_date) {
    const eventDate = new Date(contact.purchase_date);
    if (isNaN(eventDate.getTime())) {
      errors.push("Invalid purchase_date format");
    } else if (eventDate > now) {
      errors.push("purchase_date cannot be in the future");
    } else {
      const expiryDate = calculateExpiryDate("implied_ebr", contact.purchase_date);
      classifications.push({
        consent_type: "implied_ebr",
        channel,
        qualifying_event_type: "purchase",
        qualifying_event: "Vehicle purchase (DMS import)",
        qualifying_event_date: eventDate.toISOString(),
        expiry_date: expiryDate,
      });
    }
  }

  // Inquiry → implied_inquiry
  if (contact.inquiry_date) {
    const eventDate = new Date(contact.inquiry_date);
    if (isNaN(eventDate.getTime())) {
      errors.push("Invalid inquiry_date format");
    } else if (eventDate > now) {
      errors.push("inquiry_date cannot be in the future");
    } else {
      const expiryDate = calculateExpiryDate("implied_inquiry", contact.inquiry_date);
      classifications.push({
        consent_type: "implied_inquiry",
        channel,
        qualifying_event_type: "inquiry",
        qualifying_event: "Customer inquiry (DMS import)",
        qualifying_event_date: eventDate.toISOString(),
        expiry_date: expiryDate,
      });
    }
  }

  // Financing contract → implied_ebr_contract
  if (contact.financing_contract_start && contact.financing_contract_end) {
    const startDate = new Date(contact.financing_contract_start);
    const endDate = new Date(contact.financing_contract_end);
    if (isNaN(startDate.getTime()) || isNaN(endDate.getTime())) {
      errors.push("Invalid financing contract date format");
    } else if (startDate > now) {
      errors.push("financing_contract_start cannot be in the future");
    } else {
      const expiryDate = calculateExpiryDate(
        "implied_ebr_contract",
        contact.financing_contract_start,
        contact.financing_contract_end,
      );
      classifications.push({
        consent_type: "implied_ebr_contract",
        channel,
        qualifying_event_type: "financing_contract",
        qualifying_event: "Financing contract (DMS import)",
        qualifying_event_date: startDate.toISOString(),
        expiry_date: expiryDate,
        contract_expiry_date: endDate.toISOString(),
      });
    }
  } else if (contact.financing_contract_start && !contact.financing_contract_end) {
    errors.push("financing_contract_end is required when financing_contract_start is provided");
  } else if (!contact.financing_contract_start && contact.financing_contract_end) {
    errors.push("financing_contract_start is required when financing_contract_end is provided");
  }

  // Express consent
  if (contact.express_consent_date) {
    const eventDate = new Date(contact.express_consent_date);
    if (isNaN(eventDate.getTime())) {
      errors.push("Invalid express_consent_date format");
    } else if (eventDate > now) {
      errors.push("express_consent_date cannot be in the future");
    } else if (!contact.express_purpose) {
      errors.push("express_purpose is required when express_consent_date is provided");
    } else {
      classifications.push({
        consent_type: "express",
        channel,
        qualifying_event_type: "other",
        qualifying_event: "Express consent (DMS import)",
        qualifying_event_date: eventDate.toISOString(),
        expiry_date: null,
        purpose: contact.express_purpose,
        evidence_type: contact.express_evidence_type ?? null,
        evidence_url: contact.express_evidence_url ?? null,
        obtained_by: contact.express_obtained_by ?? null,
      });
    }
  }

  return { classifications, errors };
}

// ---- Route: POST /contacts/import ----

async function handleImport(
  request: Request,
  auth: AuthResult,
): Promise<Response> {
  const body = await request.json();
  const { contacts } = body;

  // ---- Validation ----

  if (!contacts || !Array.isArray(contacts) || contacts.length === 0) {
    return errorResponse(
      "contacts array is required and must not be empty",
      "INVALID_BODY",
      400,
    );
  }

  if (contacts.length > MAX_BATCH_SIZE) {
    return errorResponse(
      `Batch size ${contacts.length} exceeds maximum of ${MAX_BATCH_SIZE}`,
      "BATCH_TOO_LARGE",
      400,
      { max_batch_size: MAX_BATCH_SIZE },
    );
  }

  // Validate each contact
  const validationErrors: { index: number; errors: string[] }[] = [];
  for (let i = 0; i < contacts.length; i++) {
    const c = contacts[i] as ImportContact;
    const errs: string[] = [];

    if (!c.full_name || typeof c.full_name !== "string" || c.full_name.trim() === "") {
      errs.push("full_name is required");
    }
    if (!c.email && !c.phone) {
      errs.push("At least one of email or phone is required");
    }
    if (c.email && !EMAIL_REGEX.test(c.email)) {
      errs.push("Invalid email format");
    }
    if (c.phone && !E164_REGEX.test(c.phone)) {
      errs.push("Invalid phone format (must be E.164, e.g. +14165551234)");
    }
    if (c.channel && !VALID_CHANNELS.includes(c.channel)) {
      errs.push("Invalid channel (must be 'email' or 'sms')");
    }

    if (errs.length > 0) {
      validationErrors.push({ index: i, errors: errs });
    }
  }

  if (validationErrors.length > 0) {
    return errorResponse(
      "Validation failed for one or more contacts",
      "VALIDATION_FAILED",
      400,
      { validation_errors: validationErrors },
    );
  }

  // ---- Step 1: Batch import contacts via RPC ----

  const supabase = getSupabaseClient();
  const clientIp = getClientIp(request);
  const now = new Date();

  // Build the contacts JSONB array for the RPC
  const contactsPayload = contacts.map((c: ImportContact) => ({
    full_name: c.full_name.trim(),
    email: c.email?.toLowerCase().trim() || null,
    phone: c.phone?.trim() || null,
    external_id: c.external_id || null,
    company: c.company || null,
    source: c.source || "dms_import",
    tags: c.tags || [],
  }));

  const { data: importData, error: importError } = await supabase.rpc(
    "batch_import_contacts",
    {
      p_tenant_id: auth.tenantId,
      p_contacts: contactsPayload,
    },
  );

  if (importError) {
    if (importError.message?.includes("max_contacts")) {
      return errorResponse(
        "Batch would exceed the contact limit for this tenant",
        "MAX_CONTACTS_EXCEEDED",
        400,
      );
    }

    console.error("batch_import_contacts RPC error:", importError.message);
    await alertFounder(
      "Batch Import Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Error: ${importError.message}</p>`,
    );
    return errorResponse("Failed to import contacts", "IMPORT_FAILED", 500);
  }

  const importResults: { contact_id: string; is_new: boolean; input_index: number }[] =
    Array.isArray(importData) ? importData : [];

  // ---- Step 2: Classify consent for each contact ----

  const consentPayload: Record<string, unknown>[] = [];
  const classificationErrors: { index: number; errors: string[] }[] = [];

  // Track per-contact classifications for the response
  const perContactConsent: Map<number, ConsentClassification[]> = new Map();

  for (const result of importResults) {
    const originalContact = contacts[result.input_index] as ImportContact;
    const { classifications, errors } = classifyConsent(originalContact, result.contact_id, now);

    if (errors.length > 0) {
      classificationErrors.push({ index: result.input_index, errors });
    }

    if (classifications.length > 0) {
      perContactConsent.set(result.input_index, classifications);

      for (const cls of classifications) {
        consentPayload.push({
          contact_id: result.contact_id,
          consent_type: cls.consent_type,
          channel: cls.channel,
          qualifying_event_type: cls.qualifying_event_type,
          qualifying_event: cls.qualifying_event,
          qualifying_event_date: cls.qualifying_event_date,
          expiry_date: cls.expiry_date,
          contract_expiry_date: cls.contract_expiry_date ?? null,
          purpose: cls.purpose ?? null,
          evidence_type: cls.evidence_type ?? null,
          evidence_url: cls.evidence_url ?? null,
          source_description: cls.source_description ?? null,
          obtained_by: cls.obtained_by ?? null,
          notes: "Imported from DMS batch",
        });
      }
    }
  }

  // ---- Step 3: Batch insert consent records (if any) ----

  let consentRecordCount = 0;

  if (consentPayload.length > 0) {
    const { data: consentData, error: consentError } = await supabase.rpc(
      "batch_insert_consent_records",
      {
        p_tenant_id: auth.tenantId,
        p_records: consentPayload,
      },
    );

    if (consentError) {
      console.error(
        "batch_insert_consent_records RPC error:",
        consentError.message,
      );
      await alertFounder(
        "Batch Consent Insert Failed",
        `<p>Tenant: ${auth.tenantId}</p><p>Error: ${consentError.message}</p>`,
      );
      return errorResponse(
        "Contacts imported but consent records failed",
        "CONSENT_INSERT_FAILED",
        500,
      );
    }

    consentRecordCount = Array.isArray(consentData) ? consentData.length : 0;
  }

  // ---- Step 4: Audit log ----

  const newCount = importResults.filter((r) => r.is_new).length;
  const dupeCount = importResults.filter((r) => !r.is_new).length;

  await insertAuditLog({
    tenantId: auth.tenantId,
    action: "contact_imported",
    entityType: "contact",
    entityId: auth.tenantId, // Batch operation — entity is the tenant
    details: {
      batch_size: contacts.length,
      new_contacts: newCount,
      duplicates: dupeCount,
      consent_records_created: consentRecordCount,
      classification_errors: classificationErrors.length > 0
        ? classificationErrors
        : undefined,
    },
    apiKeyId: auth.apiKeyId,
    ipAddress: clientIp,
  });

  // ---- Response ----

  return jsonResponse(
    {
      imported: newCount,
      duplicates: dupeCount,
      consent_records_created: consentRecordCount,
      contacts: importResults.map((r) => ({
        contact_id: r.contact_id,
        is_new: r.is_new,
        input_index: r.input_index,
      })),
      ...(classificationErrors.length > 0
        ? { classification_warnings: classificationErrors }
        : {}),
    },
    201,
  );
}

// ---- Route: GET /contacts ----

async function handleGetContacts(
  request: Request,
  auth: AuthResult,
): Promise<Response> {
  const url = new URL(request.url);

  // Parse query params
  const limitParam = parseInt(url.searchParams.get("limit") ?? "50", 10);
  const limit = Math.min(Math.max(limitParam, 1), 200);
  const offset = Math.max(parseInt(url.searchParams.get("offset") ?? "0", 10), 0);
  const search = url.searchParams.get("search") || null;
  const consentStatusFilter = url.searchParams.get("consent_status") || null;
  const channelParam = (url.searchParams.get("channel") || "email") as MessageChannel;

  if (!VALID_CHANNELS.includes(channelParam)) {
    return errorResponse("Invalid channel parameter", "INVALID_CHANNEL", 400, {
      valid_channels: VALID_CHANNELS,
    });
  }

  // ---- Step 1: Get paginated contacts ----

  const supabase = getSupabaseClient();

  const { data: contactsData, error: contactsError } = await supabase.rpc(
    "get_contacts_paginated",
    {
      p_tenant_id: auth.tenantId,
      p_limit: limit,
      p_offset: offset,
      p_search: search,
    },
  );

  if (contactsError) {
    console.error("get_contacts_paginated RPC error:", contactsError.message);
    await alertFounder(
      "Get Contacts Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Error: ${contactsError.message}</p>`,
    );
    return errorResponse("Failed to retrieve contacts", "QUERY_FAILED", 500);
  }

  const contactRows: Record<string, unknown>[] = Array.isArray(contactsData)
    ? contactsData
    : [];

  if (contactRows.length === 0) {
    return jsonResponse({
      contacts: [],
      pagination: { total: 0, limit, offset, has_more: false },
    });
  }

  // ---- Step 2: Get consent status for all contacts in a single RPC call ----

  const contactIds = contactRows.map((c) => c.contact_id as string);

  const { data: statusData, error: statusError } = await supabase.rpc(
    "get_consent_status_batch",
    {
      p_contact_ids: contactIds,
      p_channel: channelParam,
      p_tenant_id: auth.tenantId,
    },
  );

  if (statusError) {
    console.error(
      "get_consent_status_batch RPC error:",
      statusError.message,
    );
    await alertFounder(
      "Consent Status Batch Failed",
      `<p>Tenant: ${auth.tenantId}</p><p>Error: ${statusError.message}</p>`,
    );
    return errorResponse(
      "Failed to retrieve consent status",
      "STATUS_FAILED",
      500,
    );
  }

  const statusResults: ConsentStatusResult[] = Array.isArray(statusData)
    ? statusData
    : [];

  // Build a map for quick lookup
  const statusMap = new Map<string, ConsentStatusResult>();
  for (const s of statusResults) {
    statusMap.set(s.contact_id, s);
  }

  // ---- Step 3: Merge contacts with consent status ----

  const totalCount = contactRows.length > 0
    ? (contactRows[0].total_count as number)
    : 0;

  let mergedContacts = contactRows.map((c) => {
    const status = statusMap.get(c.contact_id as string);
    return {
      id: c.contact_id,
      external_id: c.external_id,
      full_name: c.full_name,
      email: c.email,
      phone: c.phone,
      company: c.company,
      source: c.source,
      tags: c.tags,
      is_active: c.is_active,
      created_at: c.created_at,
      updated_at: c.updated_at,
      consent: {
        status: status?.status ?? "no_consent",
        expiry_date: status?.expiry_date ?? null,
        days_until_expiry: status?.days_until_expiry ?? null,
        requires_relevance_check: status?.requires_relevance_check ?? false,
        warning: status?.warning ?? null,
      },
    };
  });

  // ---- Step 4: Apply consent status filter (post-query) ----

  let filteredTotal = totalCount;

  if (consentStatusFilter) {
    mergedContacts = mergedContacts.filter(
      (c) => c.consent.status === consentStatusFilter,
    );
    filteredTotal = mergedContacts.length;
  }

  return jsonResponse({
    contacts: mergedContacts,
    pagination: {
      total: consentStatusFilter ? filteredTotal : totalCount,
      limit,
      offset,
      has_more: consentStatusFilter
        ? false // Post-filtered, can't know server-side total
        : offset + limit < totalCount,
    },
    ...(consentStatusFilter ? { filter: { consent_status: consentStatusFilter, channel: channelParam } } : {}),
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

    const url = new URL(request.url);
    const pathname = url.pathname;

    // POST /contacts/import
    if (request.method === "POST" && pathname.endsWith("/import")) {
      return addHeaders(await handleImport(request, auth), extraHeaders);
    }

    // GET /contacts
    if (request.method === "GET") {
      return addHeaders(await handleGetContacts(request, auth), extraHeaders);
    }

    return addHeaders(errorResponse("Method not allowed", "METHOD_NOT_ALLOWED", 405), extraHeaders);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Unhandled error in api-contacts:", message);

    await alertFounder(
      "api-contacts Unhandled Error",
      `<p>Error: ${message}</p><p>Stack: ${err instanceof Error ? err.stack : "N/A"}</p>`,
    );

    return addHeaders(
      errorResponse("Internal server error", "INTERNAL_ERROR", 500),
      apiVersionHeaders(),
    );
  }
});
