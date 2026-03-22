// ============================================
// NOD — _shared/alerting.ts
// Resend email helper for error alerts and expiry notifications.
// Uses RESEND_API_KEY from Supabase secrets.
// ============================================

interface AlertOptions {
  to: string;
  subject: string;
  html: string;
  from?: string;
}

interface SendAlertResult {
  success: boolean;
  error?: string;
}

/**
 * Send an alert email via Resend.
 *
 * Used for:
 * - Error alerts to the founder/admin
 * - Consent expiry notifications to dealerships
 * - CRM sync deadline warnings
 *
 * Returns { success: true } on success, { success: false, error } on failure.
 * Never throws — callers should check the result.
 */
export async function sendAlert(
  options: AlertOptions,
): Promise<SendAlertResult> {
  const resendApiKey = Deno.env.get("RESEND_API_KEY");

  if (!resendApiKey) {
    console.error("RESEND_API_KEY is not configured");
    return { success: false, error: "RESEND_API_KEY not configured" };
  }

  const from = options.from ?? "Nod Alerts <alerts@nod.law>";

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to: options.to,
        subject: options.subject,
        html: options.html,
      }),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error("Resend API error:", response.status, body);
      return { success: false, error: `Resend API ${response.status}: ${body}` };
    }

    return { success: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("Resend request failed:", message);
    return { success: false, error: message };
  }
}

/**
 * Send a founder error alert.
 * Convenience wrapper for critical system errors that need immediate attention.
 */
export async function alertFounder(
  subject: string,
  html: string,
): Promise<SendAlertResult> {
  const founderEmail = Deno.env.get("FOUNDER_ALERT_EMAIL") ?? "xavier@nod.law";

  return sendAlert({
    to: founderEmail,
    subject: `[Nod Alert] ${subject}`,
    html,
  });
}
