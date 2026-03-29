-- ============================================
-- NOD — Conversation 8: Consent Proof Generation
-- Migration: get_contact_by_id, get_contact_consent_timeline,
-- get_contact_message_checks, get_consent_audit_trail,
-- insert_compliance_report RPCs + _shared/proof-generator.ts
-- + api-compliance Edge Function
-- Deployed: 2026-03-29
-- ============================================

-- ============================================
-- STEP 1: get_contact_by_id() RPC
-- Simple contact lookup by ID + tenant for proof assembly.
-- ============================================

CREATE OR REPLACE FUNCTION get_contact_by_id(
  p_tenant_id uuid,
  p_contact_id uuid
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  external_id text,
  email text,
  phone text,
  full_name text,
  company text,
  source text,
  tags text[],
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  RETURN QUERY
  SELECT
    c.id, c.tenant_id, c.external_id, c.email, c.phone,
    c.full_name, c.company, c.source, c.tags, c.is_active,
    c.created_at, c.updated_at
  FROM contacts c
  WHERE c.id = p_contact_id
    AND c.tenant_id = p_tenant_id;
END;
$$;

-- ============================================
-- STEP 2: get_contact_consent_timeline() RPC
-- Returns ALL consent_records for a contact in chronological order.
-- Every row — nothing filtered by expiry or withdrawal.
-- Uses idx_consent_contact_timeline.
-- ============================================

CREATE OR REPLACE FUNCTION get_contact_consent_timeline(
  p_tenant_id uuid,
  p_contact_id uuid
)
RETURNS TABLE (
  id uuid,
  consent_type consent_type,
  channel message_channel,
  qualifying_event_type qualifying_event_type,
  qualifying_event text,
  qualifying_event_date timestamptz,
  contract_expiry_date timestamptz,
  expiry_date timestamptz,
  purpose text,
  evidence_type text,
  evidence_url text,
  source_description text,
  obtained_by text,
  is_withdrawal boolean,
  withdrawal_method text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  RETURN QUERY
  SELECT
    cr.id, cr.consent_type, cr.channel,
    cr.qualifying_event_type, cr.qualifying_event, cr.qualifying_event_date,
    cr.contract_expiry_date, cr.expiry_date, cr.purpose,
    cr.evidence_type, cr.evidence_url, cr.source_description,
    cr.obtained_by, cr.is_withdrawal, cr.withdrawal_method,
    cr.created_at
  FROM consent_records cr
  WHERE cr.tenant_id = p_tenant_id
    AND cr.contact_id = p_contact_id
  ORDER BY cr.created_at ASC;
END;
$$;

-- ============================================
-- STEP 3: get_contact_message_checks() RPC
-- Returns ALL message_checks for a contact in chronological order.
-- ============================================

CREATE OR REPLACE FUNCTION get_contact_message_checks(
  p_tenant_id uuid,
  p_contact_id uuid
)
RETURNS TABLE (
  id uuid,
  channel message_channel,
  message_classification message_classification,
  classification_reasons text[],
  exemption_reason text,
  compliance_result compliance_result,
  compliance_failures jsonb,
  consent_type_used consent_type,
  consent_record_id uuid,
  consent_expiry_at_check timestamptz,
  sender_profile_id uuid,
  sender_id_valid boolean,
  unsubscribe_valid boolean,
  message_hash text,
  checked_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  RETURN QUERY
  SELECT
    mc.id, mc.channel, mc.message_classification,
    mc.classification_reasons, mc.exemption_reason,
    mc.compliance_result, mc.compliance_failures,
    mc.consent_type_used, mc.consent_record_id,
    mc.consent_expiry_at_check, mc.sender_profile_id,
    mc.sender_id_valid, mc.unsubscribe_valid,
    mc.message_hash, mc.checked_at
  FROM message_checks mc
  WHERE mc.tenant_id = p_tenant_id
    AND mc.contact_id = p_contact_id
  ORDER BY mc.checked_at ASC;
END;
$$;

-- ============================================
-- STEP 4: get_consent_audit_trail() RPC
-- Returns audit_log entries where entity_type = 'consent_record'
-- and entity_id matches any consent_record.id for this contact.
-- Provides chain of custody for the proof dossier.
-- ============================================

CREATE OR REPLACE FUNCTION get_consent_audit_trail(
  p_tenant_id uuid,
  p_contact_id uuid
)
RETURNS TABLE (
  id uuid,
  action audit_action,
  entity_type text,
  entity_id uuid,
  details jsonb,
  api_key_id uuid,
  ip_address text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  RETURN QUERY
  SELECT
    al.id, al.action, al.entity_type, al.entity_id,
    al.details, al.api_key_id, al.ip_address, al.created_at
  FROM audit_log al
  WHERE al.tenant_id = p_tenant_id
    AND al.entity_type = 'consent_record'
    AND al.entity_id IN (
      SELECT cr.id
      FROM consent_records cr
      WHERE cr.tenant_id = p_tenant_id
        AND cr.contact_id = p_contact_id
    );
END;
$$;

-- ============================================
-- STEP 5: insert_compliance_report() RPC
-- Inserts into compliance_reports and returns the new row.
-- ============================================

CREATE OR REPLACE FUNCTION insert_compliance_report(
  p_tenant_id uuid,
  p_report_type text,
  p_data jsonb,
  p_contact_id uuid DEFAULT NULL,
  p_file_url text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  report_type text,
  generated_at timestamptz,
  data jsonb,
  contact_id uuid,
  file_url text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  -- Verify contact belongs to tenant (when provided)
  IF p_contact_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = p_contact_id AND c.tenant_id = p_tenant_id
    ) THEN
      RAISE EXCEPTION 'Contact not found for this tenant'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  RETURN QUERY
  INSERT INTO compliance_reports (
    tenant_id, report_type, data, contact_id, file_url
  ) VALUES (
    p_tenant_id, p_report_type, p_data, p_contact_id, p_file_url
  )
  RETURNING
    compliance_reports.id,
    compliance_reports.tenant_id,
    compliance_reports.report_type,
    compliance_reports.generated_at,
    compliance_reports.data,
    compliance_reports.contact_id,
    compliance_reports.file_url;
END;
$$;

-- ============================================
-- STEP 6: TypeScript — _shared/proof-generator.ts (deployed via CLI)
-- Location: supabase/functions/_shared/proof-generator.ts
-- Pure proof dossier assembly + HTML generation.
-- Receives pre-fetched data, returns structured JSON.
-- No database calls.
-- ============================================

-- ============================================
-- STEP 7: api-compliance Edge Function (deployed via CLI)
-- Location: supabase/functions/api-compliance/index.ts
-- GET /compliance/proof/{contact_id} — Generate CASL s.13 proof dossier
--   Pipeline: auth → validate contact → fetch contact/timeline/checks/audit
--   → assemble proof → generate HTML → upload to storage → insert report row
--   → return JSON proof + pdf_url
-- Auth: HMAC-SHA-256 API key → tenant_id
-- ============================================

-- ============================================
-- BUG FIX LOG
--
-- api-compliance/index.ts: Initial version called supabase.rpc("set_tenant_context")
-- with .catch() to set tenant context for storage RLS policies. The Supabase JS
-- client's .rpc() returns a PostgrestBuilder, not a standard Promise, so .catch()
-- threw TypeError. Fix: removed the call entirely — service role key bypasses
-- storage RLS, so tenant context is not needed for uploads.
-- ============================================

-- ============================================
-- TEST RESULTS (2026-03-29)
--
-- Test A: Alice Chen (express) — status 'express', timeline shows
--         express → withdrawal → re-consent (3 records). PDF + report created. ✅
-- Test B: Grace Liu (EBR-contract) — status 'implied_ebr_contract',
--         contract_expiry_date present, expiry = contract + 2yr. ✅
-- Test C: Bob Martinez (withdrawal) — status 'no_consent',
--         timeline shows express → withdrawal (both rows present, unmodified). ✅
-- Test D: Frank Patel (withdrawal + re-consent) — status 'pre_casl_express',
--         timeline shows 5 records: inquiry → EBR → withdrawal → EBR → pre_casl. ✅
-- Test E: compliance_reports table: 4 rows, all with has_file = true,
--         PDF HTML uploaded to compliance-reports bucket at correct paths. ✅
-- ============================================
