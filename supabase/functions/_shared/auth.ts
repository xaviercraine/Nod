// ============================================
// NOD — _shared/auth.ts
// API key validation via HMAC-SHA-256.
// Extracts key from Authorization header, hashes it, looks up api_keys,
// resolves tenant_id. Does NOT set session variables — passes tenant_id
// to RPC functions.
// ============================================

import { getSupabaseClient } from "./supabase.ts";
import type { AuthResult } from "./types.ts";

/**
 * Compute HMAC-SHA-256 hash of the raw API key using the server secret.
 * Returns the hash as a lowercase hex string.
 */
async function hmacHash(key: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();

  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );

  const signature = await crypto.subtle.sign(
    "HMAC",
    cryptoKey,
    encoder.encode(key),
  );

  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Authenticate an incoming request via API key.
 *
 * Flow:
 * 1. Extract API key from Authorization: Bearer nod_live_... header
 * 2. Hash with HMAC-SHA-256 using API_KEY_HMAC_SECRET
 * 3. Look up api_keys by key_hash WHERE is_active = true
 * 4. Check expires_at (if set, must be in the future)
 * 5. Resolve tenant_id
 * 6. Update last_used_at on the api_key
 * 7. Return { tenantId, apiKeyId, scopes }
 *
 * Returns null on any failure — caller should return 401.
 */
export async function authenticateRequest(
  request: Request,
): Promise<AuthResult | null> {
  // Step 1: Extract API key from Authorization header
  const authHeader = request.headers.get("authorization");
  if (!authHeader) return null;

  const parts = authHeader.split(" ");
  if (parts.length !== 2 || parts[0].toLowerCase() !== "bearer") return null;

  const rawKey = parts[1];
  if (!rawKey || !rawKey.startsWith("nod_")) return null;

  // Step 2: Hash with HMAC-SHA-256
  const hmacSecret = Deno.env.get("API_KEY_HMAC_SECRET");
  if (!hmacSecret) {
    console.error("API_KEY_HMAC_SECRET is not configured");
    return null;
  }

  const keyHash = await hmacHash(rawKey, hmacSecret);

  // Step 3: Look up api_keys by key_hash (service role bypasses RLS)
  const supabase = getSupabaseClient();

  const { data: apiKey, error } = await supabase
    .from("api_keys")
    .select("id, tenant_id, scopes, expires_at, is_active")
    .eq("key_hash", keyHash)
    .eq("is_active", true)
    .single();

  if (error || !apiKey) return null;

  // Step 4: Check expiry (if set, must be in the future)
  if (apiKey.expires_at) {
    const expiresAt = new Date(apiKey.expires_at);
    if (expiresAt <= new Date()) return null;
  }

  // Step 5: Resolve tenant_id (already on the row)
  const tenantId: string = apiKey.tenant_id;
  const apiKeyId: string = apiKey.id;
  const scopes: string[] = apiKey.scopes;

  // Step 6: Update last_used_at (fire-and-forget, don't block the response)
  supabase
    .from("api_keys")
    .update({ last_used_at: new Date().toISOString() })
    .eq("id", apiKeyId)
    .then(({ error: updateError }) => {
      if (updateError) {
        console.error("Failed to update last_used_at:", updateError.message);
      }
    });

  // Step 7: Return auth result
  return { tenantId, apiKeyId, scopes };
}

/**
 * Convenience: authenticate and return 401 Response if failed.
 * Use in Edge Functions:
 *
 *   const auth = await requireAuth(request);
 *   if (auth instanceof Response) return auth;
 *   // auth is AuthResult
 */
export async function requireAuth(
  request: Request,
): Promise<AuthResult | Response> {
  const result = await authenticateRequest(request);

  if (!result) {
    return new Response(
      JSON.stringify({
        error: "Unauthorized",
        code: "INVALID_API_KEY",
      }),
      {
        status: 401,
        headers: { "Content-Type": "application/json" },
      },
    );
  }

  return result;
}
