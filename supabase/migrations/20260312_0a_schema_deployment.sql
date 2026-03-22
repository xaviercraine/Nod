-- ============================================
-- NOD — Conversation 0A: Environment + Schema Deployment
-- Complete migration: enums, tables, indexes, RLS, storage, seed data
-- Deployed: 2026-03-12
-- ============================================

-- ============================================
-- STEP 1: All Enums
-- ============================================

CREATE TYPE consent_type AS ENUM (
  'express',
  'pre_casl_express',
  'implied_ebr',
  'implied_ebr_contract',
  'implied_inquiry',
  'conspicuous_publication'
);

CREATE TYPE qualifying_event_type AS ENUM (
  'purchase',
  'lease',
  'service',
  'test_drive',
  'inquiry',
  'financing_contract',
  'service_contract',
  'lease_contract',
  'bartering',
  'other'
);

CREATE TYPE message_channel AS ENUM ('email', 'sms');

CREATE TYPE message_classification AS ENUM (
  'cem',
  'transactional',
  'tier1_exempt',
  'tier2_exempt',
  'non_commercial'
);

CREATE TYPE compliance_result AS ENUM ('pass', 'fail', 'warning');

CREATE TYPE subscription_status AS ENUM (
  'trialing',
  'active',
  'past_due',
  'cancelled'
);

CREATE TYPE crm_sync_status AS ENUM ('pending', 'synced', 'failed');

CREATE TYPE audit_action AS ENUM (
  'consent_recorded',
  'consent_evaluated',
  'consent_withdrawn',
  'message_classified',
  'message_validated',
  'proof_generated',
  'contact_imported',
  'unsubscribe_processed'
);

CREATE TYPE tenant_role AS ENUM ('admin', 'manager', 'viewer');

-- ============================================
-- STEP 2: Extensions + tenants + tenant_users
-- ============================================

CREATE EXTENSION IF NOT EXISTS moddatetime SCHEMA extensions;

-- Timezone validation (CHECK can't use subqueries)
CREATE OR REPLACE FUNCTION validate_tenant_timezone()
RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = NEW.timezone) THEN
    RAISE EXCEPTION 'Invalid timezone: %', NEW.timezone;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE tenants (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  contact_email text NOT NULL,
  contact_name  text NOT NULL,
  timezone      text NOT NULL DEFAULT 'America/Toronto',
  province      text NOT NULL DEFAULT 'ON',
  stripe_customer_id    text,
  subscription_status   subscription_status NOT NULL DEFAULT 'trialing',
  subscription_expires_at timestamptz,
  max_contacts            integer NOT NULL DEFAULT 5000,
  max_messages_per_month  integer NOT NULL DEFAULT 10000,
  messages_this_month     integer NOT NULL DEFAULT 0,
  compliance_score  integer,
  onboarded_at      timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER trg_tenants_validate_timezone
  BEFORE INSERT OR UPDATE ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION validate_tenant_timezone();

CREATE TRIGGER trg_tenants_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION extensions.moddatetime(updated_at);

CREATE TABLE tenant_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  auth_user_id  uuid NOT NULL REFERENCES auth.users(id),
  email         text NOT NULL,
  full_name     text NOT NULL,
  role          tenant_role NOT NULL DEFAULT 'viewer',
  is_active     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_tenant_users_tenant_auth UNIQUE (tenant_id, auth_user_id)
);

CREATE TRIGGER trg_tenant_users_updated_at
  BEFORE UPDATE ON tenant_users
  FOR EACH ROW
  EXECUTE FUNCTION extensions.moddatetime(updated_at);

-- ============================================
-- STEP 3: api_keys, contacts, consent_records
-- ============================================

CREATE TABLE api_keys (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  key_hash    text NOT NULL,
  key_prefix  text NOT NULL,
  label       text NOT NULL,
  scopes      text[] NOT NULL DEFAULT '{read,write}',
  last_used_at timestamptz,
  expires_at  timestamptz,
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_api_keys_hash UNIQUE (key_hash)
);

CREATE TRIGGER trg_api_keys_updated_at
  BEFORE UPDATE ON api_keys
  FOR EACH ROW
  EXECUTE FUNCTION extensions.moddatetime(updated_at);

CREATE TABLE contacts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  external_id text,
  email       text,
  phone       text,
  full_name   text NOT NULL,
  company     text,
  source      text,
  tags        text[] NOT NULL DEFAULT '{}',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_contacts_email_or_phone CHECK (
    email IS NOT NULL OR phone IS NOT NULL
  )
);

CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON contacts
  FOR EACH ROW
  EXECUTE FUNCTION extensions.moddatetime(updated_at);

CREATE UNIQUE INDEX uq_contacts_tenant_email
  ON contacts(tenant_id, email) WHERE email IS NOT NULL;

CREATE UNIQUE INDEX uq_contacts_tenant_phone
  ON contacts(tenant_id, phone) WHERE phone IS NOT NULL;

-- STRICTLY INSERT-ONLY — no UPDATE, no DELETE, no exceptions
CREATE TABLE consent_records (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             uuid NOT NULL REFERENCES tenants(id),
  contact_id            uuid NOT NULL REFERENCES contacts(id),
  consent_type          consent_type NOT NULL,
  channel               message_channel NOT NULL,
  qualifying_event_type qualifying_event_type NOT NULL,
  qualifying_event      text NOT NULL,
  qualifying_event_date timestamptz NOT NULL,
  contract_expiry_date  timestamptz,
  expiry_date           timestamptz,
  purpose               text,
  evidence_type         text,
  evidence_url          text,
  source_description    text,
  obtained_by           text,
  is_withdrawal         boolean NOT NULL DEFAULT false,
  withdrawal_method     text,
  idempotency_key       uuid,
  notes                 text,
  created_at  timestamptz NOT NULL DEFAULT now()
  -- NO updated_at — strictly INSERT-only
  -- NO CHECK constraints for conditional requirements — validated in Edge Functions
);

CREATE UNIQUE INDEX uq_consent_idempotency
  ON consent_records(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- ============================================
-- STEP 4: message_checks, unsubscribe_requests,
--         compliance_reports, audit_log
-- ============================================

CREATE TABLE message_checks (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  contact_id              uuid NOT NULL REFERENCES contacts(id),
  channel                 message_channel NOT NULL,
  message_classification  message_classification NOT NULL,
  classification_reasons  text[] NOT NULL,
  exemption_reason        text,
  compliance_result       compliance_result NOT NULL,
  compliance_failures     jsonb,
  consent_type_used       consent_type,
  consent_record_id       uuid REFERENCES consent_records(id),
  consent_expiry_at_check timestamptz,
  sender_profile_id       uuid NOT NULL,  -- FK added after sender_profiles
  sender_id_valid         boolean NOT NULL,
  unsubscribe_valid       boolean NOT NULL,
  message_hash            text,
  checked_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE unsubscribe_requests (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL REFERENCES tenants(id),
  contact_id              uuid NOT NULL REFERENCES contacts(id),
  channel                 message_channel NOT NULL,
  consent_withdrawal_id   uuid NOT NULL REFERENCES consent_records(id),
  request_date            timestamptz NOT NULL DEFAULT now(),
  deadline_date           timestamptz NOT NULL,
  crm_sync_status         crm_sync_status NOT NULL DEFAULT 'pending',
  crm_synced_at           timestamptz,
  method                  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE compliance_reports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id),
  report_type   text NOT NULL,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  data          jsonb NOT NULL,
  contact_id    uuid REFERENCES contacts(id),
  file_url      text
);

-- STRICTLY INSERT-ONLY — no UPDATE, no DELETE, no exceptions
CREATE TABLE audit_log (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id),
  action      audit_action NOT NULL,
  entity_type text NOT NULL,
  entity_id   uuid NOT NULL,
  details     jsonb,
  api_key_id  uuid REFERENCES api_keys(id),
  ip_address  text,
  created_at  timestamptz NOT NULL DEFAULT now()
  -- NO updated_at — strictly INSERT-only
);

-- ============================================
-- STEP 5: sender_profiles, processed_webhook_events, deferred FK
-- ============================================

CREATE TABLE sender_profiles (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id),
  sender_name     text NOT NULL,
  on_behalf_of    text,
  mailing_address text NOT NULL,
  phone           text,
  email           text,
  website_url     text,
  is_default      boolean NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_sender_profiles_contact_method CHECK (
    phone IS NOT NULL OR email IS NOT NULL OR website_url IS NOT NULL
  )
);

CREATE UNIQUE INDEX uq_sender_profiles_default
  ON sender_profiles(tenant_id) WHERE is_default = true;

CREATE TRIGGER trg_sender_profiles_updated_at
  BEFORE UPDATE ON sender_profiles
  FOR EACH ROW
  EXECUTE FUNCTION extensions.moddatetime(updated_at);

CREATE TABLE processed_webhook_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id text NOT NULL UNIQUE,
  event_type      text NOT NULL,
  processed_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE message_checks
  ADD CONSTRAINT fk_message_checks_sender_profile
  FOREIGN KEY (sender_profile_id) REFERENCES sender_profiles(id);

-- ============================================
-- STEP 6: All Indexes
-- ============================================

-- contacts
CREATE INDEX idx_contacts_tenant ON contacts(tenant_id);
CREATE INDEX idx_contacts_email ON contacts(tenant_id, email) WHERE email IS NOT NULL;
CREATE INDEX idx_contacts_phone ON contacts(tenant_id, phone) WHERE phone IS NOT NULL;
CREATE INDEX idx_contacts_external ON contacts(tenant_id, external_id) WHERE external_id IS NOT NULL;

-- consent_records
CREATE INDEX idx_consent_status_lookup
  ON consent_records(contact_id, channel, consent_type, is_withdrawal, created_at DESC);
CREATE INDEX idx_consent_tenant ON consent_records(tenant_id);
CREATE INDEX idx_consent_contact_timeline
  ON consent_records(tenant_id, contact_id, created_at DESC);
CREATE INDEX idx_consent_expiry_alert
  ON consent_records(tenant_id, expiry_date)
  WHERE expiry_date IS NOT NULL AND is_withdrawal = false;
CREATE INDEX idx_consent_idempotency
  ON consent_records(tenant_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- message_checks
CREATE INDEX idx_checks_tenant ON message_checks(tenant_id, checked_at DESC);
CREATE INDEX idx_checks_contact ON message_checks(contact_id);
CREATE INDEX idx_checks_sender_profile ON message_checks(sender_profile_id, checked_at DESC);

-- unsubscribe_requests
CREATE INDEX idx_unsub_pending
  ON unsubscribe_requests(crm_sync_status, deadline_date)
  WHERE crm_sync_status = 'pending';
CREATE INDEX idx_unsub_tenant ON unsubscribe_requests(tenant_id);

-- audit_log
CREATE INDEX idx_audit_tenant ON audit_log(tenant_id, created_at DESC);
CREATE INDEX idx_audit_entity ON audit_log(entity_type, entity_id);

-- api_keys
CREATE INDEX idx_api_keys_hash ON api_keys(key_hash) WHERE is_active = true;

-- processed_webhook_events
CREATE INDEX idx_webhook_events ON processed_webhook_events(stripe_event_id);

-- tenant_users
CREATE INDEX idx_tenant_users_auth ON tenant_users(auth_user_id) WHERE is_active = true;

-- ============================================
-- STEP 7: RLS Policies
-- ============================================

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE contacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE consent_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE unsubscribe_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE compliance_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE sender_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE processed_webhook_events ENABLE ROW LEVEL SECURITY;

-- tenants: standard CRUD
CREATE POLICY tenants_select ON tenants FOR SELECT
  USING (id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenants_insert ON tenants FOR INSERT
  WITH CHECK (id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenants_update ON tenants FOR UPDATE
  USING (id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenants_delete ON tenants FOR DELETE
  USING (id = current_setting('app.tenant_id', true)::uuid);

-- tenant_users: filtered by tenant_id
CREATE POLICY tenant_users_select ON tenant_users FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_users_insert ON tenant_users FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_users_update ON tenant_users FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY tenant_users_delete ON tenant_users FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- api_keys: standard CRUD
CREATE POLICY api_keys_select ON api_keys FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY api_keys_insert ON api_keys FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY api_keys_update ON api_keys FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY api_keys_delete ON api_keys FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- contacts: standard CRUD
CREATE POLICY contacts_select ON contacts FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY contacts_insert ON contacts FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY contacts_update ON contacts FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY contacts_delete ON contacts FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- consent_records: SELECT + INSERT only (immutable — no UPDATE/DELETE)
CREATE POLICY consent_records_select ON consent_records FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY consent_records_insert ON consent_records FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- message_checks: standard CRUD
CREATE POLICY message_checks_select ON message_checks FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY message_checks_insert ON message_checks FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY message_checks_update ON message_checks FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY message_checks_delete ON message_checks FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- unsubscribe_requests: standard CRUD
CREATE POLICY unsub_select ON unsubscribe_requests FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY unsub_insert ON unsubscribe_requests FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY unsub_update ON unsubscribe_requests FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY unsub_delete ON unsubscribe_requests FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- compliance_reports: standard CRUD
CREATE POLICY reports_select ON compliance_reports FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY reports_insert ON compliance_reports FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY reports_update ON compliance_reports FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY reports_delete ON compliance_reports FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- audit_log: SELECT + INSERT only (immutable — no UPDATE/DELETE)
CREATE POLICY audit_log_select ON audit_log FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY audit_log_insert ON audit_log FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- sender_profiles: standard CRUD
CREATE POLICY sender_profiles_select ON sender_profiles FOR SELECT
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY sender_profiles_insert ON sender_profiles FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY sender_profiles_update ON sender_profiles FOR UPDATE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);
CREATE POLICY sender_profiles_delete ON sender_profiles FOR DELETE
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

-- processed_webhook_events: global (no tenant_id)
CREATE POLICY webhook_events_select ON processed_webhook_events FOR SELECT
  USING (true);
CREATE POLICY webhook_events_insert ON processed_webhook_events FOR INSERT
  WITH CHECK (true);

-- ============================================
-- STEP 8: Storage Buckets + Storage RLS
-- ============================================

INSERT INTO storage.buckets (id, name, public)
VALUES
  ('consent-evidence', 'consent-evidence', false),
  ('compliance-reports', 'compliance-reports', false);

CREATE POLICY storage_consent_evidence_insert
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'consent-evidence'
    AND (storage.foldername(name))[1] = current_setting('app.tenant_id', true)
  );
CREATE POLICY storage_consent_evidence_select
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'consent-evidence'
    AND (storage.foldername(name))[1] = current_setting('app.tenant_id', true)
  );
CREATE POLICY storage_consent_evidence_delete
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'consent-evidence'
    AND (storage.foldername(name))[1] = current_setting('app.tenant_id', true)
  );

CREATE POLICY storage_compliance_reports_insert
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'compliance-reports'
    AND (storage.foldername(name))[1] = current_setting('app.tenant_id', true)
  );
CREATE POLICY storage_compliance_reports_select
  ON storage.objects FOR SELECT
  USING (
    bucket_id = 'compliance-reports'
    AND (storage.foldername(name))[1] = current_setting('app.tenant_id', true)
  );
CREATE POLICY storage_compliance_reports_delete
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'compliance-reports'
    AND (storage.foldername(name))[1] = current_setting('app.tenant_id', true)
  );

-- ============================================
-- STEP 9: Stub get_consent_status_batch()
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
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  RETURN QUERY
  SELECT
    unnest(p_contact_ids) AS contact_id,
    'no_consent'::text AS status,
    NULL::uuid AS consent_record_id,
    NULL::timestamptz AS expiry_date,
    NULL::integer AS days_until_expiry,
    NULL::boolean AS requires_relevance_check,
    NULL::text AS warning;
END;
$$;

-- ============================================
-- STEP 10: Seed Data
-- ============================================

INSERT INTO tenants (id, name, contact_email, contact_name, timezone, province, subscription_status, max_contacts, max_messages_per_month)
VALUES (
  'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
  'Maple City Motors',
  'compliance@maplecitymotors.ca',
  'Xavier Bhatt',
  'America/Toronto',
  'ON',
  'trialing',
  5000,
  10000
);

SELECT set_config('app.tenant_id', 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', false);

INSERT INTO contacts (tenant_id, full_name, email, phone, source) VALUES
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Alice Chen',       'alice.chen@example.com',    '+14165551001', 'dms_import'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Bob Martinez',     'bob.martinez@example.com',  '+14165551002', 'dms_import'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Carol Williams',   'carol.w@example.com',       '+14165551003', 'dms_import'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'David Kim',        'david.kim@example.com',     NULL,           'web_inquiry'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Eva Nguyen',       'eva.nguyen@example.com',    NULL,           'web_inquiry'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Frank Patel',      NULL,                        '+14165551006', 'walk_in'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Grace Liu',        NULL,                        '+14165551007', 'walk_in'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Hector Dubois',    'hector.d@example.com',      '+14165551008', 'referral'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'Irene Thompson',   'irene.t@example.com',       '+14165551009', 'test_drive'),
  ('a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11', 'James O''Brien',   'james.ob@example.com',      '+14165551010', 'service');
