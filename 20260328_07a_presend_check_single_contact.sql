-- ============================================
-- NOD — Conversation 7A: Pre-Send Check — Single Contact Pipeline
-- Migration: insert_message_check() RPC function
-- Deployed: 2026-03-28
-- ============================================

-- ============================================
-- STEP 1: insert_message_check() RPC
-- Inserts a row into message_checks with tenant scoping.
-- Called by the api-messages Edge Function after running the
-- full pre-send pipeline (classify → consent → validate).
--
-- NOTE: sender_profile_id is stored per check to satisfy
-- CASL s.6(3): evidence of which sender identification was
-- valid at the time of sending.
-- ============================================

CREATE OR REPLACE FUNCTION insert_message_check(
  p_tenant_id uuid,
  p_contact_id uuid,
  p_channel message_channel,
  p_message_classification message_classification,
  p_classification_reasons text[],
  p_exemption_reason text DEFAULT NULL,
  p_compliance_result compliance_result DEFAULT 'fail',
  p_compliance_failures jsonb DEFAULT NULL,
  p_consent_type_used consent_type DEFAULT NULL,
  p_consent_record_id uuid DEFAULT NULL,
  p_consent_expiry_at_check timestamptz DEFAULT NULL,
  p_sender_profile_id uuid DEFAULT NULL,
  p_sender_id_valid boolean DEFAULT false,
  p_unsubscribe_valid boolean DEFAULT false,
  p_message_hash text DEFAULT NULL
)
RETURNS TABLE (
  id uuid,
  tenant_id uuid,
  contact_id uuid,
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
  -- Set tenant context (transaction-scoped)
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  -- Verify contact belongs to tenant
  IF NOT EXISTS (
    SELECT 1 FROM contacts c
    WHERE c.id = p_contact_id AND c.tenant_id = p_tenant_id
  ) THEN
    RAISE EXCEPTION 'Contact not found for this tenant'
      USING ERRCODE = 'P0002';
  END IF;

  -- Verify sender profile belongs to tenant (when provided)
  IF p_sender_profile_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM sender_profiles sp
      WHERE sp.id = p_sender_profile_id AND sp.tenant_id = p_tenant_id
    ) THEN
      RAISE EXCEPTION 'Sender profile not found for this tenant'
        USING ERRCODE = 'P0002';
    END IF;
  END IF;

  -- Insert and return
  RETURN QUERY
  INSERT INTO message_checks (
    tenant_id, contact_id, channel,
    message_classification, classification_reasons, exemption_reason,
    compliance_result, compliance_failures,
    consent_type_used, consent_record_id, consent_expiry_at_check,
    sender_profile_id, sender_id_valid, unsubscribe_valid,
    message_hash
  ) VALUES (
    p_tenant_id, p_contact_id, p_channel,
    p_message_classification, p_classification_reasons, p_exemption_reason,
    p_compliance_result, p_compliance_failures,
    p_consent_type_used, p_consent_record_id, p_consent_expiry_at_check,
    p_sender_profile_id, p_sender_id_valid, p_unsubscribe_valid,
    p_message_hash
  )
  RETURNING
    message_checks.id,
    message_checks.tenant_id,
    message_checks.contact_id,
    message_checks.channel,
    message_checks.message_classification,
    message_checks.classification_reasons,
    message_checks.exemption_reason,
    message_checks.compliance_result,
    message_checks.compliance_failures,
    message_checks.consent_type_used,
    message_checks.consent_record_id,
    message_checks.consent_expiry_at_check,
    message_checks.sender_profile_id,
    message_checks.sender_id_valid,
    message_checks.unsubscribe_valid,
    message_checks.message_hash,
    message_checks.checked_at;
END;
$$;
