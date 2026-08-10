import type { Firestore } from 'firebase-admin/firestore';
import {
  type CampaignRow,
  type ContributionRow,
  type InsightsPayload,
  computeCumulativePersonalImpactSnapshot,
  computePerCampaignPersonalImpactSnapshot,
  getCampaignActions,
  getCampaignAdViews,
  getCampaignOutOfBubbleAdViews,
  getCampaignEscapedAdViews,
  getCampaignNetRating,
  getCampaignPerceptionShift,
  getCampaignPerceptionShiftSource,
  getCampaignTotalContributionCents,
  computePersonalAttribution,
  filterContributionsByTimeRange,
  buildCumulativeTimeSeries,
  buildCampaignTimeSeries,
  aggregateContributionsByCampaign,
} from './impactMetrics';

export const CAMPAIGN_IMPACT_METRIC_FIELDS = [
  'perception_shift',
  'perception_shift_actual',
  'thumbs_up',
  'thumbs_down',
  'net_rating',
] as const;

export type CampaignImpactMetricField = (typeof CAMPAIGN_IMPACT_METRIC_FIELDS)[number];

/** Validate and normalize optional impact metric fields on campaign PATCH. */
export function sanitizeCampaignImpactMetricsPatch(
  body: Record<string, unknown>
): { patch: Record<string, unknown>; error?: string } {
  const patch: Record<string, unknown> = {};
  for (const key of CAMPAIGN_IMPACT_METRIC_FIELDS) {
    if (body[key] === undefined) continue;
    const raw = body[key];
    if (raw === null) {
      patch[key] = null;
      continue;
    }
    const n = Number(raw);
    if (!Number.isFinite(n)) {
      return { patch: {}, error: `${key} must be a number` };
    }
    if (key === 'thumbs_up' || key === 'thumbs_down') {
      if (n < 0 || !Number.isInteger(n)) {
        return { patch: {}, error: `${key} must be a non-negative integer` };
      }
      patch[key] = n;
      continue;
    }
    if (key === 'perception_shift' || key === 'perception_shift_actual') {
      if (n < 0 || n > 100) {
        return { patch: {}, error: `${key} must be between 0 and 100` };
      }
      patch[key] = Math.round(n * 10) / 10;
      continue;
    }
    patch[key] = Math.round(n);
  }
  return { patch };
}

export function buildInsightsFromCampaign(campaign: CampaignRow): InsightsPayload | null {
  const impressions = Number(campaign.facebook_impressions ?? 0);
  const reach = Number(campaign.facebook_reach ?? campaign.reach ?? 0) || impressions;
  const inlineLinkClicks = Number(campaign.facebook_inline_link_clicks ?? 0);
  const clicks =
    Number(campaign.facebook_clicks ?? 0) ||
    inlineLinkClicks ||
    Number(campaign.facebook_total_actions ?? 0);
  const engagementActions = Number(campaign.facebook_engagement_actions ?? 0);
  if (!impressions && !reach && !clicks && !engagementActions) return null;
  return {
    insights: {
      impressions,
      reach,
      clicks,
      inline_link_clicks: inlineLinkClicks || clicks,
      engagement_actions: engagementActions || undefined,
    },
  };
}

function buildInsightsMap(campaignsById: Record<string, CampaignRow>): Record<string, InsightsPayload | null> {
  const out: Record<string, InsightsPayload | null> = {};
  for (const [id, campaign] of Object.entries(campaignsById)) {
    out[id] = buildInsightsFromCampaign(campaign);
  }
  return out;
}

export function computeCumulativePersonalImpactResponse({
  contributions,
  campaignsById,
  rangeId,
}: {
  contributions: ContributionRow[];
  campaignsById: Record<string, CampaignRow>;
  rangeId: string;
}) {
  const filtered = filterContributionsByTimeRange(contributions, rangeId);
  const insightsById = buildInsightsMap(campaignsById);
  const grouped = aggregateContributionsByCampaign(filtered);

  let totalCents = 0;
  let totalReach = 0;
  let totalActions = 0;
  let shiftSum = 0;
  let trustSum = 0;
  let campaignCount = 0;
  const campaignSummaries: Record<string, unknown>[] = [];

  for (const g of grouped) {
    const campaign = campaignsById[g.campaignId];
    if (!campaign) continue;

    totalCents += g.totalCents;
    const insights = insightsById[g.campaignId];
    const adViews = getCampaignAdViews(campaign, insights);
    const outOfBubble = getCampaignOutOfBubbleAdViews(campaign, insights);
    const escaped = getCampaignEscapedAdViews(campaign, insights);
    const actions = getCampaignActions(campaign, insights);
    const totalContributionCents = getCampaignTotalContributionCents(campaign);
    const shift = getCampaignPerceptionShift(campaign);
    const shiftSource = getCampaignPerceptionShiftSource(campaign);
    const trust = Number(campaign.trust_score) || 0;

    const attr = computePersonalAttribution({
      userContributionCents: g.totalCents,
      totalContributionCents,
      campaignAdViews: adViews.value,
      campaignOutOfBubbleAdViews: outOfBubble.value,
      campaignEscapedAdViews: escaped.value,
      campaignActions: actions.value,
      perceptionShiftPct: shift,
    });

    totalReach += attr.personalAdViews;
    totalActions += attr.personalActions;
    shiftSum += shift;
    if (trust) trustSum += trust;
    campaignCount += 1;

    campaignSummaries.push({
      campaignId: g.campaignId,
      title: g.title || campaign.title || 'Campaign',
      contributedCents: g.totalCents,
      currency: g.currency,
      personalReach: attr.personalAdViews,
      personalViews: attr.personalAdViews,
      personalOutOfBubbleAdViews: attr.personalOutOfBubbleAdViews,
      personalEscapedAdViews: attr.personalEscapedAdViews,
      personalActions: attr.personalActions,
      perceptionShift: shift,
      perceptionShiftSource: shiftSource,
      isVideoAd: Boolean(campaign.facebook_is_video_ad),
      trustScore: trust,
      netRating: getCampaignNetRating(campaign),
      status: campaign.status,
      thumbnailUrl: campaign.thumbnail_url ?? null,
      category: campaign.category ?? null,
      reachSource: adViews.source,
      viewsSource: adViews.source,
    });
  }

  campaignSummaries.sort(
    (a, b) => Number(b.contributedCents) - Number(a.contributedCents)
  );

  return {
    totalContributedCents: totalCents,
    peopleReached: totalReach,
    totalActions,
    avgPerceptionShift: campaignCount ? Math.round((shiftSum / campaignCount) * 10) / 10 : 0,
    avgTrustScore: campaignCount && trustSum ? Math.round(trustSum / campaignCount) : null,
    campaignsBacked: campaignCount,
    campaignSummaries,
    timeSeries: buildCumulativeTimeSeries(filtered, campaignsById, insightsById, rangeId),
  };
}

export function computePerCampaignPersonalImpactResponse({
  contributions,
  campaign,
  rangeId,
}: {
  contributions: ContributionRow[];
  campaign: CampaignRow;
  rangeId: string;
}) {
  const campaignId = campaign.id;
  if (!campaignId) return null;

  const filtered = filterContributionsByTimeRange(
    contributions.filter((c) => (c.campaignId || c.campaign_id) === campaignId),
    rangeId
  );
  if (!filtered.length) return null;

  const insights = buildInsightsFromCampaign(campaign);
  const totalCents = filtered.reduce((s, c) => s + (Number(c.amount_cents) || 0), 0);
  const adViews = getCampaignAdViews(campaign, insights);
  const outOfBubble = getCampaignOutOfBubbleAdViews(campaign, insights);
  const escaped = getCampaignEscapedAdViews(campaign, insights);
  const actions = getCampaignActions(campaign, insights);
  const shift = getCampaignPerceptionShift(campaign);
  const shiftSource = getCampaignPerceptionShiftSource(campaign);
  const actualShift = campaign.perception_shift_actual ?? campaign.perceptionShiftActual;
  const totalContributionCents = getCampaignTotalContributionCents(campaign);

  const attr = computePersonalAttribution({
    userContributionCents: totalCents,
    totalContributionCents,
    campaignAdViews: adViews.value,
    campaignOutOfBubbleAdViews: outOfBubble.value,
    campaignEscapedAdViews: escaped.value,
    campaignActions: actions.value,
    perceptionShiftPct: shift,
  });

  return {
    totalContributedCents: totalCents,
    personalReach: attr.personalAdViews,
    personalViews: attr.personalAdViews,
    personalOutOfBubbleAdViews: attr.personalOutOfBubbleAdViews,
    personalEscapedAdViews: attr.personalEscapedAdViews,
    personalActions: attr.personalActions,
    reconsidered: attr.reconsidered,
    sharePct: attr.sharePct,
    estimatedPerceptionShift: shift,
    perceptionShiftSource: shiftSource,
    isVideoAd: Boolean(campaign.facebook_is_video_ad),
    actualPerceptionShift: actualShift != null ? Number(actualShift) : null,
    netRating: getCampaignNetRating(campaign),
    reachSource: adViews.source,
    viewsSource: adViews.source,
    timeSeries: buildCampaignTimeSeries(campaign, insights, rangeId).map((p) => ({
      ...p,
      reach: Math.round(p.reach * attr.share),
      actions: Math.round(p.actions * attr.share),
    })),
  };
}

export async function loadSimilarCampaigns(
  db: Firestore,
  campaignId: string,
  category: string | undefined,
  limit = 3
): Promise<CampaignRow[]> {
  if (!category) return [];
  const snapshot = await db.collection('campaigns').where('status', '==', 'Approved').get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }) as CampaignRow)
    .filter((c) => c.id !== campaignId && c.category === category)
    .slice(0, limit);
}

export function publicCampaignSummary(campaign: CampaignRow) {
  return {
    id: campaign.id,
    title: campaign.title ?? 'Campaign',
    category: campaign.category ?? null,
    status: campaign.status ?? null,
    thumbnail_url: campaign.thumbnail_url ?? null,
    trust_score: campaign.trust_score ?? null,
    perception_shift: campaign.perception_shift ?? null,
    perception_shift_actual: campaign.perception_shift_actual ?? null,
    thumbs_up: campaign.thumbs_up ?? null,
    thumbs_down: campaign.thumbs_down ?? null,
    net_rating: campaign.net_rating ?? null,
  };
}

/** Re-export snapshots used by share-cards for consistency. */
export {
  computeCumulativePersonalImpactSnapshot,
  computePerCampaignPersonalImpactSnapshot,
};
