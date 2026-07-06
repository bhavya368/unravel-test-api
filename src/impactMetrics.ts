import {
  computeEngagementActions,
  computePerceptionShiftFromMetaActions,
  getCampaignTotalContributionCents,
  parseFacebookActions,
  type MetaActionRow,
} from './impactKpi';

/** Platform heuristics — used when Meta ad data is unavailable. */
export const REACH_PER_DOLLAR = 10;
export const AD_VIEWS_PER_DOLLAR = 10;
export const ACTIONS_PER_AD_VIEW = 0.033;

export { getCampaignTotalContributionCents };

export type MetricSource = 'actual' | 'estimated';

export interface SourcedMetric {
  value: number;
  source: MetricSource;
}

export interface ContributionRow {
  campaignId?: string;
  campaign_id?: string;
  campaignTitle?: string;
  campaign_title?: string;
  amount_cents?: number;
  currency?: string;
  recordedAt?: string;
}

export interface CampaignRow {
  id?: string;
  title?: string;
  category?: string;
  trust_score?: number;
  status?: string;
  thumbnail_url?: string;
  funding_goal?: number;
  funding_current?: number;
  amount_raised?: number;
  funding_raised?: number;
  facebook_impressions?: number;
  facebook_reach?: number;
  facebook_clicks?: number;
  facebook_inline_link_clicks?: number;
  facebook_engagement_actions?: number;
  facebook_post_engagement?: number;
  facebook_video_views?: number;
  facebook_video_p75_watched?: number;
  facebook_perception_shift_score?: number;
  facebook_perception_shift_source?: string;
  facebook_is_video_ad?: boolean;
  facebook_actions?: MetaActionRow[];
  facebook_out_of_bubble_impressions?: number;
  facebook_escaped_impressions?: number;
  facebook_total_actions?: number;
  reach?: number;
  perception_shift?: number;
  perception_shift_actual?: number;
  perceptionShift?: number;
  perceptionShiftActual?: number;
  estimated_perception_shift?: number;
  thumbs_up?: number;
  thumbsUp?: number;
  thumbs_down?: number;
  thumbsDown?: number;
  net_rating?: number;
  netRating?: number;
}

export interface InsightsPayload {
  insights?: {
    impressions?: number;
    reach?: number;
    clicks?: number;
    inline_link_clicks?: number;
    engagement_actions?: number;
  };
}

function getStoredFacebookActions(campaign: CampaignRow): MetaActionRow[] {
  return parseFacebookActions(campaign.facebook_actions);
}

function getCampaignImpressions(
  campaign: CampaignRow,
  insights?: InsightsPayload | null
): SourcedMetric {
  const raw = insights?.insights ?? insights;
  const impressions = Number((raw as { impressions?: number })?.impressions ?? 0);
  if (impressions > 0) return { value: impressions, source: 'actual' };

  const stored = Number(campaign?.facebook_impressions ?? 0);
  if (stored > 0) return { value: stored, source: 'actual' };

  const budgetDollars = getCampaignTotalContributionCents(campaign) / 100;
  return { value: Math.round(budgetDollars * AD_VIEWS_PER_DOLLAR), source: 'estimated' };
}

function estimatePerceptionShift(trustScore: number | undefined): number {
  const s = Number(trustScore);
  if (!Number.isFinite(s)) return 4.5;
  return Math.round((3 + (Math.min(100, Math.max(0, s)) / 100) * 3) * 10) / 10;
}

export function getCampaignPerceptionShift(campaign: CampaignRow): number {
  const actual =
    campaign?.perception_shift_actual ??
    campaign?.perceptionShiftActual ??
    (campaign as Record<string, unknown>)?.actual_perception_shift;
  if (actual != null && Number.isFinite(Number(actual))) return Number(actual);

  const storedScore = Number(campaign?.facebook_perception_shift_score ?? 0);
  if (storedScore > 0) return storedScore;

  const actions = getStoredFacebookActions(campaign);
  const impressions = Number(campaign?.facebook_impressions ?? 0);
  const videoP75 = Number(campaign?.facebook_video_p75_watched ?? 0);
  if (actions.length && impressions > 0) {
    const computed = computePerceptionShiftFromMetaActions(actions, impressions, videoP75);
    if (computed.score > 0) return computed.score;
  }

  const estimated =
    campaign?.perception_shift ??
    campaign?.perceptionShift ??
    campaign?.estimated_perception_shift;
  if (estimated != null && Number.isFinite(Number(estimated))) return Number(estimated);

  return estimatePerceptionShift(campaign?.trust_score);
}

export function getCampaignPerceptionShiftSource(campaign: CampaignRow): MetricSource {
  const actual =
    campaign?.perception_shift_actual ??
    campaign?.perceptionShiftActual ??
    (campaign as Record<string, unknown>)?.actual_perception_shift;
  if (actual != null && Number.isFinite(Number(actual))) return 'actual';

  if (
    Number(campaign?.facebook_perception_shift_score ?? 0) > 0 &&
    campaign?.facebook_perception_shift_source === 'actual'
  ) {
    return 'actual';
  }

  const actions = getStoredFacebookActions(campaign);
  if (actions.length && Number(campaign?.facebook_impressions ?? 0) > 0) {
    return 'actual';
  }

  return 'estimated';
}

export function getCampaignBudgetCents(campaign: CampaignRow): number {
  return getCampaignTotalContributionCents(campaign);
}

/** Ad Views = Meta impressions (times the ad was seen). */
export function getCampaignAdViews(
  campaign: CampaignRow,
  insights?: InsightsPayload | null
): SourcedMetric {
  return getCampaignImpressions(campaign, insights);
}

/** Out-of-bubble / Escaped ad views default to total ad views until audience splits are stored. */
export function getCampaignOutOfBubbleAdViews(
  campaign: CampaignRow,
  insights?: InsightsPayload | null
): SourcedMetric {
  const stored = Number(campaign?.facebook_out_of_bubble_impressions ?? 0);
  if (stored > 0) return { value: stored, source: 'actual' };
  return getCampaignAdViews(campaign, insights);
}

export function getCampaignEscapedAdViews(
  campaign: CampaignRow,
  insights?: InsightsPayload | null
): SourcedMetric {
  const stored = Number(campaign?.facebook_escaped_impressions ?? 0);
  if (stored > 0) return { value: stored, source: 'actual' };
  return getCampaignAdViews(campaign, insights);
}

export function getCampaignReach(campaign: CampaignRow, insights?: InsightsPayload | null): SourcedMetric {
  const raw = insights?.insights ?? insights;
  const fbReach = Number((raw as { reach?: number })?.reach ?? 0);
  if (fbReach > 0) return { value: fbReach, source: 'actual' };

  const storedReach = Number(campaign?.facebook_reach ?? campaign?.reach ?? 0);
  if (storedReach > 0) return { value: storedReach, source: 'actual' };

  const adViews = getCampaignAdViews(campaign, insights);
  if (adViews.source === 'actual') {
    return { value: Math.round(adViews.value * 0.92), source: 'actual' };
  }

  const budgetDollars = getCampaignTotalContributionCents(campaign) / 100;
  return { value: Math.round(budgetDollars * REACH_PER_DOLLAR), source: 'estimated' };
}

export function getCampaignViews(
  campaign: CampaignRow,
  insights: InsightsPayload | null | undefined,
  reach?: SourcedMetric
): SourcedMetric {
  return getCampaignAdViews(campaign, insights);
}

export function getCampaignActions(
  campaign: CampaignRow,
  insights?: InsightsPayload | null
): SourcedMetric {
  const raw = insights?.insights ?? insights;
  const actions = getStoredFacebookActions(campaign);
  const computed = computeEngagementActions(actions, {
    storedPostEngagement: Number(campaign?.facebook_post_engagement ?? 0),
    storedVideoViews: Number(campaign?.facebook_video_views ?? 0),
    fallbackInlineClicks: Number(campaign?.facebook_inline_link_clicks ?? campaign?.facebook_clicks ?? 0),
  });
  if (actions.length) return { value: computed, source: 'actual' };

  const fromInsights = Number((raw as { engagement_actions?: number })?.engagement_actions ?? 0);
  if (fromInsights > 0) return { value: fromInsights, source: 'actual' };

  const storedEngagement = Number(campaign?.facebook_engagement_actions ?? 0);
  if (storedEngagement > 0) return { value: storedEngagement, source: 'actual' };

  const adViews = getCampaignAdViews(campaign, insights).value;
  return { value: Math.round(adViews * ACTIONS_PER_AD_VIEW), source: 'estimated' };
}

export function computePersonalAttribution({
  userContributionCents,
  totalBudgetCents,
  totalContributionCents,
  campaignAdViews,
  campaignOutOfBubbleAdViews,
  campaignEscapedAdViews,
  campaignReach,
  campaignViews,
  campaignActions,
  perceptionShiftPct,
}: {
  userContributionCents: number;
  totalBudgetCents?: number;
  totalContributionCents?: number;
  campaignAdViews?: number;
  campaignOutOfBubbleAdViews?: number;
  campaignEscapedAdViews?: number;
  campaignReach?: number;
  campaignViews?: number;
  campaignActions: number;
  perceptionShiftPct: number;
}) {
  const totalCents =
    totalContributionCents ?? totalBudgetCents ?? 0;
  const share =
    totalCents > 0
      ? userContributionCents / totalCents
      : userContributionCents > 0
        ? 1
        : 0;
  const adViews = campaignAdViews ?? campaignViews ?? campaignReach ?? 0;
  const outOfBubble = campaignOutOfBubbleAdViews ?? adViews;
  const escaped = campaignEscapedAdViews ?? adViews;

  const personalAdViews = Math.round(adViews * share);
  const personalOutOfBubbleAdViews = Math.round(outOfBubble * share);
  const personalEscapedAdViews = Math.round(escaped * share);
  const personalActions = Math.round(campaignActions * share);
  const perceptionShift = Number(perceptionShiftPct) || 0;
  const reconsidered = Math.round(personalAdViews * (perceptionShift / 100));

  return {
    share,
    sharePct: Math.round(share * 1000) / 10,
    personalAdViews,
    personalOutOfBubbleAdViews,
    personalEscapedAdViews,
    personalReach: personalAdViews,
    personalViews: personalAdViews,
    personalActions,
    reconsidered,
  };
}

function aggregateContributionsByCampaign(contributions: ContributionRow[]) {
  const map = new Map<
    string,
    { campaignId: string; title: string; totalCents: number; currency: string }
  >();
  for (const c of contributions) {
    const campaignId = c.campaignId || c.campaign_id;
    if (!campaignId) continue;
    const prev = map.get(campaignId) || {
      campaignId,
      title: c.campaignTitle || c.campaign_title || 'Campaign',
      totalCents: 0,
      currency: c.currency || 'usd',
    };
    prev.totalCents += Number(c.amount_cents) || 0;
    map.set(campaignId, prev);
  }
  return [...map.values()];
}

export { aggregateContributionsByCampaign };

export function getCampaignNetRating(campaign: CampaignRow): number {
  const explicit = campaign?.net_rating ?? campaign?.netRating;
  const up = Number(campaign?.thumbs_up ?? campaign?.thumbsUp ?? 0) || 0;
  const down = Number(campaign?.thumbs_down ?? campaign?.thumbsDown ?? 0) || 0;
  if (up || down) return up - down;
  if (explicit != null && Number.isFinite(Number(explicit))) return Number(explicit);
  const trust = Number(campaign?.trust_score) || 75;
  return Math.round((trust - 50) / 5);
}

const VALID_RANGE_IDS = new Set(['all', '30d', '90d', '365d', 'month']);

export function normalizeImpactRangeId(raw: unknown): string {
  const id = String(raw || 'all').trim();
  return VALID_RANGE_IDS.has(id) ? id : 'all';
}

function getRecordDate(item: ContributionRow): Date | null {
  const v = item?.recordedAt;
  if (!v) return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function filterContributionsByTimeRange(
  contributions: ContributionRow[],
  rangeId: string
): ContributionRow[] {
  if (!rangeId || rangeId === 'all') return contributions;
  const now = Date.now();
  let cutoff = 0;
  if (rangeId === 'month') {
    const start = new Date();
    start.setDate(1);
    start.setHours(0, 0, 0, 0);
    cutoff = start.getTime();
  } else {
    const days = { '30d': 30, '90d': 90, '365d': 365 }[rangeId];
    if (!days) return contributions;
    cutoff = now - days * 86400000;
  }
  return contributions.filter((item) => {
    const d = getRecordDate(item);
    return d && d.getTime() >= cutoff;
  });
}

export function buildCumulativeTimeSeries(
  contributions: ContributionRow[],
  campaignsById: Record<string, CampaignRow>,
  insightsById: Record<string, InsightsPayload | null | undefined>,
  rangeId: string
) {
  const filtered = filterContributionsByTimeRange(contributions, rangeId);
  const sorted = [...filtered].sort((a, b) => {
    const da = getRecordDate(a)?.getTime() ?? 0;
    const db = getRecordDate(b)?.getTime() ?? 0;
    return da - db;
  });

  let cumAdViews = 0;
  let cumActions = 0;
  let cumShift = 0;
  const points: {
    label: string;
    reach: number;
    actions: number;
    perceptionShift: number;
    date?: string | null;
  }[] = [];

  for (const c of sorted) {
    const campaignId = c.campaignId || c.campaign_id;
    const campaign = campaignId ? campaignsById[campaignId] : undefined;
    if (!campaign || !campaignId) continue;

    const insights = insightsById[campaignId];
    const adViews = getCampaignAdViews(campaign, insights ?? undefined).value;
    const actions = getCampaignActions(campaign, insights ?? undefined).value;
    const totalContributionCents = getCampaignTotalContributionCents(campaign);
    const amountCents = Number(c.amount_cents) || 0;
    const share =
      totalContributionCents > 0
        ? amountCents / totalContributionCents
        : amountCents > 0
          ? 1
          : 0;
    const shift = getCampaignPerceptionShift(campaign);

    cumAdViews += Math.round(adViews * share);
    cumActions += Math.round(actions * share);
    cumShift += shift * share;

    const date = getRecordDate(c);
    points.push({
      date: date ? date.toISOString() : null,
      label: date
        ? date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '',
      reach: cumAdViews,
      actions: cumActions,
      perceptionShift: points.length ? cumShift / points.length : shift,
    });
  }

  if (points.length === 0) {
    return [{ label: 'Now', reach: 0, actions: 0, perceptionShift: 0 }];
  }
  return points;
}

export function buildCampaignTimeSeries(
  campaign: CampaignRow,
  insights: InsightsPayload | null | undefined,
  rangeId: string
) {
  const createdRaw =
    (campaign as Record<string, unknown>).created_at ??
    (campaign as Record<string, unknown>).createdAt;
  let created = new Date();
  if (typeof createdRaw === 'string' && createdRaw) {
    const d = new Date(createdRaw);
    if (!Number.isNaN(d.getTime())) created = d;
  }

  const adViews = getCampaignAdViews(campaign, insights ?? undefined).value;
  const actions = getCampaignActions(campaign, insights ?? undefined).value;
  const shift = getCampaignPerceptionShift(campaign);

  const buckets = rangeId === 'all' || rangeId === '365d' ? 6 : 4;
  const now = Date.now();
  const start = created.getTime();
  const span = Math.max(now - start, 86400000);

  const points = [];
  for (let i = 0; i <= buckets; i++) {
    const t = i / buckets;
    const eased = t * t * (3 - 2 * t);
    const d = new Date(start + span * t);
    points.push({
      label:
        i === buckets
          ? 'Now'
          : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      reach: Math.round(adViews * eased),
      actions: Math.round(actions * eased),
      perceptionShift: Math.round(shift * eased * 10) / 10,
      estimated: !insights,
    });
  }
  return points;
}

export interface CumulativeImpactSnapshot {
  totalContributedCents: number;
  peopleReached: number;
  personalViews: number;
  personalActions: number;
  avgPerceptionShift: number;
  avgTrustScore: number | null;
  campaignsBacked: number;
  reconsidered: number;
  topCampaignTitle: string | null;
  topCampaignThumbnail: string | null;
}

export function computeCumulativePersonalImpactSnapshot({
  contributions,
  campaignsById,
}: {
  contributions: ContributionRow[];
  campaignsById: Record<string, CampaignRow>;
}): CumulativeImpactSnapshot {
  const grouped = aggregateContributionsByCampaign(contributions);

  let totalCents = 0;
  let totalReach = 0;
  let totalViews = 0;
  let totalActions = 0;
  let shiftSum = 0;
  let trustSum = 0;
  let campaignCount = 0;
  let reconsidered = 0;
  let topCampaignTitle: string | null = null;
  let topCampaignThumbnail: string | null = null;
  let topCents = 0;

  for (const g of grouped) {
    const campaign = campaignsById[g.campaignId];
    if (!campaign) continue;

    totalCents += g.totalCents;
    const adViews = getCampaignAdViews(campaign);
    const outOfBubble = getCampaignOutOfBubbleAdViews(campaign);
    const escaped = getCampaignEscapedAdViews(campaign);
    const actions = getCampaignActions(campaign);
    const totalContributionCents = getCampaignTotalContributionCents(campaign);
    const shift = getCampaignPerceptionShift(campaign);
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

    totalReach += attr.personalReach;
    totalViews += attr.personalViews;
    totalActions += attr.personalActions;
    reconsidered += attr.reconsidered;
    shiftSum += shift;
    if (trust) trustSum += trust;
    campaignCount += 1;

    if (g.totalCents > topCents) {
      topCents = g.totalCents;
      topCampaignTitle = g.title || campaign.title || 'Campaign';
      topCampaignThumbnail = campaign.thumbnail_url ?? null;
    }
  }

  return {
    totalContributedCents: totalCents,
    peopleReached: totalReach,
    personalViews: totalViews,
    personalActions: totalActions,
    avgPerceptionShift: campaignCount ? Math.round((shiftSum / campaignCount) * 10) / 10 : 0,
    avgTrustScore: campaignCount && trustSum ? Math.round(trustSum / campaignCount) : null,
    campaignsBacked: campaignCount,
    reconsidered,
    topCampaignTitle,
    topCampaignThumbnail,
  };
}

export interface PerCampaignImpactSnapshot {
  totalContributedCents: number;
  personalReach: number;
  personalViews: number;
  personalActions: number;
  reconsidered: number;
  sharePct: number;
  estimatedPerceptionShift: number;
  actualPerceptionShift: number | null;
  campaignTitle: string;
  campaignThumbnail: string | null;
}

export function computePerCampaignPersonalImpactSnapshot({
  contributions,
  campaign,
}: {
  contributions: ContributionRow[];
  campaign: CampaignRow;
}): PerCampaignImpactSnapshot | null {
  const campaignId = campaign?.id;
  if (!campaignId) return null;

  const filtered = contributions.filter((c) => (c.campaignId || c.campaign_id) === campaignId);
  if (!filtered.length) return null;

  const totalCents = filtered.reduce((s, c) => s + (Number(c.amount_cents) || 0), 0);
  const adViews = getCampaignAdViews(campaign);
  const outOfBubble = getCampaignOutOfBubbleAdViews(campaign);
  const escaped = getCampaignEscapedAdViews(campaign);
  const actions = getCampaignActions(campaign);
  const shift = getCampaignPerceptionShift(campaign);
  const actualShift = campaign?.perception_shift_actual ?? campaign?.perceptionShiftActual;
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
    personalReach: attr.personalReach,
    personalViews: attr.personalViews,
    personalActions: attr.personalActions,
    reconsidered: attr.reconsidered,
    sharePct: attr.sharePct,
    estimatedPerceptionShift: shift,
    actualPerceptionShift: actualShift != null ? Number(actualShift) : null,
    campaignTitle: campaign.title || 'Campaign',
    campaignThumbnail: campaign.thumbnail_url ?? null,
  };
}

export function formatCompactNumber(n: number): string {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (v >= 10_000) return `${Math.round(v / 1000)}K`;
  if (v >= 1000) return `${(v / 1000).toFixed(1).replace(/\.0$/, '')}K`;
  return String(Math.round(v));
}
