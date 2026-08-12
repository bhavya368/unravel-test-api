/**
 * UE-188 — Share-link attribution (GoFundMe-style micro-fundraiser refs).
 *
 * Collection: share_links/{ref} in the `unravel` Firestore DB.
 * Attribution window: SHARE_ATTRIBUTION_WINDOW_DAYS (default 7), exposed via GET /config/attribution.
 *
 * Events (PostHog): share_link_created, share_link_visited, share_attributed_back
 */
import { randomBytes } from 'crypto';
import type { Firestore } from 'firebase-admin/firestore';
import type { PostHog } from 'posthog-node';
import {
  computePersonalAttribution,
  getCampaignActions,
  getCampaignAdViews,
  getCampaignEscapedAdViews,
  getCampaignOutOfBubbleAdViews,
  getCampaignPerceptionShift,
  getCampaignTotalContributionCents,
  type CampaignRow,
} from './impactMetrics';

export type ShareSurface = 'campaign' | 'interstitial' | 'lander' | 'impact_card';

export interface ShareLinkDoc {
  ref: string;
  campaignId: string | null;
  surface: ShareSurface;
  scope?: 'cumulative' | 'campaign';
  shareCardToken?: string | null;
  sharerUid: string | null;
  guestDistinctId: string | null;
  createdAt: string;
  revoked: boolean;
  stats: {
    visits: number;
    backs: number;
    amountCents: number;
    reachDriven: number;
  };
}

export interface ShareStatsSummary {
  linkVisits: number;
  backsDriven: number;
  amountDrivenCents: number;
  reachDriven: number;
  attributionWindowDays: number;
}

const REF_ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const REF_LEN = 8;

/** Default attribution window for share refs (days). Override with SHARE_ATTRIBUTION_WINDOW_DAYS. */
export function getShareAttributionWindowDays(): number {
  const raw = Number(process.env.SHARE_ATTRIBUTION_WINDOW_DAYS);
  if (Number.isFinite(raw) && raw > 0 && raw <= 365) return Math.round(raw);
  return 7;
}

export function getShareAttributionWindowMs(): number {
  return getShareAttributionWindowDays() * 24 * 60 * 60 * 1000;
}

export function generateShareRef(): string {
  const bytes = randomBytes(REF_LEN);
  let out = '';
  for (let i = 0; i < REF_LEN; i++) {
    out += REF_ALPHABET[bytes[i]! % REF_ALPHABET.length];
  }
  return out;
}

export function sanitizeShareRef(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!/^[a-zA-Z0-9_-]{4,32}$/.test(s)) return null;
  // Signup lander hint — not a share attribution code
  if (s.toLowerCase() === 'lander') return null;
  return s;
}

export function isShareSurface(v: unknown): v is ShareSurface {
  return v === 'campaign' || v === 'interstitial' || v === 'lander' || v === 'impact_card';
}

function emptyStats() {
  return { visits: 0, backs: 0, amountCents: 0, reachDriven: 0 };
}

function summarizeLinks(docs: ShareLinkDoc[]): ShareStatsSummary {
  let linkVisits = 0;
  let backsDriven = 0;
  let amountDrivenCents = 0;
  let reachDriven = 0;
  for (const d of docs) {
    const s = d.stats || emptyStats();
    linkVisits += Number(s.visits) || 0;
    backsDriven += Number(s.backs) || 0;
    amountDrivenCents += Number(s.amountCents) || 0;
    reachDriven += Number(s.reachDriven) || 0;
  }
  return {
    linkVisits,
    backsDriven,
    amountDrivenCents,
    reachDriven,
    attributionWindowDays: getShareAttributionWindowDays(),
  };
}

/**
 * Find an existing active link for this sharer+campaign+surface, or create one.
 * Guests are keyed by posthogDistinctId; logged-in users by uid.
 */
export async function createOrGetShareLink(
  db: Firestore,
  input: {
    campaignId?: string | null;
    surface: ShareSurface;
    scope?: 'cumulative' | 'campaign';
    shareCardToken?: string | null;
    sharerUid?: string | null;
    guestDistinctId?: string | null;
  },
  ph: PostHog | null
): Promise<{ link: ShareLinkDoc; created: boolean }> {
  const campaignId = input.campaignId?.trim() || null;
  const surface = input.surface;
  const sharerUid = input.sharerUid?.trim() || null;
  const guestDistinctId = sharerUid ? null : input.guestDistinctId?.trim() || null;

  if (!sharerUid && !guestDistinctId) {
    throw new Error('sharerUid or guestDistinctId required');
  }

  let q;
  if (sharerUid) {
    q = db.collection('share_links').where('sharerUid', '==', sharerUid).limit(100);
  } else {
    q = db.collection('share_links').where('guestDistinctId', '==', guestDistinctId).limit(100);
  }

  const snap = await q.get();
  const match = snap.docs.find((doc) => {
    const d = doc.data() as ShareLinkDoc;
    if (d.revoked) return false;
    if (d.surface !== surface) return false;
    const sameCampaign = (d.campaignId || null) === campaignId;
    if (surface === 'impact_card' && input.shareCardToken) {
      return sameCampaign && d.shareCardToken === input.shareCardToken;
    }
    return sameCampaign;
  });

  if (match) {
    return { link: { ...(match.data() as ShareLinkDoc), ref: match.id }, created: false };
  }

  // Allocate a unique short ref
  let ref = generateShareRef();
  for (let attempt = 0; attempt < 5; attempt++) {
    const existing = await db.collection('share_links').doc(ref).get();
    if (!existing.exists) break;
    ref = generateShareRef();
  }

  const createdAt = new Date().toISOString();
  const link: ShareLinkDoc = {
    ref,
    campaignId,
    surface,
    ...(input.scope ? { scope: input.scope } : {}),
    ...(input.shareCardToken ? { shareCardToken: input.shareCardToken } : {}),
    sharerUid,
    guestDistinctId,
    createdAt,
    revoked: false,
    stats: emptyStats(),
  };

  await db.collection('share_links').doc(ref).set(link);

  if (ph) {
    ph.capture({
      distinctId: sharerUid || guestDistinctId || ref,
      event: 'share_link_created',
      properties: {
        share_ref: ref,
        campaign_id: campaignId,
        surface,
        is_guest: !sharerUid,
        tracking: 'intentional',
      },
    });
  }

  return { link, created: true };
}

export async function recordShareLinkVisit(
  db: Firestore,
  input: {
    ref: string;
    visitorDistinctId?: string | null;
    visitorUid?: string | null;
    isCrawler?: boolean;
  },
  ph: PostHog | null
): Promise<{ ok: boolean; campaignId: string | null }> {
  const ref = sanitizeShareRef(input.ref);
  if (!ref || input.isCrawler) return { ok: false, campaignId: null };

  const docRef = db.collection('share_links').doc(ref);
  const snap = await docRef.get();
  if (!snap.exists) return { ok: false, campaignId: null };
  const data = snap.data() as ShareLinkDoc;
  if (data.revoked) return { ok: false, campaignId: null };

  // Don't count the sharer visiting their own link
  if (data.sharerUid && input.visitorUid && data.sharerUid === input.visitorUid) {
    return { ok: true, campaignId: data.campaignId };
  }
  if (
    data.guestDistinctId &&
    input.visitorDistinctId &&
    data.guestDistinctId === input.visitorDistinctId &&
    !data.sharerUid
  ) {
    return { ok: true, campaignId: data.campaignId };
  }

  const visitedAt = new Date().toISOString();
  const visitId = `${Date.now()}_${randomBytes(4).toString('hex')}`;

  await db.runTransaction(async (t) => {
    const current = await t.get(docRef);
    if (!current.exists) return;
    const cur = current.data() as ShareLinkDoc;
    const visits = (Number(cur.stats?.visits) || 0) + 1;
    t.update(docRef, {
      'stats.visits': visits,
    });
    t.set(docRef.collection('visits').doc(visitId), {
      ref,
      campaignId: cur.campaignId,
      visitedAt,
      visitorDistinctId: input.visitorDistinctId || null,
      visitorUid: input.visitorUid || null,
    });
  });

  if (ph) {
    ph.capture({
      distinctId: input.visitorUid || input.visitorDistinctId || `visit_${ref}`,
      event: 'share_link_visited',
      properties: {
        share_ref: ref,
        campaign_id: data.campaignId,
        surface: data.surface,
        tracking: 'intentional',
      },
    });
  }

  return { ok: true, campaignId: data.campaignId };
}

function estimateReachDriven(campaign: CampaignRow | null, amountCents: number): number {
  if (!campaign || amountCents <= 0) {
    // Platform heuristic: ~10 people reached per dollar
    return Math.round((amountCents / 100) * 10);
  }
  const totalContributionCents = getCampaignTotalContributionCents(campaign) || amountCents;
  const campaignAdViews = getCampaignAdViews(campaign).value;
  const campaignReach =
    Number(campaign.facebook_reach ?? campaign.reach ?? 0) || campaignAdViews;
  const attr = computePersonalAttribution({
    userContributionCents: amountCents,
    totalContributionCents,
    campaignAdViews,
    campaignOutOfBubbleAdViews: getCampaignOutOfBubbleAdViews(campaign).value,
    campaignEscapedAdViews: getCampaignEscapedAdViews(campaign).value,
    campaignReach,
    campaignActions: getCampaignActions(campaign).value,
    perceptionShiftPct: getCampaignPerceptionShift(campaign),
  });
  return Number(attr.personalReach) || Math.round((amountCents / 100) * 10);
}

/**
 * Attribute a completed back to a share ref when within the config-driven window.
 * Idempotent per payment idKey (caller already dedupes via coupon_backings).
 */
export async function attributeShareBack(
  db: Firestore,
  input: {
    shareRef: string | null;
    campaignId: string | null;
    amountCents: number;
    backerUid?: string | null;
    backerDistinctId?: string | null;
    paymentIdKey: string;
  },
  ph: PostHog | null
): Promise<{ attributed: boolean; sharerUid: string | null }> {
  const ref = sanitizeShareRef(input.shareRef);
  if (!ref || !input.paymentIdKey) return { attributed: false, sharerUid: null };

  const docRef = db.collection('share_links').doc(ref);
  const snap = await docRef.get();
  if (!snap.exists) return { attributed: false, sharerUid: null };
  const link = snap.data() as ShareLinkDoc;
  if (link.revoked) return { attributed: false, sharerUid: null };

  // Self-attribution guard
  if (link.sharerUid && input.backerUid && link.sharerUid === input.backerUid) {
    return { attributed: false, sharerUid: null };
  }

  const windowMs = getShareAttributionWindowMs();
  let withinWindow = false;

  // Prefer a recorded visit for this visitor within the window
  if (input.backerUid || input.backerDistinctId) {
    try {
      const visitsSnap = await docRef.collection('visits').limit(50).get();
      for (const v of visitsSnap.docs) {
        const row = v.data() as {
          visitedAt?: string;
          visitorUid?: string | null;
          visitorDistinctId?: string | null;
        };
        const matchUid = input.backerUid && row.visitorUid === input.backerUid;
        const matchDistinct =
          input.backerDistinctId && row.visitorDistinctId === input.backerDistinctId;
        if (!matchUid && !matchDistinct) continue;
        const t = row.visitedAt ? Date.parse(row.visitedAt) : NaN;
        if (Number.isFinite(t) && Date.now() - t <= windowMs) {
          withinWindow = true;
          break;
        }
      }
    } catch {
      /* fall through to createdAt / captured fallback */
    }
  }

  // Fallback: link created within window (covers guests who never hit /visit but have ref in checkout)
  if (!withinWindow) {
    const created = link.createdAt ? Date.parse(link.createdAt) : NaN;
    if (Number.isFinite(created) && Date.now() - created <= windowMs) {
      withinWindow = true;
    }
  }

  if (!withinWindow) return { attributed: false, sharerUid: null };

  let campaign: CampaignRow | null = null;
  const campaignId = input.campaignId || link.campaignId;
  if (campaignId) {
    try {
      const campSnap = await db.collection('campaigns').doc(campaignId).get();
      if (campSnap.exists) {
        campaign = { id: campSnap.id, ...(campSnap.data() as CampaignRow) };
      }
    } catch {
      campaign = null;
    }
  }

  const amountCents = Math.max(0, Math.round(Number(input.amountCents) || 0));
  const reachDriven = estimateReachDriven(campaign, amountCents);
  const attributedAt = new Date().toISOString();

  // Idempotent attribution ledger
  const attrRef = db.collection('share_attributions').doc(input.paymentIdKey);
  let isNew = false;
  await db.runTransaction(async (t) => {
    const existing = await t.get(attrRef);
    if (existing.exists) return;
    isNew = true;
    t.set(attrRef, {
      share_ref: ref,
      campaign_id: campaignId,
      amount_cents: amountCents,
      reach_driven: reachDriven,
      sharer_uid: link.sharerUid,
      backer_uid: input.backerUid || null,
      backer_distinct_id: input.backerDistinctId || null,
      attributed_at: attributedAt,
      attribution_window_days: getShareAttributionWindowDays(),
    });
    const cur = await t.get(docRef);
    if (!cur.exists) return;
    const stats = (cur.data() as ShareLinkDoc).stats || emptyStats();
    t.update(docRef, {
      'stats.backs': (Number(stats.backs) || 0) + 1,
      'stats.amountCents': (Number(stats.amountCents) || 0) + amountCents,
      'stats.reachDriven': (Number(stats.reachDriven) || 0) + reachDriven,
    });
  });

  if (!isNew) return { attributed: true, sharerUid: link.sharerUid };

  if (ph) {
    ph.capture({
      distinctId: input.backerUid || input.backerDistinctId || `back_${input.paymentIdKey}`,
      event: 'share_attributed_back',
      properties: {
        share_ref: ref,
        campaign_id: campaignId,
        amount_total: amountCents,
        reach_driven: reachDriven,
        sharer_uid: link.sharerUid,
        is_guest_sharer: !link.sharerUid,
        attribution_window_days: getShareAttributionWindowDays(),
        tracking: 'intentional',
      },
    });
  }

  return { attributed: true, sharerUid: link.sharerUid };
}

export async function loadShareStatsForUser(
  db: Firestore,
  uid: string,
  campaignId?: string | null
): Promise<ShareStatsSummary> {
  const snap = await db.collection('share_links').where('sharerUid', '==', uid).limit(200).get();
  let docs = snap.docs
    .map((d) => ({ ...(d.data() as ShareLinkDoc), ref: d.id }))
    .filter((d) => !d.revoked);
  if (campaignId) {
    docs = docs.filter((d) => d.campaignId === campaignId);
  }
  return summarizeLinks(docs);
}
