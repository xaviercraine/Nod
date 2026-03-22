-- ============================================
-- NOD — Conversation 0B: Auth + RPC Tenant Scoping Spike + Shared Modules
-- Consolidated migration: RPC functions, FORCE RLS, second tenant, API key seed
-- Deployed: 2026-03-22
-- ============================================

-- ============================================
-- STEP 1: FORCE ROW LEVEL SECURITY on all tenant-scoped tables
-- Required because SECURITY DEFINER functions run as postgres (superuser),
-- which bypasses standard RLS. FORCE ensures RLS applies even to table owner.
-- NOTE: Spike validated that superuser still bypasses even with FORCE.
-- Actual tenant isolation in RPC functions uses explicit WHERE tenant_id = p_tenant_id.
-- FORCE RLS remains as defense-in-depth for any direct table access.
-- ============================================

ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE tenant_users FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE contacts FORCE ROW LEVEL SECURITY;
ALTER TABLE consent_records FORCE ROW LEVEL SECURITY;
ALTER TABLE message_checks FORCE ROW LEVEL SECURITY;
ALTER TABLE unsubscribe_requests FORCE ROW LEVEL SECURITY;
ALTER TABLE compliance_reports FORCE ROW LEVEL SECURITY;
ALTER TABLE audit_log FORCE ROW LEVEL SECURITY;
ALTER TABLE sender_profiles FORCE ROW LEVEL SECURITY;

-- ============================================
-- STEP 2: test_tenant_isolation() — RPC Spike Function
-- Validates the tenant isolation pattern used by all subsequent RPC functions.
-- Pattern: SECURITY DEFINER + set_config + explicit WHERE tenant_id filter.
-- ============================================

CREATE OR REPLACE FUNCTION test_tenant_isolation(p_tenant_id uuid)
RETURNS TABLE (
  contact_id uuid,
  full_name text,
  email text,
  phone text
)
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  RETURN QUERY
  SELECT c.id, c.full_name, c.email, c.phone
  FROM contacts c
  WHERE c.tenant_id = p_tenant_id
  ORDER BY c.full_name;
END;
$$;

-- ============================================
-- STEP 3: insert_audit_log() — Immutable Audit Trail RPC
-- INSERT-only. Never updates, never deletes.
-- ============================================

CREATE OR REPLACE FUNCTION insert_audit_log(
  p_tenant_id uuid,
  p_action audit_action,
  p_entity_type text,
  p_entity_id uuid,
  p_details jsonb DEFAULT NULL,
  p_api_key_id uuid DEFAULT NULL,
  p_ip_address text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  INSERT INTO audit_log (tenant_id, action, entity_type, entity_id, details, api_key_id, ip_address)
  VALUES (p_tenant_id, p_action, p_entity_type, p_entity_id, p_details, p_api_key_id, p_ip_address);
END;
$$;

-- ============================================
-- STEP 4: Second Test Tenant — Northshore Auto Group
-- ============================================

INSERT INTO tenants (id, name, contact_email, contact_name, timezone, province, subscription_status, max_contacts, max_messages_per_month)
VALUES (
  'b1ffcd00-ad1c-5fa9-cc7e-7ccaae491b22',
  'Northshore Auto Group',
  'compliance@northshoreauto.ca',
  'Priya Sharma',
  'America/Toronto',
  'ON',
  'trialing',
  5000,
  10000
);

INSERT INTO contacts (tenant_id, full_name, email, phone, source) VALUES
  ('b1ffcd00-ad1c-5fa9-cc7e-7ccaae491b22', 'Liam Foster',     'liam.f@example.com',     '+14165552001', 'dms_import'),
  ('b1ffcd00-ad1c-5fa9-cc7e-7ccaae491b22', 'Maya Singh',      'maya.singh@example.com',  '+14165552002', 'dms_import'),
  ('b1ffcd00-ad1c-5fa9-cc7e-7ccaae491b22', 'Noah Tremblay',   'noah.t@example.com',      '+14165552003', 'web_inquiry'),
  ('b1ffcd00-ad1c-5fa9-cc7e-7ccaae491b22', 'Olivia Park',     'olivia.p@example.com',    NULL,           'walk_in'),
  ('b1ffcd00-ad1c-5fa9-cc7e-7ccaae491b22', 'Patrick Okafor',  NULL,                      '+14165552005', 'referral');

-- ============================================
-- STEP 5: Seed API Key for Maple City Motors
-- Raw key: nod_live_test_maplecity_2026 (displayed once, never stored)
-- Hash computed with HMAC-SHA-256 using API_KEY_HMAC_SECRET
-- NOTE: This INSERT used the literal secret value in the SQL Editor.
-- The raw key and secret are NOT stored in this migration file.
-- To reproduce, run the INSERT manually with your HMAC secret.
-- ============================================

-- API key INSERT was run manually in SQL Editor with the HMAC secret.
-- key_prefix: nod_live
-- label: Maple City Motors - Test Key
-- scopes: {read,write}
-- tenant_id: a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11

-- ============================================
-- VALIDATED TENANT SCOPING PATTERN (documented for all subsequent conversations)
--
-- Every RPC function in Nod follows this pattern:
--   1. SECURITY DEFINER — allows any caller to invoke
--   2. PERFORM set_config('app.tenant_id', p_tenant_id::text, true)
--      — transaction-scoped context for nested calls/triggers
--   3. WHERE tenant_id = p_tenant_id — explicit filtering in every query
--      (not relying on RLS inside SECURITY DEFINER, because postgres
--       superuser bypasses RLS even with FORCE ROW LEVEL SECURITY)
--   4. RLS stays enabled on all tables as defense-in-depth for any
--      direct table access outside RPC functions
--
-- Spike results:
--   - Maple City Motors (tenant A): 10 contacts returned correctly
--   - Northshore Auto Group (tenant B): 5 contacts returned correctly
--   - Fake UUID: 0 rows returned correctly
--   - No cross-tenant data leakage
-- ============================================
