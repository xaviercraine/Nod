// ============================================
// NOD — _shared/classifier.ts
// Conversation 5: Message Classification Rules Engine
//
// CASL message classification: CEM, tier2_exempt, tier1_exempt,
// transactional, non_commercial.
//
// Key CASL rule: s.1(2) "one of its purposes" test — if ANY purpose
// of a message is commercial, the entire message is a CEM.
// This means promotional content embedded in an otherwise exempt
// message destroys the exemption.
// ============================================

import type { MessageClassification } from "./types.ts";

// ---- Input / Output Interfaces ----

export interface ClassifyInput {
  subject: string;
  body: string;
  message_type_hint?: string;
  exemption_reason?: string;
}

export interface ClassifyResult {
  classification: MessageClassification;
  reasons: string[];
  requires_consent: boolean;
  requires_sender_id: boolean;
  requires_unsubscribe: boolean;
}

// ---- Recognized Tier 1 Exempt Categories ----
// Classifier validates the reason is a recognized category
// but cannot verify the factual basis.

const TIER1_EXEMPT_CATEGORIES = [
  "court_order",
  "legal_obligation",
  "quote_or_estimate_requested",
  "providing_warranty_information",
  "product_recall_safety_notice",
  "delivering_requested_product_or_service",
] as const;

// ---- Signal Pattern Definitions ----

// Commercial / promotional signals — any one of these makes
// the message (or part of it) commercial under CASL s.1(2).

const CEM_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Discounts and pricing promotions
  { pattern: /\d+%\s*off/i, label: "Percentage discount offer" },
  { pattern: /save\s+\$?\d+/i, label: "Dollar savings promotion" },
  { pattern: /\bsale\b/i, label: "Sale announcement" },
  { pattern: /\bclearance\b/i, label: "Clearance promotion" },
  { pattern: /\bpromo(?:tion(?:al)?)?\b/i, label: "Promotional content" },
  { pattern: /\bdiscount(?:ed)?\b/i, label: "Discount offer" },
  { pattern: /\bcoupon\b/i, label: "Coupon offer" },
  { pattern: /\bdeal(?:s)?\b/i, label: "Deal promotion" },
  { pattern: /\bspecial\s+offer/i, label: "Special offer" },
  { pattern: /\blimited[\s-]time/i, label: "Limited-time offer" },
  { pattern: /\bflash\s+sale/i, label: "Flash sale promotion" },

  // Calls to action (commercial)
  { pattern: /\bbuy\s+now\b/i, label: "Buy now CTA" },
  { pattern: /\bshop\s+now\b/i, label: "Shop now CTA" },
  { pattern: /\border\s+now\b/i, label: "Order now CTA" },
  { pattern: /\bbook\s+(?:now|today)\b/i, label: "Book now CTA" },
  { pattern: /\bact\s+now\b/i, label: "Act now CTA" },
  { pattern: /\bdon'?t\s+miss\b/i, label: "Urgency CTA" },
  { pattern: /\bhurry\b/i, label: "Urgency language" },

  // Inventory and new product announcements
  { pattern: /\bnew\s+\d{4}\s+model/i, label: "New model year announcement" },
  { pattern: /\bjust\s+arrived\b/i, label: "New inventory arrival" },
  { pattern: /\bin\s+stock\b/i, label: "Inventory availability promotion" },
  { pattern: /\binventory\s+alert/i, label: "Inventory alert" },
  { pattern: /\bnew\s+arrival/i, label: "New arrival announcement" },
  { pattern: /\bnow\s+available\b/i, label: "New availability announcement" },
  { pattern: /\bcheck\s+out\s+(?:our|the)\b/i, label: "Commercial product showcase" },

  // Trade-in / upgrade solicitation
  { pattern: /\btrade[\s-]in\b/i, label: "Trade-in solicitation" },
  { pattern: /\bupgrade\s+(?:your|to)\b/i, label: "Upgrade solicitation" },

  // Financing promotions (distinct from financing statements)
  { pattern: /\b(?:low|special|reduced)\s+(?:interest|rate|apr)\b/i, label: "Financing rate promotion" },
  { pattern: /\b0%\s*(?:apr|financing|interest)\b/i, label: "Zero-interest financing promotion" },
  { pattern: /\bfinancing\s+(?:available|special|offer)/i, label: "Financing promotion" },
  { pattern: /\bpre[\s-]?approv/i, label: "Pre-approval solicitation" },

  // Referral / loyalty programs
  { pattern: /\brefer\s+a\s+friend\b/i, label: "Referral program promotion" },
  { pattern: /\bloyalty\s+(?:program|reward|points)\b/i, label: "Loyalty program promotion" },

  // Event invitations (commercial)
  { pattern: /\btest\s+drive\s+event\b/i, label: "Test drive event promotion" },
  { pattern: /\bopen\s+house\b/i, label: "Open house event promotion" },
  { pattern: /\bvip\s+(?:event|sale|preview)\b/i, label: "VIP event promotion" },
];

// Tier 2 exempt signals — message SOLELY performs one exempt function.
// CASL s.6(6): factual account info, warranty/recall/safety,
// delivering purchased product/service, ongoing subscription updates,
// employment-related.

const TIER2_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Service / maintenance (factual)
  { pattern: /\bservice\s+(?:reminder|appointment|due|schedule)/i, label: "Service reminder (factual account info)" },
  { pattern: /\bmaintenance\s+(?:reminder|due|schedule|required)/i, label: "Maintenance reminder" },
  { pattern: /\boil\s+change\s+(?:due|reminder)/i, label: "Oil change reminder" },
  { pattern: /\btire\s+rotation\b/i, label: "Tire rotation reminder" },
  { pattern: /\bvehicle\s+(?:due|is\s+due)\s+for\s+service/i, label: "Vehicle service due notice" },
  { pattern: /\byour\s+(?:vehicle|car|truck)\s+is\s+(?:due|ready|scheduled)/i, label: "Vehicle status notification" },

  // Safety recall
  { pattern: /\bsafety\s+recall\b/i, label: "Safety recall notice" },
  { pattern: /\brecall\s+notice\b/i, label: "Recall notice" },
  { pattern: /\brecall(?:ed)?[\s:]+/i, label: "Recall notification" },

  // Warranty
  { pattern: /\bwarranty\s+(?:update|information|notice|expir|coverage|claim)/i, label: "Warranty information" },

  // Financing statements (factual, not promotional)
  { pattern: /\bpayment\s+(?:of\s+)?\$[\d,.]+\s+(?:due|is\s+due|owing)/i, label: "Payment due notice" },
  { pattern: /\bfinancing\s+(?:statement|payment|balance|summary)\b/i, label: "Financing statement" },
  { pattern: /\blease\s+(?:payment|statement|balance)\b/i, label: "Lease payment notice" },
  { pattern: /\baccount\s+(?:statement|balance|summary|update)\b/i, label: "Account statement" },

  // Delivery / order fulfillment
  { pattern: /\byour\s+(?:vehicle|order)\s+(?:is\s+)?ready\s+for\s+(?:pickup|delivery)/i, label: "Vehicle/order ready for pickup" },
  { pattern: /\bdelivery\s+(?:confirmation|update|status)\b/i, label: "Delivery update" },

  // Appointment confirmations
  { pattern: /\bappointment\s+(?:confirmation|confirmed|reminder)\b/i, label: "Appointment confirmation" },

  // Employment-related
  { pattern: /\bemployment\b/i, label: "Employment-related communication" },
  { pattern: /\bpayroll\b/i, label: "Payroll communication" },
  { pattern: /\bshift\s+schedule\b/i, label: "Employment schedule" },
];

// Transactional signals — pure receipts and confirmations with zero
// commercial content.

const TRANSACTIONAL_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /\breceipt\b/i, label: "Transaction receipt" },
  { pattern: /\binvoice\b/i, label: "Invoice" },
  { pattern: /\bpayment\s+(?:received|confirmed|processed|successful)/i, label: "Payment confirmation" },
  { pattern: /\btransaction\s+(?:confirmation|receipt|complete)/i, label: "Transaction confirmation" },
  { pattern: /\border\s+(?:confirmation|confirmed|number|#)/i, label: "Order confirmation" },
  { pattern: /\bconfirmation\s+(?:number|#|code)\b/i, label: "Confirmation reference" },
];

// ---- Classification Engine ----

/**
 * Classify a message under CASL rules.
 *
 * Priority order:
 * 1. Tier 1 exempt — requires explicit message_type_hint + exemption_reason.
 *    Classifier validates the reason category but cannot verify factual basis.
 * 2. CEM detection — scans for commercial signals. CASL s.1(2) "one of its
 *    purposes" test: if ANY purpose is commercial, the entire message is CEM.
 *    This means promotional content in an otherwise exempt message → CEM.
 * 3. Tier 2 exempt — message SOLELY performs one s.6(6) function.
 *    Cross-sell or any CEM signal destroys the exemption.
 * 4. Transactional — pure receipts/confirmations with no commercial content.
 * 5. Non-commercial — messages with zero commercial purpose.
 */
export function classifyMessage(input: ClassifyInput): ClassifyResult {
  const { subject, body, message_type_hint, exemption_reason } = input;

  // Combine subject + body for scanning
  const fullText = `${subject ?? ""} ${body ?? ""}`;

  // ---- Step 1: Tier 1 Exempt (manual classification only) ----

  if (message_type_hint === "tier1_exempt") {
    // exemption_reason is required — validated in the Edge Function
    // which returns 400 before calling classifyMessage if missing.
    // But we defensive-check here too.
    const isRecognizedCategory = exemption_reason
      ? TIER1_EXEMPT_CATEGORIES.includes(
          exemption_reason as typeof TIER1_EXEMPT_CATEGORIES[number],
        )
      : false;

    const reasons: string[] = [
      "Manually classified as tier 1 exempt via message_type_hint",
    ];
    if (exemption_reason) {
      reasons.push(`Exemption reason: ${exemption_reason}`);
    }
    if (!isRecognizedCategory && exemption_reason) {
      reasons.push(
        `Note: '${exemption_reason}' is not a recognized standard category — verify factual basis independently`,
      );
    }

    return {
      classification: "tier1_exempt",
      reasons,
      requires_consent: false,
      requires_sender_id: false,
      requires_unsubscribe: false,
    };
  }

  // ---- Step 2: Scan for CEM signals ----

  const cemMatches: string[] = [];
  for (const { pattern, label } of CEM_PATTERNS) {
    if (pattern.test(fullText)) {
      cemMatches.push(label);
    }
  }

  // ---- Step 3: Scan for Tier 2 exempt signals ----

  const tier2Matches: string[] = [];
  for (const { pattern, label } of TIER2_PATTERNS) {
    if (pattern.test(fullText)) {
      tier2Matches.push(label);
    }
  }

  // ---- Step 4: Scan for transactional signals ----

  const transactionalMatches: string[] = [];
  for (const { pattern, label } of TRANSACTIONAL_PATTERNS) {
    if (pattern.test(fullText)) {
      transactionalMatches.push(label);
    }
  }

  // ---- Step 5: Apply CASL s.1(2) "one of its purposes" test ----
  // If ANY commercial signal is present, the message is CEM —
  // regardless of whether tier 2 or transactional signals also exist.

  if (cemMatches.length > 0) {
    const reasons = [...cemMatches];

    // Note if the message also had exempt/transactional signals
    // that were overridden by the commercial content.
    if (tier2Matches.length > 0) {
      reasons.push(
        `Exempt content detected (${tier2Matches[0]}) but overridden by commercial signals — CASL s.1(2) 'one of its purposes' test`,
      );
    }
    if (transactionalMatches.length > 0) {
      reasons.push(
        `Transactional content detected (${transactionalMatches[0]}) but overridden by commercial signals — CASL s.1(2) 'one of its purposes' test`,
      );
    }

    return {
      classification: "cem",
      reasons,
      requires_consent: true,
      requires_sender_id: true,
      requires_unsubscribe: true,
    };
  }

  // ---- Step 6: No CEM signals — check Tier 2 exempt ----
  // Message SOLELY performs an exempt function.

  if (tier2Matches.length > 0) {
    return {
      classification: "tier2_exempt",
      reasons: tier2Matches,
      requires_consent: false,
      requires_sender_id: true,
      requires_unsubscribe: true,
    };
  }

  // ---- Step 7: No CEM, no Tier 2 — check Transactional ----

  if (transactionalMatches.length > 0) {
    return {
      classification: "transactional",
      reasons: transactionalMatches,
      requires_consent: false,
      requires_sender_id: false,
      requires_unsubscribe: false,
    };
  }

  // ---- Step 8: Default — non-commercial ----

  return {
    classification: "non_commercial",
    reasons: ["No commercial, exempt, or transactional signals detected"],
    requires_consent: false,
    requires_sender_id: false,
    requires_unsubscribe: false,
  };
}
