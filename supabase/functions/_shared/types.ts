// ============================================
// NOD — _shared/types.ts
// All TypeScript interfaces and enums mirroring the database schema.
// Every type used across Edge Functions lives here.
// ============================================

// ---- Enums (mirror PostgreSQL enums exactly) ----

export type ConsentType =
  | "express"
  | "pre_casl_express"
  | "implied_ebr"
  | "implied_ebr_contract"
  | "implied_inquiry"
  | "conspicuous_publication";

export type QualifyingEventType =
  | "purchase"
  | "lease"
  | "service"
  | "test_drive"
  | "inquiry"
  | "financing_contract"
  | "service_contract"
  | "lease_contract"
  | "bartering"
  | "other";

export type MessageChannel = "email" | "sms";

export type MessageClassification =
  | "cem"
  | "transactional"
  | "tier1_exempt"
  | "tier2_exempt"
  | "non_commercial";

export type ComplianceResult = "pass" | "fail" | "warning";

export type SubscriptionStatus =
  | "trialing"
  | "active"
  | "past_due"
  | "cancelled";

export type CrmSyncStatus = "pending" | "synced" | "failed";

export type AuditAction =
  | "consent_recorded"
  | "consent_evaluated"
  | "consent_withdrawn"
  | "message_classified"
  | "message_validated"
  | "proof_generated"
  | "contact_imported"
  | "unsubscribe_processed";

export type TenantRole = "admin" | "manager" | "viewer";

// ---- Table Interfaces ----

export interface Tenant {
  id: string;
  name: string;
  contact_email: string;
  contact_name: string;
  timezone: string;
  province: string;
  stripe_customer_id: string | null;
  subscription_status: SubscriptionStatus;
  subscription_expires_at: string | null;
  max_contacts: number;
  max_messages_per_month: number;
  messages_this_month: number;
  compliance_score: number | null;
  onboarded_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface TenantUser {
  id: string;
  tenant_id: string;
  auth_user_id: string;
  email: string;
  full_name: string;
  role: TenantRole;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ApiKey {
  id: string;
  tenant_id: string;
  key_hash: string;
  key_prefix: string;
  label: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface Contact {
  id: string;
  tenant_id: string;
  external_id: string | null;
  email: string | null;
  phone: string | null;
  full_name: string;
  company: string | null;
  source: string | null;
  tags: string[];
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface ConsentRecord {
  id: string;
  tenant_id: string;
  contact_id: string;
  consent_type: ConsentType;
  channel: MessageChannel;
  qualifying_event_type: QualifyingEventType;
  qualifying_event: string;
  qualifying_event_date: string;
  contract_expiry_date: string | null;
  expiry_date: string | null;
  purpose: string | null;
  evidence_type: string | null;
  evidence_url: string | null;
  source_description: string | null;
  obtained_by: string | null;
  is_withdrawal: boolean;
  withdrawal_method: string | null;
  idempotency_key: string | null;
  notes: string | null;
  created_at: string;
}

export interface MessageCheck {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel: MessageChannel;
  message_classification: MessageClassification;
  classification_reasons: string[];
  exemption_reason: string | null;
  compliance_result: ComplianceResult;
  compliance_failures: Record<string, unknown> | null;
  consent_type_used: ConsentType | null;
  consent_record_id: string | null;
  consent_expiry_at_check: string | null;
  sender_profile_id: string;
  sender_id_valid: boolean;
  unsubscribe_valid: boolean;
  message_hash: string | null;
  checked_at: string;
}

export interface UnsubscribeRequest {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel: MessageChannel;
  consent_withdrawal_id: string;
  request_date: string;
  deadline_date: string;
  crm_sync_status: CrmSyncStatus;
  crm_synced_at: string | null;
  method: string;
  created_at: string;
}

export interface ComplianceReport {
  id: string;
  tenant_id: string;
  report_type: string;
  generated_at: string;
  data: Record<string, unknown>;
  contact_id: string | null;
  file_url: string | null;
}

export interface AuditLogEntry {
  id: string;
  tenant_id: string;
  action: AuditAction;
  entity_type: string;
  entity_id: string;
  details: Record<string, unknown> | null;
  api_key_id: string | null;
  ip_address: string | null;
  created_at: string;
}

export interface SenderProfile {
  id: string;
  tenant_id: string;
  sender_name: string;
  on_behalf_of: string | null;
  mailing_address: string;
  phone: string | null;
  email: string | null;
  website_url: string | null;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProcessedWebhookEvent {
  id: string;
  stripe_event_id: string;
  event_type: string;
  processed_at: string;
}

// ---- RPC Return Types ----

export interface ConsentStatusResult {
  contact_id: string;
  status: ConsentType | "no_consent";
  consent_record_id: string | null;
  expiry_date: string | null;
  days_until_expiry: number | null;
  requires_relevance_check: boolean | null;
  warning: string | null;
}

// ---- Auth Types ----

export interface AuthResult {
  tenantId: string;
  apiKeyId: string;
  scopes: string[];
}

// ---- Standard API Error Response ----

export interface ApiError {
  error: string;
  code: string;
  details?: Record<string, unknown>;
}
