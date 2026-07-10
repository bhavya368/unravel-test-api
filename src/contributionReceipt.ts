// Contribution receipt + trust report email.
//
// Fires a Klaviyo event ("Contribution Receipt") with all receipt data on every completed
// contribution — paid and fully coupon-covered ($0). The Klaviyo template (owned by marketing)
// binds to these properties; the backend owns the data so the numbers stay exact.
//
// Money model (authoritative, per Tim): the GROSS contribution — what counts toward the
// campaign — splits 80% ad amplification / 20% platform fee. A coupon discount is a separate
// line so the summary reconciles to what was actually charged:
//   ad_budget + platform_fee - discount = total_charged
// Sales tax is $0 for v1 (until Stripe Tax / FEC requirements). Trust score is the single
// overall value for v1; the layered breakdown + PDF are deferred to the UUTS epic.

/** Ad-amplification share of the gross contribution. Remainder is the platform fee. */
const AD_AMPLIFICATION_SPLIT = 0.8;
/** Projected reach model: ~10 people reached per $1 of amplification budget. */
const REACH_PEOPLE_PER_DOLLAR = 10;
/** Klaviyo metric name — bind the receipt flow/template to this. */
export const RECEIPT_METRIC_NAME = 'Contribution Receipt';

export interface ContributionReceiptInput {
  campaignId: string;
  campaignTitle: string;
  campaignCategory?: string | null;
  campaignImageUrl?: string | null;
  trustScore?: number | null;
  grossCents: number;
  discountCents: number;
  chargedCents: number;
  couponCode?: string | null;
  donorEmail?: string;
  donorName?: string;
  /** e.g. "Card" (paid) or "Coupon (no card)" (zero-balance). */
  paymentMethodLabel?: string | null;
  receiptNumber: string;
  paidAtIso: string;
  frontendBaseUrl: string;
}

const usd = (cents: number): string => `$${(Math.round(cents) / 100).toFixed(2)}`;

/**
 * Assemble the receipt payload and fire the Klaviyo event. Never throws for a
 * missing key/email — receipts must not block or fail the contribution flow.
 */
export async function sendContributionReceipt(input: ContributionReceiptInput): Promise<void> {
  const apiKey = process.env.KLAVIYO_API_KEY?.trim();
  if (!apiKey) {
    console.warn(`[receipt] KLAVIYO_API_KEY not set — skipping receipt ${input.receiptNumber}`);
    return;
  }
  const email = (input.donorEmail || '').trim().toLowerCase();
  if (!email) {
    console.warn(`[receipt] no donor email for ${input.receiptNumber} — skipping`);
    return;
  }

  const gross = Math.max(0, Math.round(input.grossCents));
  const discount = Math.max(0, Math.round(input.discountCents));
  const charged = Math.max(0, Math.round(input.chargedCents));
  const adBudget = Math.round(gross * AD_AMPLIFICATION_SPLIT);
  const platformFee = gross - adBudget; // exact remainder ≈ 20% (avoids rounding drift)
  const salesTax = 0;
  const projectedReach = Math.round((adBudget / 100) * REACH_PEOPLE_PER_DOLLAR);

  // Pre-formatted receipt date (e.g. "Jul 7, 2026") so the email template doesn't depend on
  // Klaviyo date filters. Pinned to Pacific so the date is deterministic regardless of where
  // the server runs (and matches the receipt's "PT" convention).
  let paidAtDisplay = input.paidAtIso;
  try {
    paidAtDisplay = new Date(input.paidAtIso).toLocaleDateString('en-US', {
      year: 'numeric', month: 'short', day: 'numeric', timeZone: 'America/Los_Angeles',
    });
  } catch { /* keep ISO fallback */ }

  const base = input.frontendBaseUrl.replace(/\/$/, '');
  const campaignUrl = `${base}/campaign/${encodeURIComponent(input.campaignId)}`;
  const [firstName, ...rest] = (input.donorName || '').trim().split(/\s+/);
  const lastName = rest.join(' ');

  const properties = {
    receipt_number: input.receiptNumber,
    status: 'Paid',
    paid_at: input.paidAtIso,
    paid_at_display: paidAtDisplay,
    // donor
    donor_name: input.donorName || null,
    donor_email: email,
    payment_method: input.paymentMethodLabel || 'Card',
    processed_by: 'Stripe',
    // campaign
    campaign_id: input.campaignId,
    campaign_title: input.campaignTitle,
    campaign_category: input.campaignCategory || null,
    campaign_image_url: input.campaignImageUrl || null,
    trust_score: typeof input.trustScore === 'number' ? input.trustScore : null,
    // amounts — cents (for logic) + display strings (for the template)
    currency: 'usd',
    gross_cents: gross,
    ad_budget_cents: adBudget,
    platform_fee_cents: platformFee,
    discount_cents: discount,
    sales_tax_cents: salesTax,
    total_charged_cents: charged,
    ad_budget_display: usd(adBudget),
    platform_fee_display: usd(platformFee),
    discount_display: usd(discount),
    sales_tax_display: usd(salesTax),
    total_charged_display: usd(charged),
    ad_split_pct: Math.round(AD_AMPLIFICATION_SPLIT * 100), // 80
    platform_fee_pct: Math.round((1 - AD_AMPLIFICATION_SPLIT) * 100), // 20
    coupon_code: input.couponCode || null,
    has_discount: discount > 0,
    projected_reach: projectedReach,
    // links
    campaign_url: campaignUrl,
    ad_url: campaignUrl,
    impact_url: `${base}/account/impact/${encodeURIComponent(input.campaignId)}`,
    subscribe_url: `${base}/subscribe`,
    trust_report_url: `${campaignUrl}/impact`, // "View online"; PDF is a follow-up
    support_email: 'support@unravel.network',
  };

  const revision = process.env.KLAVIYO_REVISION?.trim() || '2024-10-15';
  const response = await fetch('https://a.klaviyo.com/api/events/', {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${apiKey}`,
      Accept: 'application/json',
      'Content-Type': 'application/json',
      revision,
    },
    body: JSON.stringify({
      data: {
        type: 'event',
        attributes: {
          properties,
          metric: { data: { type: 'metric', attributes: { name: RECEIPT_METRIC_NAME } } },
          profile: {
            data: {
              type: 'profile',
              attributes: {
                email,
                ...(firstName ? { first_name: firstName } : {}),
                ...(lastName ? { last_name: lastName } : {}),
              },
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Klaviyo receipt event failed (${response.status}): ${text.slice(0, 300)}`);
  }
}
