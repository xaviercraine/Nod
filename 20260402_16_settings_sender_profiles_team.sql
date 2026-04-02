-- ============================================
-- NOD — Conversation 16: Settings, Sender Profiles + Team Management
-- Migration: Team management RPCs
-- Deployed: 2026-04-02
-- ============================================

-- ============================================
-- STEP 1A: get_tenant_users()
-- Returns all tenant_users for a tenant with auth email.
-- ============================================

CREATE OR REPLACE FUNCTION get_tenant_users(
  p_tenant_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_rows JSON;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  SELECT COALESCE(json_agg(row_order), '[]'::json)
  INTO v_rows
  FROM (
    SELECT
      tu.id,
      tu.auth_user_id,
      tu.full_name,
      tu.role,
      tu.is_active,
      tu.created_at,
      au.email
    FROM tenant_users tu
    LEFT JOIN auth.users au ON au.id = tu.auth_user_id
    WHERE tu.tenant_id = p_tenant_id
    ORDER BY tu.created_at ASC
  ) row_order;

  RETURN v_rows;
END;
$$;

-- ============================================
-- STEP 1B: invite_tenant_user()
-- Creates a new tenant_user record.
-- Looks up auth_user_id from auth.users by email.
-- Returns error if email not found or already in tenant.
-- ============================================

CREATE OR REPLACE FUNCTION invite_tenant_user(
  p_tenant_id UUID,
  p_email TEXT,
  p_full_name TEXT,
  p_role TEXT DEFAULT 'viewer'
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_auth_user_id UUID;
  v_existing_id UUID;
  v_new_row tenant_users%ROWTYPE;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  SELECT id INTO v_auth_user_id
  FROM auth.users
  WHERE auth.users.email = p_email;

  IF v_auth_user_id IS NULL THEN
    RETURN json_build_object(
      'success', false,
      'error', 'No account found for this email. The user must sign up first.'
    );
  END IF;

  SELECT id INTO v_existing_id
  FROM tenant_users
  WHERE tenant_id = p_tenant_id
    AND auth_user_id = v_auth_user_id;

  IF v_existing_id IS NOT NULL THEN
    RETURN json_build_object(
      'success', false,
      'error', 'This user is already a member of your team.'
    );
  END IF;

  INSERT INTO tenant_users (tenant_id, auth_user_id, full_name, role, is_active)
  VALUES (p_tenant_id, v_auth_user_id, p_full_name, p_role::user_role, true)
  RETURNING * INTO v_new_row;

  RETURN json_build_object(
    'success', true,
    'user', json_build_object(
      'id', v_new_row.id,
      'auth_user_id', v_new_row.auth_user_id,
      'full_name', v_new_row.full_name,
      'role', v_new_row.role,
      'is_active', v_new_row.is_active,
      'created_at', v_new_row.created_at,
      'email', p_email
    )
  );
END;
$$;

-- ============================================
-- STEP 1C: update_tenant_user_role()
-- ============================================

CREATE OR REPLACE FUNCTION update_tenant_user_role(
  p_tenant_id UUID,
  p_user_id UUID,
  p_role TEXT
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated_row tenant_users%ROWTYPE;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  UPDATE tenant_users
  SET role = p_role::user_role,
      updated_at = NOW()
  WHERE id = p_user_id
    AND tenant_id = p_tenant_id
  RETURNING * INTO v_updated_row;

  IF v_updated_row.id IS NULL THEN
    RETURN json_build_object(
      'success', false,
      'error', 'User not found in this tenant.'
    );
  END IF;

  RETURN json_build_object(
    'success', true,
    'user', json_build_object(
      'id', v_updated_row.id,
      'role', v_updated_row.role
    )
  );
END;
$$;

-- ============================================
-- STEP 1D: remove_tenant_user()
-- Soft-delete: sets is_active = false.
-- ============================================

CREATE OR REPLACE FUNCTION remove_tenant_user(
  p_tenant_id UUID,
  p_user_id UUID
)
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_updated_row tenant_users%ROWTYPE;
BEGIN
  PERFORM set_config('app.tenant_id', p_tenant_id::text, true);

  UPDATE tenant_users
  SET is_active = false,
      updated_at = NOW()
  WHERE id = p_user_id
    AND tenant_id = p_tenant_id
  RETURNING * INTO v_updated_row;

  IF v_updated_row.id IS NULL THEN
    RETURN json_build_object(
      'success', false,
      'error', 'User not found in this tenant.'
    );
  END IF;

  RETURN json_build_object(
    'success', true
  );
END;
$$;

-- ============================================
-- FRONTEND (Lovable dashboard — no SQL)
--
-- src/hooks/useSenderProfiles.ts
--   Fetches get_sender_profiles + create/update/delete RPCs.
--   Uses __UNCHANGED__ sentinel for nullable fields on update.
--   Required fields (sender_name, mailing_address) always send current value.
--
-- src/hooks/useTeamMembers.ts
--   Fetches get_tenant_users RPC (RETURNS JSON — no array unwrap needed).
--   invite/updateRole/removeMember call respective RPCs.
--   Results parsed as {success, error?, user?} JSON objects.
--
-- src/pages/SenderProfiles.tsx
--   /settings/sender-profiles — Full CRUD:
--   Card grid with default profile highlighted (border-primary).
--   Add/Edit dialog: sender_name, on_behalf_of, mailing_address,
--   phone, email, website_url, is_default. CASL s.6(2)(c) validation
--   (at least one contact method required).
--   Delete with confirmation dialog, 60-day protection error toast.
--
-- src/pages/Subscription.tsx
--   /settings/subscription — Read-only tenant details:
--   Plan tier derived from max_contacts/max_messages_per_month.
--   Status badge (trialing/active/past_due/canceled).
--   Messages usage progress bar. Contact limit display.
--   Dealership info: name, email, province, timezone.
--
-- src/pages/TeamManagement.tsx
--   /settings/team — Team member management:
--   Table with name, email, role, status, actions.
--   Invite dialog (email lookup, must have existing auth account).
--   Role dropdown (admin only, cannot change own role).
--   Remove with confirmation (admin only, cannot remove self).
--   Soft-delete sets is_active = false.
--
-- AuthContext.tsx updated: TenantInfo type extended with optional fields
--   contact_email, province, timezone, messages_this_month,
--   max_messages_per_month, max_contacts, subscription_status.
--
-- AppSidebar updated: "Settings" section with Sender Profiles,
--   Subscription, Team sub-items.
-- App.tsx updated: /settings/sender-profiles, /settings/subscription,
--   /settings/team routes.
-- ============================================

-- ============================================
-- BUG FIX LOG
--
-- useSenderProfiles.ts v1: Used __UNCHANGED__ sentinel for p_sender_name
-- and p_mailing_address on update. These are required fields in the RPC —
-- sentinel was stored literally as the mailing address value.
-- Fixed in v2: required fields always send current form value.
--
-- useTeamMembers.ts v1: TypeScript type cast errors on RPC result parsing.
-- Supabase JS returns unknown types from .rpc(). Fixed by adding
-- intermediate `unknown` casts before final type assertion.
--
-- Subscription.tsx: TenantInfo type in AuthContext was missing optional
-- fields (contact_email, province, timezone, messages_this_month,
-- max_messages_per_month, max_contacts, subscription_status).
-- Fixed by extending the TenantInfo interface.
-- ============================================

-- ============================================
-- TEST RESULTS (2026-04-02)
--
-- Test A: Sender profiles list loads. Default profile (Maple City Motors)
--         highlighted with border + badge. Second test profile visible. ✅
-- Test B: Created "Service Department" profile via Add Profile dialog.
--         Appeared in list after save. ✅
-- Test C: Edited "Service Department" → "Service Dept", added phone.
--         Changes reflected. Required field bug found + fixed. ✅
-- Test D: Deleted "Service Dept" profile. Card removed from list.
--         (No 60-day protection triggered — no message_checks.) ✅
-- Test E: Subscription page shows Enterprise plan, trialing status,
--         0/10,000 messages, 5,000 contact limit, Maple City Motors. ✅
-- Test F: Team page shows 1 active member (current user) as admin
--         with "(you)" tag. Invite User button visible. ✅
-- Test G: Sidebar shows Settings section with Sender Profiles,
--         Subscription, Team sub-items. All routes work. ✅
-- ============================================
