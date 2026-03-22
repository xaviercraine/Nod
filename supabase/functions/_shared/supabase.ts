// ============================================
// NOD — _shared/supabase.ts
// Supabase client initialization for Edge Functions.
// Creates the client with the service role key.
// ============================================

import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

let _client: SupabaseClient | null = null;

/**
 * Returns a Supabase client initialized with the service role key.
 *
 * The service role key bypasses RLS, which is correct for Edge Functions
 * because tenant isolation is enforced via RPC functions with explicit
 * WHERE tenant_id = p_tenant_id filters (validated in 0B spike).
 *
 * The client is created once and reused for the lifetime of the
 * Edge Function invocation (Deno isolate).
 */
export function getSupabaseClient(): SupabaseClient {
  if (_client) return _client;

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !supabaseServiceKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  _client = createClient(supabaseUrl, supabaseServiceKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });

  return _client;
}
