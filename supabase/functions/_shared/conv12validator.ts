// ============================================
// NOD — _shared/validator.ts
// Conversation 6: CEM Compliance Validator
//
// Sender ID validation [CASL s.6(2)]:
//   - sender_name (required)
//   - mailing_address (required)
//   - At least one contact method: phone, email, or website_url
//   - If on_behalf_of is set, both sender and on_behalf_of must be identified
//
// Unsubscribe mechanism validation [CASL s.11]:
//   - Mechanism must be present (unsubscribe_url non-empty)
//   - Must be functional for 60 days [Regs s.3(1)]
//   - For Conv 6: validate that unsubscribe_url is provided and non-empty
//
// Classification-specific requirements:
//   - CEM: requires sender ID + unsubscribe mechanism
//   - Tier 2 exempt: requires sender ID + unsubscribe mechanism (same as CEM per CASL)
//   - Tier 1 exempt: no requirements
//   - Transactional / non-commercial: no requirements
// ============================================

import type { MessageClassification, ComplianceResult, SenderProfile } from "./types.ts";

// ---- Interfaces ----

export interface ValidateComplianceInput {
  sender_profile: SenderProfile;
  unsubscribe_url?: string | null;
  classification: MessageClassification;
}

export interface ValidationFailure {
  field: string;
  code: string;
  message: string;
}

export interface ValidateComplianceResult {
  sender_id_valid: boolean;
  unsubscribe_valid: boolean;
  compliance_result: ComplianceResult;
  failures: ValidationFailure[];
}

// ---- Classifications that require sender ID + unsubscribe ----

const REQUIRES_SENDER_ID: MessageClassification[] = ["cem", "tier2_exempt"];
const REQUIRES_UNSUBSCRIBE: MessageClassification[] = ["cem", "tier2_exempt"];

// ---- Sender ID Validation [CASL s.6(2)] ----

/**
 * Validate sender identification fields.
 *
 * Required:
 *   - sender_name (non-empty)
 *   - mailing_address (non-empty)
 *   - At least one contact method: phone, email, or website_url
 *
 * If on_behalf_of is set:
 *   - The on_behalf_of name must be non-empty
 *   - The sender (person acting on behalf) must ALSO be fully identified
 *     (same requirements as above — this is already checked since we validate
 *     the sender_profile fields regardless)
 *   - Both identities are considered identified if the sender_profile itself
 *     passes all checks AND on_behalf_of is a non-empty string
 */
export function validateSenderId(profile: SenderProfile): {
  valid: boolean;
  failures: ValidationFailure[];
} {
  const failures: ValidationFailure[] = [];

  // sender_name required
  if (!profile.sender_name || profile.sender_name.trim() === "") {
    failures.push({
      field: "sender_name",
      code: "sender_id_incomplete",
      message: "Sender name is required [CASL s.6(2)(a)]",
    });
  }

  // mailing_address required
  if (!profile.mailing_address || profile.mailing_address.trim() === "") {
    failures.push({
      field: "mailing_address",
      code: "sender_id_incomplete",
      message: "Mailing address is required [CASL s.6(2)(c)]",
    });
  }

  // At least one contact method
  const hasPhone = profile.phone != null && profile.phone.trim() !== "";
  const hasEmail = profile.email != null && profile.email.trim() !== "";
  const hasWebsite = profile.website_url != null && profile.website_url.trim() !== "";

  if (!hasPhone && !hasEmail && !hasWebsite) {
    failures.push({
      field: "contact_method",
      code: "sender_id_incomplete",
      message:
        "At least one contact method (phone, email, or website_url) is required [CASL s.6(2)(c)]",
    });
  }

  // on_behalf_of dual-identity validation [CASL s.6(2)(a)]
  if (profile.on_behalf_of != null) {
    if (profile.on_behalf_of.trim() === "") {
      failures.push({
        field: "on_behalf_of",
        code: "sender_id_incomplete",
        message:
          "on_behalf_of is set but empty — must identify the person on whose behalf the message is sent [CASL s.6(2)(a)]",
      });
    }
    // If on_behalf_of is set and non-empty, the sender (profile owner) must also
    // be identified — which is already validated above. Both identities are covered
    // by a single sender_profile row: sender_name = sender, on_behalf_of = principal.
  }

  return { valid: failures.length === 0, failures };
}

// ---- Unsubscribe Mechanism Validation [CASL s.11] ----

/**
 * Validate unsubscribe mechanism.
 *
 * For Conv 6: checks that unsubscribe_url is provided and non-empty.
 * Full mechanism validation (functional test, 60-day availability)
 * would require runtime checks — for now we validate presence.
 */
export function validateUnsubscribe(unsubscribeUrl?: string | null): {
  valid: boolean;
  failures: ValidationFailure[];
} {
  const failures: ValidationFailure[] = [];

  if (!unsubscribeUrl || unsubscribeUrl.trim() === "") {
    failures.push({
      field: "unsubscribe_url",
      code: "unsubscribe_missing",
      message:
        "Unsubscribe mechanism is required — must provide a functional unsubscribe URL [CASL s.11, Regs s.3(1)]",
    });
  }

  return { valid: failures.length === 0, failures };
}

// ---- Combined Compliance Validation ----

/**
 * Validate full CEM compliance based on message classification.
 *
 * CEM + tier2_exempt: requires sender ID + unsubscribe mechanism
 * tier1_exempt / transactional / non_commercial: no requirements → pass
 */
export function validateCompliance(
  input: ValidateComplianceInput,
): ValidateComplianceResult {
  const { sender_profile, unsubscribe_url, classification } = input;

  const needsSenderId = REQUIRES_SENDER_ID.includes(classification);
  const needsUnsubscribe = REQUIRES_UNSUBSCRIBE.includes(classification);

  // If no requirements, pass immediately
  if (!needsSenderId && !needsUnsubscribe) {
    return {
      sender_id_valid: true,
      unsubscribe_valid: true,
      compliance_result: "pass",
      failures: [],
    };
  }

  const allFailures: ValidationFailure[] = [];

  // Sender ID validation
  let senderIdValid = true;
  if (needsSenderId) {
    const senderResult = validateSenderId(sender_profile);
    senderIdValid = senderResult.valid;
    allFailures.push(...senderResult.failures);
  }

  // Unsubscribe validation
  let unsubscribeValid = true;
  if (needsUnsubscribe) {
    const unsubResult = validateUnsubscribe(unsubscribe_url);
    unsubscribeValid = unsubResult.valid;
    allFailures.push(...unsubResult.failures);
  }

  const complianceResult: ComplianceResult =
    allFailures.length === 0 ? "pass" : "fail";

  return {
    sender_id_valid: senderIdValid,
    unsubscribe_valid: unsubscribeValid,
    compliance_result: complianceResult,
    failures: allFailures,
  };
}
