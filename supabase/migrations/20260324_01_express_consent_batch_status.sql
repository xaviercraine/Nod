-- ============================================
-- NOD — Conversation 1: Express Consent + get_consent_status_batch() Full Implementation
-- Consolidated migration: full batch status function, insert_consent_record RPC,
-- api-consent Edge Function deployed
-- Deployed: 2026-03-24
-- ============================================

-- ============================================
-- STEP 1: Full get_consent_status_batch() — replaces stub from 0A
-- Heart of Nod: evaluates consent status for an array of contacts
-- in a single query execution via CTEs and window functions.
-- ============================================

CREATE OR REPLACE FUNCTION get_consent_status_batch(
  p_contact_ids uuid[],
  p_channel message_channel,
  p_tenant_id uuid
)
RETURNS TABLE (
  contact_id uuid,
  status text,
  consent_record_id uuid,
  expiry_date timestamptz,
  days_until_expiry integer,
  requires_relevance_check boolean,
  warning text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- 1. Set tenant context (transaction-scoped)
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  RETURN QUERY
  WITH
  -- Unnest input array into a set of contact IDs
  input_contacts AS (
    SELECT unnest(p_contact_ids) AS cid
  ),

  -- 2. For each contact, find the latest withdrawal date (if any)
  latest_withdrawals AS (
    SELECT
      cr.contact_id AS cid,
      MAX(cr.created_at) AS withdrawal_at
    FROM consent_records cr
    WHERE cr.tenant_id = p_tenant_id
      AND cr.contact_id = ANY(p_contact_ids)
      AND cr.channel = p_channel
      AND cr.is_withdrawal = true
    GROUP BY cr.contact_id
  ),

  -- 3. Post-withdrawal candidates: consent records created AFTER the latest withdrawal.
  --    Critical type filter: if a withdrawal exists, only express/pre_casl_express/conspicuous_publication
  --    can override it. Implied types are excluded when a withdrawal exists.
  post_withdrawal_candidates AS (
    SELECT
      cr.id AS record_id,
      cr.contact_id AS cid,
      cr.consent_type,
      cr.expiry_date AS rec_expiry_date,
      -- Precedence: lower number = higher priority
      CASE cr.consent_type
        WHEN 'express'                  THEN 1
        WHEN 'pre_casl_express'         THEN 1
        WHEN 'implied_ebr'              THEN 2
        WHEN 'implied_ebr_contract'     THEN 2
        WHEN 'implied_inquiry'          THEN 3
        WHEN 'conspicuous_publication'  THEN 4
      END AS precedence
    FROM consent_records cr
    LEFT JOIN latest_withdrawals lw ON lw.cid = cr.contact_id
    WHERE cr.tenant_id = p_tenant_id
      AND cr.contact_id = ANY(p_contact_ids)
      AND cr.channel = p_channel
      AND cr.is_withdrawal = false
      -- Only records created after the latest withdrawal (or all if no withdrawal)
      AND cr.created_at > COALESCE(lw.withdrawal_at, '1970-01-01'::timestamptz)
      -- Type filter: when withdrawal exists, only express/pre_casl_express/conspicuous_publication
      AND (
        lw.withdrawal_at IS NULL  -- No withdrawal → all types allowed
        OR cr.consent_type IN ('express', 'pre_casl_express', 'conspicuous_publication')
      )
      -- Exclude expired implied consent (express/pre_casl/conspicuous have NULL expiry = never expires)
      AND (cr.expiry_date IS NULL OR cr.expiry_date > now())
  ),

  -- 4. Rank candidates: pick the best consent per contact
  ranked_candidates AS (
    SELECT
      pwc.*,
      ROW_NUMBER() OVER (
        PARTITION BY pwc.cid
        ORDER BY pwc.precedence ASC, pwc.rec_expiry_date DESC NULLS FIRST
      ) AS rn
    FROM post_withdrawal_candidates pwc
  )

  -- 5. Return results: join back to input_contacts so contacts with no consent get 'no_consent'
  SELECT
    ic.cid AS contact_id,
    COALESCE(rc.consent_type::text, 'no_consent') AS status,
    rc.record_id AS consent_record_id,
    rc.rec_expiry_date AS expiry_date,
    CASE
      WHEN rc.rec_expiry_date IS NOT NULL
        THEN EXTRACT(DAY FROM rc.rec_expiry_date - now())::integer
      ELSE NULL
    END AS days_until_expiry,
    CASE
      WHEN rc.consent_type = 'conspicuous_publication' THEN true
      ELSE COALESCE(false, NULL)
    END AS requires_relevance_check,
    CASE
      WHEN rc.consent_type = 'conspicuous_publication'
        THEN 'Conspicuous publication consent requires relevance verification before each send'
      WHEN rc.rec_expiry_date IS NOT NULL
        AND rc.rec_expiry_date <= now() + interval '30 days'
        THEN 'Consent expiring in ' || EXTRACT(DAY FROM rc.rec_expiry_date - now())::integer || ' days'
      ELSE NULL
    END AS warning
  FROM input_contacts ic
  LEFT JOIN ranked_candidates rc ON rc.cid = ic.cid AND rc.rn = 1;
END;
$$;

-- ============================================
-- STEP 2: insert_consent_record() RPC
-- Inserts consent records with tenant context.
-- Handles idempotency and contact-tenant validation.
-- ============================================

CREATE OR REPLACE FUNCTION insert_consent_record(
  p_tenant_id uuid,
  p_contact_id uuid,
  p_consent_type consent_type,
  p_channel message_channel,
  p_qualifying_event_type qualifying_event_type,
  p_qualifying_event text,
  p_qualifying_event_date timestamptz,
  p_expiry_date timestamptz DEFAULT NULL,
  p_contract_expiry_date timestamptz DEFAULT NULL,
  p_purpose text DEFAULT NULL,
  p_evidence_type text DEFAULT NULL,
  p_evidence_url text DEFAULT NULL,
  p_source_description text DEFAULT NULL,
  p_obtained_by text DEFAULT NULL,
  p_is_withdrawal boolean DEFAULT false,
  p_withdrawal_method text DEFAULT NULL,
  p_idempotency_key uuid DEFAULT NULL,
  p_notes text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  contact_id uuid,
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
  idempotency_key uuid,
  notes text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing_id uuid;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  -- Verify contact belongs to tenant
  IF NOT EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.id = p_contact_id AND c.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Contact not found for this tenant'
      USING ERRCODE = 'P0002'; -- no_data_found
  END IF;

  -- Idempotency check: if key provided and already exists, return existing record
  IF p_idempotency_key IS NOT NULL THEN
    SELECT cr.id INTO v_existing_id
    FROM consent_records cr
    WHERE cr.tenant_id = p_tenant_id
      AND cr.idempotency_key = p_idempotency_key;

    IF v_existing_id IS NOT NULL THEN
      RETURN QUERY
      SELECT cr.id, cr.tenant_id, cr.contact_id, cr.consent_type, cr.channel,
             cr.qualifying_event_type, cr.qualifying_event, cr.qualifying_event_date,
             cr.contract_expiry_date, cr.expiry_date, cr.purpose, cr.evidence_type,
             cr.evidence_url, cr.source_description, cr.obtained_by, cr.is_withdrawal,
             cr.withdrawal_method, cr.idempotency_key, cr.notes, cr.created_at
      FROM consent_records cr
      WHERE cr.id = v_existing_id;
      RETURN;
    END IF;
  END IF;

  -- Insert and return
  RETURN QUERY
  INSERT INTO consent_records (
    tenant_id, contact_id, consent_type, channel,
    qualifying_event_type, qualifying_event, qualifying_event_date,
    contract_expiry_date, expiry_date, purpose, evidence_type, evidence_url,
    source_description, obtained_by, is_withdrawal, withdrawal_method,
    idempotency_key, notes
  ) VALUES (
    p_tenant_id, p_contact_id, p_consent_type, p_channel,
    p_qualifying_event_type, p_qualifying_event, p_qualifying_event_date,
    p_contract_expiry_date, p_expiry_date, p_purpose, p_evidence_type, p_evidence_url,
    p_source_description, p_obtained_by, p_is_withdrawal, p_withdrawal_method,
    p_idempotency_key, p_notes
  )
  RETURNING
    consent_records.id, consent_records.tenant_id, consent_records.contact_id,
    consent_records.consent_type, consent_records.channel,
    consent_records.qualifying_event_type, consent_records.qualifying_event,
    consent_records.qualifying_event_date, consent_records.contract_expiry_date,
    consent_records.expiry_date, consent_records.purpose, consent_records.evidence_type,
    consent_records.evidence_url, consent_records.source_description,
    consent_records.obtained_by, consent_records.is_withdrawal,
    consent_records.withdrawal_method, consent_records.idempotency_key,
    consent_records.notes, consent_records.created_at;
END;
$$;

-- ============================================
-- STEP 3: API Key Hash Fix
-- Corrected HMAC hash for Maple City Motors test key.
-- Original hash from 0B was computed with a different secret value.
-- ============================================

-- API key hash was updated manually in SQL Editor to match the
-- API_KEY_HMAC_SECRET stored in Supabase Edge Function secrets.
-- Raw key: nod_live_test_maplecity_2026 (displayed once, never stored)

-- ============================================
-- STEP 4: api-consent Edge Function (deployed via CLI)
-- Location: supabase/functions/api-consent/index.ts
-- POST — Record consent (express, pre_casl_express, all types)
-- GET  — Check consent status (single contact via batch RPC)
-- Auth: HMAC-SHA-256 API key → tenant_id
-- Audit: Every consent recording creates audit_log entry
-- ============================================

-- ============================================
-- TEST RESULTS (2026-03-24)
--
-- Test A: Record express consent (email) → 201, status = 'express', no expiry ✅
-- Test B: Per-channel isolation (SMS → 'no_consent') ✅
-- Test C: Express without purpose → 400 MISSING_PURPOSE ✅
-- Test D: Cross-tenant contact → 404 CONTACT_NOT_FOUND ✅
-- Test E: pre_casl_express → 201, status = 'pre_casl_express', no expiry ✅
-- Test F: Idempotency (same key → same record ID returned) ✅
-- Test G: Future qualifying_event_date → 400 FUTURE_DATE ✅
-- Test H: Zero consent records → 'no_consent' ✅
-- Test I: Audit log entries created for all consent recordings ✅
-- Test J: Batch RPC (SQL layer verified — 3 contacts, single call) ✅
-- ============================================
