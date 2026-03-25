// ============================================
// NOD — _shared/expiry-calculator.ts
// Consent expiry window calculations per CASL rules.
//
// express / pre_casl_express / conspicuous_publication: NULL (never expires)
// implied_ebr: qualifying_event_date + 2 years
// implied_ebr_contract: contract_expiry_date + 2 years
// implied_inquiry: qualifying_event_date + 6 months
//
// Extracted from api-consent/index.ts for reuse by batch import (Conv 4).
// ============================================

import type { ConsentType } from "./types.ts";

/**
 * Calculate the expiry date for a consent record based on its type.
 *
 * @param consentType - The type of consent being recorded
 * @param qualifyingEventDate - ISO date string of the qualifying event
 * @param contractExpiryDate - ISO date string of contract expiry (required for implied_ebr_contract)
 * @returns ISO date string of expiry, or null if consent never expires
 */
export function calculateExpiryDate(
  consentType: ConsentType,
  qualifyingEventDate: string,
  contractExpiryDate?: string | null,
): string | null {
  switch (consentType) {
    case "express":
    case "pre_casl_express":
    case "conspicuous_publication":
      return null; // Never expires

    case "implied_ebr": {
      const d = new Date(qualifyingEventDate);
      d.setFullYear(d.getFullYear() + 2);
      return d.toISOString();
    }

    case "implied_ebr_contract": {
      const d = new Date(contractExpiryDate!);
      d.setFullYear(d.getFullYear() + 2);
      return d.toISOString();
    }

    case "implied_inquiry": {
      const d = new Date(qualifyingEventDate);
      d.setMonth(d.getMonth() + 6);
      return d.toISOString();
    }

    default:
      return null;
  }
}
