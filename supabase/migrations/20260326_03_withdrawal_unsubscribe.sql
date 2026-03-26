-- ============================================
-- NOD — Conversation 3: Consent Withdrawal + Re-Consent After Withdrawal
-- Consolidated migration: unsubscribe RPC functions, api-unsubscribe Edge Function
-- Deployed: 2026-03-26
-- ============================================

-- ============================================
-- STEP 1: insert_unsubscribe_request() RPC
-- Inserts into unsubscribe_requests with tenant scoping.
-- Called after insert_consent_record() creates the withdrawal record.
-- Deadline calculated in TypeScript via holiday-calculator.ts and passed in.
-- ============================================

CREATE OR REPLACE FUNCTION insert_unsubscribe_request(
  p_tenant_id uuid,
  p_contact_id uuid,
  p_channel message_channel,
  p_consent_withdrawal_id uuid,
  p_request_date timestamptz,
  p_deadline_date timestamptz,
  p_method text
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  contact_id uuid,
  channel message_channel,
  consent_withdrawal_id uuid,
  request_date timestamptz,
  deadline_date timestamptz,
  crm_sync_status crm_sync_status,
  crm_synced_at timestamptz,
  method text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  -- Verify contact belongs to tenant
  IF NOT EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.id = p_contact_id AND c.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Contact not found for this tenant'
      USING ERRCODE = 'P0002';
  END IF;

  -- Verify the withdrawal consent record exists and belongs to this tenant
  IF NOT EXISTS (
    SELECT 1 FROM consent_records cr
    WHERE cr.id = p_consent_withdrawal_id
      AND cr.tenant_id = p_tenant_id
      AND cr.is_withdrawal = true
  ) THEN
    RAISE EXCEPTION 'Withdrawal consent record not found for this tenant'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  INSERT INTO unsubscribe_requests (
    tenant_id, contact_id, channel, consent_withdrawal_id,
    request_date, deadline_date, method
  ) VALUES (
    p_tenant_id, p_contact_id, p_channel, p_consent_withdrawal_id,
    p_request_date, p_deadline_date, p_method
  )
  RETURNING
    unsubscribe_requests.id,
    unsubscribe_requests.tenant_id,
    unsubscribe_requests.contact_id,
    unsubscribe_requests.channel,
    unsubscribe_requests.consent_withdrawal_id,
    unsubscribe_requests.request_date,
    unsubscribe_requests.deadline_date,
    unsubscribe_requests.crm_sync_status,
    unsubscribe_requests.crm_synced_at,
    unsubscribe_requests.method,
    unsubscribe_requests.created_at;
END;
$$;

-- ============================================
-- STEP 2: update_unsubscribe_crm_sync() RPC
-- Marks an unsubscribe request as synced with the CRM.
-- Only the owning tenant can update their own requests.
-- NOTE: Uses table alias 'ur' in UPDATE/RETURNING to avoid
-- column name ambiguity with RETURNS TABLE output columns.
-- ============================================

CREATE OR REPLACE FUNCTION update_unsubscribe_crm_sync(
  p_tenant_id uuid,
  p_unsubscribe_request_id uuid
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  contact_id uuid,
  channel message_channel,
  consent_withdrawal_id uuid,
  request_date timestamptz,
  deadline_date timestamptz,
  crm_sync_status crm_sync_status,
  crm_synced_at timestamptz,
  method text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  IF NOT EXISTS (
    SELECT 1 FROM unsubscribe_requests ur
    WHERE ur.id = p_unsubscribe_request_id
      AND ur.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Unsubscribe request not found for this tenant'
      USING ERRCODE = 'P0002';
  END IF;

  RETURN QUERY
  UPDATE unsubscribe_requests ur
  SET crm_sync_status = 'synced',
      crm_synced_at = now()
  WHERE ur.id = p_unsubscribe_request_id
    AND ur.tenant_id = p_tenant_id
  RETURNING
    ur.id,
    ur.tenant_id,
    ur.contact_id,
    ur.channel,
    ur.consent_withdrawal_id,
    ur.request_date,
    ur.deadline_date,
    ur.crm_sync_status,
    ur.crm_synced_at,
    ur.method,
    ur.created_at;
END;
$$;

-- ============================================
-- STEP 3: api-unsubscribe Edge Function (deployed via CLI)
-- Location: supabase/functions/api-unsubscribe/index.ts
-- POST /unsubscribe — Process consent withdrawal
--   - Inserts withdrawal record via insert_consent_record() (is_withdrawal = true)
--   - Calculates 10-business-day deadline via holiday-calculator.ts
--   - Inserts unsubscribe_request via insert_unsubscribe_request()
--   - Audit log entry: consent_withdrawn
-- PATCH /unsubscribe/{id}/synced — Confirm CRM sync
--   - Updates crm_sync_status to 'synced' via update_unsubscribe_crm_sync()
--   - Audit log entry: unsubscribe_processed
-- Auth: HMAC-SHA-256 API key → tenant_id
-- ============================================

-- ============================================
-- BUG FIX LOG
--
-- update_unsubscribe_crm_sync(): Initial version had ambiguous column
-- reference "id" in UPDATE...WHERE clause. PostgreSQL could not
-- distinguish between the RETURNS TABLE output column "id" and the
-- table column "unsubscribe_requests.id". Fixed by adding table alias
-- "ur" to the UPDATE statement and all RETURNING columns.
-- ============================================

-- ============================================
-- TEST RESULTS (2026-03-26)
--
-- Test A:  Express → withdrawal → status 'no_consent' ✅
-- Test B:  EBR → withdrawal → status 'no_consent' ✅
-- Test C:  Deadline: 10 business days, excludes Good Friday (Apr 3) ✅
-- Test D:  Weekends (Sat/Sun) correctly skipped in deadline ✅
-- Test E:  Post-withdrawal NEW express → status 'express' ✅ (critical re-consent test)
-- Test F:  Post-withdrawal NEW implied_ebr → status still 'no_consent' ✅ (implied cannot override)
-- Test G:  Post-withdrawal NEW pre_casl_express → status 'pre_casl_express' ✅
-- Test H:  Original withdrawal record untouched in consent_records (INSERT-only verified) ✅
-- Test I:  Email withdrawn, SMS consent still 'express' (per-channel isolation) ✅
-- Test J:  Audit log entries for all consent_withdrawn events ✅
-- Bonus:   PATCH /synced → crm_sync_status = 'synced', crm_synced_at populated ✅
-- ============================================
