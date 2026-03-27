-- ============================================
-- NOD — Conversation 4: Batch Contact Import + Consent Classification
-- Consolidated migration: batch_import_contacts, batch_insert_consent_records,
-- get_contacts_paginated RPCs, api-contacts Edge Function
-- Deployed: 2026-03-27
-- ============================================

-- ============================================
-- STEP 1: batch_import_contacts() RPC
-- Batch INSERT contacts with dual-index dedup (email + phone per tenant),
-- within-batch dedup via parallel arrays, and max_contacts enforcement.
-- Returns contact_id, is_new flag, and input_index for caller mapping.
-- ============================================

CREATE OR REPLACE FUNCTION batch_import_contacts(
  p_tenant_id uuid,
  p_contacts jsonb
)
RETURNS TABLE (
  contact_id uuid,
  is_new boolean,
  input_index integer
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_current_count integer;
  v_max_contacts integer;
  v_new_count integer := 0;
  v_idx integer;
  v_contact jsonb;
  v_email text;
  v_phone text;
  v_existing_id uuid;
  v_new_id uuid;
  v_pos integer;
  v_batch_emails text[] := '{}';
  v_batch_email_ids uuid[] := '{}';
  v_batch_phones text[] := '{}';
  v_batch_phone_ids uuid[] := '{}';
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  SELECT COUNT(*)::integer INTO v_current_count
  FROM contacts c
  WHERE c.tenant_id = p_tenant_id;

  SELECT t.max_contacts INTO v_max_contacts
  FROM tenants t
  WHERE t.id = p_tenant_id;

  IF v_max_contacts IS NULL THEN
    RAISE EXCEPTION 'Tenant not found'
      USING ERRCODE = 'P0002';
  END IF;

  FOR v_idx IN 0..jsonb_array_length(p_contacts) - 1
  LOOP
    v_contact := p_contacts->v_idx;
    v_existing_id := NULL;
    v_email := v_contact->>'email';
    v_phone := v_contact->>'phone';

    IF v_email IS NOT NULL THEN
      SELECT c.id INTO v_existing_id
      FROM contacts c
      WHERE c.tenant_id = p_tenant_id AND c.email = v_email;
    END IF;

    IF v_existing_id IS NULL AND v_phone IS NOT NULL THEN
      SELECT c.id INTO v_existing_id
      FROM contacts c
      WHERE c.tenant_id = p_tenant_id AND c.phone = v_phone;
    END IF;

    IF v_existing_id IS NULL AND v_email IS NOT NULL THEN
      v_pos := array_position(v_batch_emails, v_email);
      IF v_pos IS NOT NULL THEN
        v_existing_id := v_batch_email_ids[v_pos];
      END IF;
    END IF;

    IF v_existing_id IS NULL AND v_phone IS NOT NULL THEN
      v_pos := array_position(v_batch_phones, v_phone);
      IF v_pos IS NOT NULL THEN
        v_existing_id := v_batch_phone_ids[v_pos];
      END IF;
    END IF;

    IF v_existing_id IS NOT NULL THEN
      contact_id := v_existing_id;
      is_new := false;
      input_index := v_idx;
      RETURN NEXT;
    ELSE
      INSERT INTO contacts (
        tenant_id, full_name, email, phone,
        external_id, company, source, tags
      )
      VALUES (
        p_tenant_id,
        v_contact->>'full_name',
        v_email,
        v_phone,
        v_contact->>'external_id',
        v_contact->>'company',
        COALESCE(v_contact->>'source', 'dms_import'),
        COALESCE(
          CASE
            WHEN jsonb_exists(v_contact, 'tags') AND jsonb_typeof(v_contact->'tags') = 'array'
            THEN (SELECT array_agg(elem) FROM jsonb_array_elements_text(v_contact->'tags') AS t(elem))
            ELSE '{}'::text[]
          END,
          '{}'::text[]
        )
      )
      RETURNING contacts.id INTO v_new_id;

      IF v_email IS NOT NULL THEN
        v_batch_emails := array_append(v_batch_emails, v_email);
        v_batch_email_ids := array_append(v_batch_email_ids, v_new_id);
      END IF;
      IF v_phone IS NOT NULL THEN
        v_batch_phones := array_append(v_batch_phones, v_phone);
        v_batch_phone_ids := array_append(v_batch_phone_ids, v_new_id);
      END IF;

      v_new_count := v_new_count + 1;

      contact_id := v_new_id;
      is_new := true;
      input_index := v_idx;
      RETURN NEXT;
    END IF;
  END LOOP;

  IF v_current_count + v_new_count > v_max_contacts THEN
    RAISE EXCEPTION 'Batch would exceed max_contacts limit (current: %, new: %, max: %)',
      v_current_count, v_new_count, v_max_contacts
      USING ERRCODE = 'P0003';
  END IF;
END;
$$;

-- ============================================
-- STEP 2: batch_insert_consent_records() RPC
-- Batch INSERT consent records for imported contacts.
-- Validates each contact belongs to the tenant.
-- Returns consent_record_id + input_index for caller mapping.
-- ============================================

CREATE OR REPLACE FUNCTION batch_insert_consent_records(
  p_tenant_id uuid,
  p_records jsonb
)
RETURNS TABLE (
  consent_record_id uuid,
  input_index integer
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_idx integer;
  v_rec jsonb;
  v_contact_id uuid;
  v_new_id uuid;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  FOR v_idx IN 0..jsonb_array_length(p_records) - 1
  LOOP
    v_rec := p_records->v_idx;
    v_contact_id := (v_rec->>'contact_id')::uuid;

    IF NOT EXISTS (
      SELECT 1 FROM contacts c
      WHERE c.id = v_contact_id AND c.tenant_id = p_tenant_id
    ) THEN
      RAISE EXCEPTION 'Contact % not found for this tenant', v_contact_id
        USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO consent_records (
      tenant_id, contact_id, consent_type, channel,
      qualifying_event_type, qualifying_event, qualifying_event_date,
      contract_expiry_date, expiry_date, purpose, evidence_type,
      evidence_url, source_description, obtained_by,
      is_withdrawal, notes
    )
    VALUES (
      p_tenant_id,
      v_contact_id,
      (v_rec->>'consent_type')::consent_type,
      (v_rec->>'channel')::message_channel,
      (v_rec->>'qualifying_event_type')::qualifying_event_type,
      v_rec->>'qualifying_event',
      (v_rec->>'qualifying_event_date')::timestamptz,
      (v_rec->>'contract_expiry_date')::timestamptz,
      (v_rec->>'expiry_date')::timestamptz,
      v_rec->>'purpose',
      v_rec->>'evidence_type',
      v_rec->>'evidence_url',
      v_rec->>'source_description',
      v_rec->>'obtained_by',
      false,
      v_rec->>'notes'
    )
    RETURNING consent_records.id INTO v_new_id;

    consent_record_id := v_new_id;
    input_index := v_idx;
    RETURN NEXT;
  END LOOP;
END;
$$;

-- ============================================
-- STEP 3: get_contacts_paginated() RPC
-- Paginated contact list with case-insensitive search across
-- full_name, email, phone. Returns total_count via window function.
-- Consent status filtering happens in the Edge Function layer.
-- ============================================

CREATE OR REPLACE FUNCTION get_contacts_paginated(
  p_tenant_id uuid,
  p_limit integer DEFAULT 50,
  p_offset integer DEFAULT 0,
  p_search text DEFAULT NULL
)
RETURNS TABLE (
  contact_id uuid,
  external_id text,
  full_name text,
  email text,
  phone text,
  company text,
  source text,
  tags text[],
  is_active boolean,
  created_at timestamptz,
  updated_at timestamptz,
  total_count bigint
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_search_pattern text;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  IF p_search IS NOT NULL AND p_search <> '' THEN
    v_search_pattern := '%' || lower(p_search) || '%';
  END IF;

  RETURN QUERY
  SELECT
    c.id AS contact_id,
    c.external_id,
    c.full_name,
    c.email,
    c.phone,
    c.company,
    c.source,
    c.tags,
    c.is_active,
    c.created_at,
    c.updated_at,
    COUNT(*) OVER () AS total_count
  FROM contacts c
  WHERE c.tenant_id = p_tenant_id
    AND (
      v_search_pattern IS NULL
      OR lower(c.full_name) LIKE v_search_pattern
      OR lower(c.email) LIKE v_search_pattern
      OR c.phone LIKE v_search_pattern
    )
  ORDER BY c.full_name ASC
  LIMIT p_limit
  OFFSET p_offset;
END;
$$;

-- ============================================
-- STEP 4: api-contacts Edge Function (deployed via CLI)
-- Location: supabase/functions/api-contacts/index.ts
-- POST /contacts/import — Batch import with consent classification
--   - Authenticates via auth.ts (HMAC-SHA-256 API key → tenant_id)
--   - Validates email format, phone E.164, batch size <= 500
--   - Batch INSERT contacts via batch_import_contacts() RPC
--   - Classifies DMS consent data:
--     purchase_date → implied_ebr (expiry = event + 2yr)
--     inquiry_date → implied_inquiry (expiry = event + 6mo)
--     financing_contract_start + end → implied_ebr_contract (expiry = contract_end + 2yr)
--     express_consent_date + purpose → express (no expiry)
--   - Batch INSERT consent records via batch_insert_consent_records() RPC
--   - NO messages_this_month increment (import is not sending)
--   - Audit log entry: contact_imported
-- GET /contacts — Paginated list with search + consent status filter
--   - Authenticates via auth.ts
--   - Pagination: limit (max 200) + offset
--   - Search: case-insensitive partial match on full_name, email, phone
--   - Consent status filter via get_consent_status_batch() (single RPC, no N+1)
-- Auth: HMAC-SHA-256 API key → tenant_id
-- ============================================

-- ============================================
-- BUG FIX LOG
--
-- batch_import_contacts(): Initial version used JSONB `?` operator for
-- tags key check. Supabase SQL Editor interprets `?` as a prepared
-- statement placeholder, causing silent CREATE FUNCTION failure.
-- Fixed by replacing with jsonb_exists() function.
--
-- batch_import_contacts(): When tags array was empty ([]), 
-- jsonb_array_elements_text returned zero rows, causing array_agg
-- to return NULL. contacts.tags has NOT NULL constraint (default '{}').
-- Fixed by wrapping the CASE expression in COALESCE(..., '{}'::text[]).
-- ============================================

-- ============================================
-- TEST RESULTS (2026-03-27)
--
-- Test A: Import 50 contacts with purchase dates → 50 new + 50 EBR records ✅
-- Test B: Re-import same 50 → 0 new, 50 duplicates (dedup by email/phone) ✅
-- Test C: Import with purchase_date >2yr ago → record created, status 'no_consent' (expired) ✅
-- Test D: Import with financing contract → implied_ebr_contract, expiry = contract_end + 2yr ✅
-- Test E: Batch exceeding max_contacts → 400 MAX_CONTACTS_EXCEEDED, nothing imported ✅
-- Test F: GET /contacts?consent_status=no_consent → filter works correctly ✅
-- Test G: Import with no consent data → contacts created, 0 consent records ✅
-- ============================================
