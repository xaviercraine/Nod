// ============================================
// NOD — _shared/audit.ts
// Immutable audit trail INSERT helper.
// Never updates, never deletes.
// ============================================

import { getSupabaseClient } from "./supabase.ts";
import type { AuditAction } from "./types.ts";

interface AuditEntry {
  tenantId: string;
  action: AuditAction;
  entityType: string;
  entityId: string;
  details?: Record<string, unknown>;
  apiKeyId?: string;
  ipAddress?: string;
}

/**
 * Insert an immutable audit log entry.
 *
 * Uses the RPC function insert_audit_log() which sets tenant context
 * and inserts with explicit WHERE tenant_id filtering.
 *
 * Fire-and-forget by default — logs errors to console but does not
 * throw, so audit failures don't break the main request flow.
 * Set throwOnError = true if the caller needs confirmation.
 */
export async function insertAuditLog(
  entry: AuditEntry,
  throwOnError = false,
): Promise<void> {
  const supabase = getSupabaseClient();

  const { error } = await supabase.rpc("insert_audit_log", {
    p_tenant_id: entry.tenantId,
    p_action: entry.action,
    p_entity_type: entry.entityType,
    p_entity_id: entry.entityId,
    p_details: entry.details ?? null,
    p_api_key_id: entry.apiKeyId ?? null,
    p_ip_address: entry.ipAddress ?? null,
  });

  if (error) {
    console.error("Audit log insert failed:", error.message);
    if (throwOnError) {
      throw new Error(`Audit log insert failed: ${error.message}`);
    }
  }
}

/**
 * Extract client IP address from request headers.
 * Supabase Edge Functions forward the client IP via standard headers.
 */
export function getClientIp(request: Request): string | undefined {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ||
    request.headers.get("x-real-ip") ||
    undefined
  );
}
