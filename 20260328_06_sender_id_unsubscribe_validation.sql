-- ============================================
-- NOD — Conversation 6: Sender Identification + Unsubscribe Validation
-- Consolidated migration: sender profile CRUD RPCs,
-- _shared/validator.ts, api-sender-profiles + api-messages-validate Edge Functions
-- Deployed: 2026-03-28
-- ============================================

-- ============================================
-- STEP 1: create_sender_profile() RPC
-- Creates a new sender profile for a tenant.
-- If is_default = true, unsets any existing default first.
-- ============================================

CREATE OR REPLACE FUNCTION create_sender_profile(
  p_tenant_id uuid,
  p_sender_name text,
  p_mailing_address text,
  p_on_behalf_of text DEFAULT NULL,
  p_phone text DEFAULT NULL,
  p_email text DEFAULT NULL,
  p_website_url text DEFAULT NULL,
  p_is_default boolean DEFAULT false
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  sender_name text,
  on_behalf_of text,
  mailing_address text,
  phone text,
  email text,
  website_url text,
  is_default boolean,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  IF p_phone IS NULL AND p_email IS NULL AND p_website_url IS NULL THEN
    RAISE EXCEPTION 'At least one contact method (phone, email, or website_url) is required'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_is_default THEN
    UPDATE sender_profiles sp
    SET is_default = false
    WHERE sp.tenant_id = p_tenant_id
      AND sp.is_default = true;
  END IF;

  RETURN QUERY
  INSERT INTO sender_profiles (
    tenant_id, sender_name, on_behalf_of, mailing_address,
    phone, email, website_url, is_default
  ) VALUES (
    p_tenant_id, p_sender_name, p_on_behalf_of, p_mailing_address,
    p_phone, p_email, p_website_url, p_is_default
  )
  RETURNING
    sender_profiles.id,
    sender_profiles.tenant_id,
    sender_profiles.sender_name,
    sender_profiles.on_behalf_of,
    sender_profiles.mailing_address,
    sender_profiles.phone,
    sender_profiles.email,
    sender_profiles.website_url,
    sender_profiles.is_default,
    sender_profiles.created_at,
    sender_profiles.updated_at;
END;
$$;

-- ============================================
-- STEP 2: get_sender_profiles() RPC
-- Lists all sender profiles for a tenant.
-- ============================================

CREATE OR REPLACE FUNCTION get_sender_profiles(
  p_tenant_id uuid
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  sender_name text,
  on_behalf_of text,
  mailing_address text,
  phone text,
  email text,
  website_url text,
  is_default boolean,
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
    sp.id, sp.tenant_id, sp.sender_name, sp.on_behalf_of,
    sp.mailing_address, sp.phone, sp.email, sp.website_url,
    sp.is_default, sp.created_at, sp.updated_at
  FROM sender_profiles sp
  WHERE sp.tenant_id = p_tenant_id
  ORDER BY sp.is_default DESC, sp.created_at ASC;
END;
$$;

-- ============================================
-- STEP 3: get_sender_profile_by_id() RPC
-- Single profile lookup by ID + tenant.
-- Used by api-messages-validate to look up the profile.
-- ============================================

CREATE OR REPLACE FUNCTION get_sender_profile_by_id(
  p_tenant_id uuid,
  p_profile_id uuid
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  sender_name text,
  on_behalf_of text,
  mailing_address text,
  phone text,
  email text,
  website_url text,
  is_default boolean,
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
    sp.id, sp.tenant_id, sp.sender_name, sp.on_behalf_of,
    sp.mailing_address, sp.phone, sp.email, sp.website_url,
    sp.is_default, sp.created_at, sp.updated_at
  FROM sender_profiles sp
  WHERE sp.id = p_profile_id
    AND sp.tenant_id = p_tenant_id;
END;
$$;

-- ============================================
-- STEP 4: update_sender_profile() RPC
-- Partial update. '__UNCHANGED__' sentinel for nullable fields
-- distinguishes "don't change" from "set to NULL".
-- ============================================

CREATE OR REPLACE FUNCTION update_sender_profile(
  p_tenant_id uuid,
  p_profile_id uuid,
  p_sender_name text DEFAULT NULL,
  p_on_behalf_of text DEFAULT '__UNCHANGED__',
  p_mailing_address text DEFAULT NULL,
  p_phone text DEFAULT '__UNCHANGED__',
  p_email text DEFAULT '__UNCHANGED__',
  p_website_url text DEFAULT '__UNCHANGED__',
  p_is_default boolean DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  sender_name text,
  on_behalf_of text,
  mailing_address text,
  phone text,
  email text,
  website_url text,
  is_default boolean,
  created_at timestamptz,
  updated_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_existing RECORD;
  v_new_phone text;
  v_new_email text;
  v_new_website_url text;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  SELECT sp.* INTO v_existing
  FROM sender_profiles sp
  WHERE sp.id = p_profile_id
    AND sp.tenant_id = p_tenant_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Sender profile not found for this tenant'
      USING ERRCODE = 'P0002';
  END IF;

  v_new_phone := CASE WHEN p_phone = '__UNCHANGED__' THEN v_existing.phone ELSE p_phone END;
  v_new_email := CASE WHEN p_email = '__UNCHANGED__' THEN v_existing.email ELSE p_email END;
  v_new_website_url := CASE WHEN p_website_url = '__UNCHANGED__' THEN v_existing.website_url ELSE p_website_url END;

  IF v_new_phone IS NULL AND v_new_email IS NULL AND v_new_website_url IS NULL THEN
    RAISE EXCEPTION 'At least one contact method (phone, email, or website_url) is required'
      USING ERRCODE = 'P0001';
  END IF;

  IF p_is_default IS NOT NULL AND p_is_default THEN
    UPDATE sender_profiles sp2
    SET is_default = false
    WHERE sp2.tenant_id = p_tenant_id
      AND sp2.is_default = true
      AND sp2.id != p_profile_id;
  END IF;

  RETURN QUERY
  UPDATE sender_profiles sp
  SET
    sender_name = COALESCE(p_sender_name, sp.sender_name),
    on_behalf_of = CASE WHEN p_on_behalf_of = '__UNCHANGED__' THEN sp.on_behalf_of ELSE p_on_behalf_of END,
    mailing_address = COALESCE(p_mailing_address, sp.mailing_address),
    phone = v_new_phone,
    email = v_new_email,
    website_url = v_new_website_url,
    is_default = COALESCE(p_is_default, sp.is_default)
  WHERE sp.id = p_profile_id
    AND sp.tenant_id = p_tenant_id
  RETURNING
    sp.id, sp.tenant_id, sp.sender_name, sp.on_behalf_of,
    sp.mailing_address, sp.phone, sp.email, sp.website_url,
    sp.is_default, sp.created_at, sp.updated_at;
END;
$$;

-- ============================================
-- STEP 5: delete_sender_profile() RPC
-- Hard delete with 60-day message_checks protection [CASL s.6(3)].
-- Uses idx_checks_sender_profile (deployed in 0A).
-- ============================================

CREATE OR REPLACE FUNCTION delete_sender_profile(
  p_tenant_id uuid,
  p_profile_id uuid
)
RETURNS TABLE (
  deleted boolean,
  profile_id uuid
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  IF NOT EXISTS (
    SELECT 1 FROM sender_profiles sp
    WHERE sp.id = p_profile_id
      AND sp.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Sender profile not found for this tenant'
      USING ERRCODE = 'P0002';
  END IF;

  IF EXISTS (
    SELECT 1 FROM message_checks mc
    WHERE mc.sender_profile_id = p_profile_id
      AND mc.tenant_id = p_tenant_id
      AND mc.checked_at > now() - interval '60 days'
  ) THEN
    RAISE EXCEPTION 'Cannot delete sender profile: referenced by message checks within the last 60 days [CASL s.6(3)]'
      USING ERRCODE = 'P0003';
  END IF;

  DELETE FROM sender_profiles sp
  WHERE sp.id = p_profile_id
    AND sp.tenant_id = p_tenant_id;

  RETURN QUERY SELECT true AS deleted, p_profile_id AS profile_id;
END;
$$;

-- ============================================
-- STEP 6: TypeScript — _shared/validator.ts (deployed via CLI)
-- Location: supabase/functions/_shared/validator.ts
-- Pure validation logic, no database calls:
--   validateSenderId(profile) — CASL s.6(2): name, address, contact method, on_behalf_of
--   validateUnsubscribe(url) — CASL s.11: mechanism presence
--   validateCompliance(input) — orchestrator: classification-aware validation
-- CEM + tier2_exempt: requires sender ID + unsubscribe
-- tier1_exempt / transactional / non_commercial: no requirements → pass
-- ============================================

-- ============================================
-- STEP 7: api-sender-profiles Edge Function (deployed via CLI)
-- Location: supabase/functions/api-sender-profiles/index.ts
-- POST   /sender-profiles        — Create sender profile
-- GET    /sender-profiles        — List all profiles for tenant
-- GET    /sender-profiles/{id}   — Get single profile
-- PATCH  /sender-profiles/{id}   — Update profile (partial, __UNCHANGED__ sentinel)
-- DELETE /sender-profiles/{id}   — Delete with 60-day protection
-- Auth: HMAC-SHA-256 API key → tenant_id
-- Path parsing: segment-based UUID extraction (proven pattern from api-unsubscribe)
-- ============================================

-- ============================================
-- STEP 8: api-messages-validate Edge Function (deployed via CLI)
-- Location: supabase/functions/api-messages-validate/index.ts
-- POST /messages/validate
--   - Accepts { sender_profile_id, unsubscribe_url?, classification }
--   - Looks up sender_profiles by ID + tenant_id via get_sender_profile_by_id RPC
--   - Validates sender ID fields via validateSenderId()
--   - Validates unsubscribe mechanism via validateUnsubscribe() (if required)
--   - Returns { sender_id_valid, unsubscribe_valid, compliance_result, failures[] }
--   - Audit log entry: message_validated
-- ============================================

-- ============================================
-- BUG FIX LOG
--
-- api-sender-profiles/index.ts: Initial version used regex matching
-- on /sender-profiles/{uuid} in the full pathname, which failed because
-- Supabase Edge Function paths include /functions/v1/api-sender-profiles/
-- prefix. Fixed by switching to segment-based UUID extraction (split on /,
-- check last segment for UUID pattern) — same proven pattern used in
-- api-unsubscribe/index.ts from Conv 3.
-- ============================================

-- ============================================
-- TEST RESULTS (2026-03-28)
--
-- Test A: Complete sender ID + unsubscribe URL (CEM) → compliance_result 'pass' ✅
-- Test B: Missing mailing_address → 400 MISSING_FIELD (blocked at CRUD layer) ✅
-- Test C: No unsubscribe URL for CEM → compliance_result 'fail', unsubscribe_missing ✅
-- Test D: Tier 2 exempt: sender ID + unsubscribe required → 'pass' ✅
-- Test E: Tier 1 exempt: no requirements → 'pass' ✅
-- Test F: on_behalf_of set: both identities validated → 'pass' ✅
-- Test G: Delete profile with message_check <60 days → 409 DELETE_PROTECTED ✅
--
-- Additional CRUD tests passed during development:
-- CREATE: sender profile with all fields + is_default management ✅
-- LIST: returns all profiles for tenant, default first ✅
-- GET by ID: single profile lookup, 404 on missing ✅
-- PATCH: partial update with on_behalf_of, __UNCHANGED__ sentinel ✅
-- DELETE: hard delete succeeds when no recent message_checks ✅
-- is_default: creating new default unsets previous default ✅
-- ============================================
