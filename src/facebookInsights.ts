/**
 * Meta (Facebook) ad insights for impact reports.
 * Field list aligned with the Meta metrics spec (dimensions, breakdowns, metrics, actions).
 */
import type { Firestore } from 'firebase-admin/firestore';
import {
  computeEngagementActions,
  computePerceptionShiftFromMetaActions,
} from './impactKpi';

/** Core metrics fetched at ad level for impact reporting. */
export const META_IMPACT_INSIGHT_FIELDS = [
  'impressions',
  'reach',
  'frequency',
  'inline_link_clicks',
  'clicks',
  'spend',
  'cpm',
  'cpc',
  'ctr',
  'cost_per_inline_link_click',
  'objective',
  'results',
  'result_rate',
  'video_p75_watched_actions',
  'actions',
] as const;

/** Audience / delivery breakdowns stored per campaign. */
export const META_IMPACT_BREAKDOWNS = ['age', 'gender', 'publisher_platform', 'dma'] as const;

export type MetaImpactBreakdown = (typeof META_IMPACT_BREAKDOWNS)[number];

/**
 * Default Meta targeting used when publishing Unravel ads.
 * Kept in sync with `publishFacebookAdForCampaign` in index.ts — used for
 * Estimated Audience Size (`/reachestimate`) when an ad-set targeting fetch fails.
 */
export const DEFAULT_FACEBOOK_TARGETING = {
  geo_locations: { countries: ['US'] },
  publisher_platforms: ['facebook', 'audience_network'],
  facebook_positions: ['feed'],
} as const;

export interface AudienceSizeEstimate {
  lowerBound: number;
  upperBound: number;
  estimateReady: boolean;
}

export interface MetaActionRow {
  action_type: string;
  value: number;
}

export interface NormalizedFacebookInsights {
  impressions: number;
  reach: number;
  frequency: number;
  inlineLinkClicks: number;
  clicks: number;
  spend: number;
  cpm: number;
  cpc: number;
  ctr: number;
  costPerInlineLinkClick: number;
  objective: string | null;
  objectiveResults: number;
  objectiveResultRate: number;
  videoP75Watched: number;
  postEngagement: number;
  videoViews: number;
  engagementActions: number;
  perceptionShiftScore: number;
  perceptionShiftSource: 'actual' | 'estimated';
  isVideoAd: boolean;
  totalActions: number;
  actions: MetaActionRow[];
  raw: Record<string, unknown>;
}

export interface FacebookInsightsBreakdownRow {
  breakdownValue: string;
  impressions: number;
  reach: number;
  inlineLinkClicks: number;
  clicks: number;
  spend: number;
}

function toNumber(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function insightRowData(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') return {};
  const r = row as { _data?: Record<string, unknown> };
  return r._data ?? (row as Record<string, unknown>);
}

function parseActions(raw: unknown): MetaActionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const actionType = String(row.action_type || '').trim();
      if (!actionType) return null;
      return { action_type: actionType, value: toNumber(row.value) };
    })
    .filter((item): item is MetaActionRow => Boolean(item));
}

function sumActionValues(actions: MetaActionRow[]): number {
  return actions.reduce((sum, row) => sum + row.value, 0);
}

function parseVideoP75(raw: unknown): number {
  const actions = parseActions(raw);
  return actions.reduce((sum, row) => sum + row.value, 0);
}

function getActionValue(actions: MetaActionRow[], type: string): number {
  const key = type.toLowerCase();
  const row = actions.find((a) => a.action_type.toLowerCase() === key);
  return row?.value ?? 0;
}

/** Normalize a single Meta insights API row into impact-report numbers. */
export function normalizeFacebookInsightRow(row: unknown): NormalizedFacebookInsights {
  const data = insightRowData(row);
  const actions = parseActions(data.actions);
  const inlineLinkClicks = toNumber(data.inline_link_clicks);
  const clicks = toNumber(data.clicks) || inlineLinkClicks;
  const impressions = toNumber(data.impressions);
  const videoP75Watched = parseVideoP75(data.video_p75_watched_actions);
  const postEngagement = getActionValue(actions, 'post_engagement');
  const videoViews = getActionValue(actions, 'video_view');
  const engagementActions = computeEngagementActions(actions, {
    storedPostEngagement: postEngagement,
    storedVideoViews: videoViews,
    fallbackInlineClicks: inlineLinkClicks,
  });
  const perception = computePerceptionShiftFromMetaActions(actions, impressions, videoP75Watched);
  const totalActions = engagementActions || sumActionValues(actions) || clicks;

  return {
    impressions,
    reach: toNumber(data.reach),
    frequency: toNumber(data.frequency),
    inlineLinkClicks,
    clicks,
    spend: toNumber(data.spend),
    cpm: toNumber(data.cpm),
    cpc: toNumber(data.cpc),
    ctr: toNumber(data.ctr),
    costPerInlineLinkClick: toNumber(data.cost_per_inline_link_click),
    objective: typeof data.objective === 'string' ? data.objective : null,
    objectiveResults: toNumber(data.results),
    objectiveResultRate: toNumber(data.result_rate),
    videoP75Watched,
    postEngagement,
    videoViews,
    engagementActions,
    perceptionShiftScore: perception.score,
    perceptionShiftSource: perception.source,
    isVideoAd: perception.signals.isVideoAd,
    totalActions,
    actions,
    raw: data,
  };
}

/** Map normalized insights to Firestore campaign fields. */
export function insightsToCampaignPatch(summary: NormalizedFacebookInsights): Record<string, unknown> {
  return {
    facebook_reach: summary.reach,
    facebook_impressions: summary.impressions,
    facebook_clicks: summary.clicks,
    facebook_inline_link_clicks: summary.inlineLinkClicks,
    facebook_frequency: summary.frequency,
    facebook_spend: summary.spend,
    facebook_cpm: summary.cpm,
    facebook_cpc: summary.cpc,
    facebook_ctr: summary.ctr,
    facebook_cost_per_inline_link_click: summary.costPerInlineLinkClick,
    facebook_objective: summary.objective,
    facebook_objective_results: summary.objectiveResults,
    facebook_objective_result_rate: summary.objectiveResultRate,
    facebook_video_p75_watched: summary.videoP75Watched,
    facebook_post_engagement: summary.postEngagement,
    facebook_video_views: summary.videoViews,
    facebook_engagement_actions: summary.engagementActions,
    facebook_perception_shift_score: summary.perceptionShiftScore,
    facebook_perception_shift_source: summary.perceptionShiftSource,
    facebook_is_video_ad: summary.isVideoAd,
    facebook_total_actions: summary.totalActions,
    facebook_actions: summary.actions,
    facebook_insights_updated_at: new Date().toISOString(),
  };
}

/** Persist Meta Estimated Audience Size bounds (lower/upper) for saturation. */
export function audienceSizeToCampaignPatch(estimate: AudienceSizeEstimate): Record<string, unknown> {
  return {
    facebook_audience_size_lower_bound: estimate.lowerBound,
    facebook_audience_size_upper_bound: estimate.upperBound,
    facebook_audience_size_estimate_ready: estimate.estimateReady,
    facebook_audience_size_updated_at: new Date().toISOString(),
  };
}

function insightPayloadData(row: unknown): Record<string, unknown> {
  if (!row || typeof row !== 'object') return {};
  const r = row as { _data?: Record<string, unknown>; data?: Record<string, unknown> };
  if (r._data && typeof r._data === 'object') return r._data;
  if (r.data && typeof r.data === 'object' && !Array.isArray(r.data)) return r.data;
  return row as Record<string, unknown>;
}

function parseAudienceSizeEstimate(raw: unknown): AudienceSizeEstimate | null {
  const data = insightPayloadData(raw);
  const nested =
    data.data && typeof data.data === 'object' && !Array.isArray(data.data)
      ? (data.data as Record<string, unknown>)
      : data;
  const lower = toNumber(nested.users_lower_bound ?? nested.estimate_mau_lower_bound);
  const upper = toNumber(nested.users_upper_bound ?? nested.estimate_mau_upper_bound);
  // Meta returns -1 when the estimate is unavailable for the audience.
  if (!(lower > 0) || !(upper > 0)) return null;
  return {
    lowerBound: Math.min(lower, upper),
    upperBound: Math.max(lower, upper),
    estimateReady: nested.estimate_ready !== false,
  };
}

/**
 * Meta Estimated Audience Size via Ad Account `/reachestimate`.
 * Uses a direct Graph call — the business SDK Cursor expects `data` to be an
 * array, but reachestimate returns a single object (`users_lower_bound` /
 * `users_upper_bound`), which crashes with `response.data.map is not a function`.
 */
export async function fetchAudienceSizeEstimate(
  accessToken: string,
  targetingSpec: Record<string, unknown> = DEFAULT_FACEBOOK_TARGETING as unknown as Record<
    string,
    unknown
  >
): Promise<AudienceSizeEstimate | null> {
  const adAccountId = process.env.FACEBOOK_AD_ACCOUNT_ID?.trim();
  if (!adAccountId) {
    throw new Error('Facebook is not configured (FACEBOOK_AD_ACCOUNT_ID)');
  }

  const accountPath = adAccountId.startsWith('act_') ? adAccountId : `act_${adAccountId}`;
  const params = new URLSearchParams({
    targeting_spec: JSON.stringify(targetingSpec),
    access_token: accessToken,
  });
  const url = `https://graph.facebook.com/v21.0/${accountPath}/reachestimate?${params.toString()}`;
  const res = await fetch(url);
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok) {
    const errObj = json?.error as { message?: string } | undefined;
    throw new Error(errObj?.message || `Meta reachestimate failed (${res.status})`);
  }

  return parseAudienceSizeEstimate(json);
}

/** Best-effort audience size fetch — never throws. */
export async function fetchAudienceSizeEstimateSafe(
  accessToken: string,
  targetingSpec?: Record<string, unknown>
): Promise<AudienceSizeEstimate | null> {
  try {
    return await fetchAudienceSizeEstimate(accessToken, targetingSpec);
  } catch (err) {
    console.warn(
      'Facebook audience size estimate failed:',
      err instanceof Error ? err.message : err
    );
    return null;
  }
}

function normalizeBreakdownRow(
  row: unknown,
  breakdownKey: MetaImpactBreakdown
): FacebookInsightsBreakdownRow | null {
  const data = insightRowData(row);
  const breakdownValue = String(data[breakdownKey] ?? '').trim();
  if (!breakdownValue) return null;
  return {
    breakdownValue,
    impressions: toNumber(data.impressions),
    reach: toNumber(data.reach),
    inlineLinkClicks: toNumber(data.inline_link_clicks),
    clicks: toNumber(data.clicks) || toNumber(data.inline_link_clicks),
    spend: toNumber(data.spend),
  };
}

async function fetchAdInsightRows(
  adId: string,
  accessToken: string,
  options: { breakdown?: MetaImpactBreakdown; fields?: readonly string[] } = {}
): Promise<Record<string, unknown>[]> {
  const bizSdk = require('facebook-nodejs-business-sdk');
  bizSdk.FacebookAdsApi.init(accessToken);
  const Ad = bizSdk.Ad;
  const ad = new Ad(adId);
  const fields = options.fields ?? META_IMPACT_INSIGHT_FIELDS;
  const params: Record<string, unknown> = { date_preset: 'maximum' };
  if (options.breakdown) {
    params.breakdowns = [options.breakdown];
  }
  const insights = await ad.getInsights([...fields], params);
  const rows = Array.isArray(insights) ? insights : insights ? [insights] : [];
  return rows.map((r: unknown) => insightRowData(r));
}

export async function fetchFacebookAdInsights(
  adId: string,
  accessToken: string
): Promise<{ summary: NormalizedFacebookInsights; rows: Record<string, unknown>[] }> {
  const dataRows = await fetchAdInsightRows(adId, accessToken);
  const summary = normalizeFacebookInsightRow(dataRows[0] ?? {});
  return { summary, rows: dataRows };
}

export async function fetchFacebookAdInsightBreakdown(
  adId: string,
  accessToken: string,
  breakdown: MetaImpactBreakdown
): Promise<FacebookInsightsBreakdownRow[]> {
  const fields = ['impressions', 'reach', 'inline_link_clicks', 'clicks', 'spend'];
  const dataRows = await fetchAdInsightRows(adId, accessToken, { breakdown, fields });
  return dataRows
    .map((row) => normalizeBreakdownRow(row, breakdown))
    .filter((row): row is FacebookInsightsBreakdownRow => Boolean(row));
}

export async function persistCampaignFacebookInsights(
  db: Firestore,
  campaignId: string,
  summary: NormalizedFacebookInsights,
  breakdowns?: Partial<Record<MetaImpactBreakdown, FacebookInsightsBreakdownRow[]>>,
  audienceSize?: AudienceSizeEstimate | null
): Promise<void> {
  const patch: Record<string, unknown> = {
    ...insightsToCampaignPatch(summary),
    ...(audienceSize ? audienceSizeToCampaignPatch(audienceSize) : {}),
  };
  await db.collection('campaigns').doc(campaignId).update(patch);

  if (!breakdowns) return;
  const batch = db.batch();
  const updatedAt = new Date().toISOString();
  for (const [breakdownType, rows] of Object.entries(breakdowns)) {
    if (!rows?.length) continue;
    const ref = db
      .collection('campaigns')
      .doc(campaignId)
      .collection('facebook_insight_breakdowns')
      .doc(breakdownType);
    batch.set(ref, { breakdownType, rows, updatedAt }, { merge: true });
  }
  await batch.commit();
}

export interface SyncCampaignFacebookInsightsResult {
  campaignId: string;
  facebookAdId: string;
  summary: NormalizedFacebookInsights;
  breakdowns: Partial<Record<MetaImpactBreakdown, FacebookInsightsBreakdownRow[]>>;
  audienceSize: AudienceSizeEstimate | null;
}

export async function syncCampaignFacebookInsights(
  db: Firestore,
  campaignId: string,
  options: { includeBreakdowns?: boolean; includeAudienceSize?: boolean } = {}
): Promise<SyncCampaignFacebookInsightsResult> {
  const accessToken = process.env.FACEBOOK_ACCESS_TOKEN?.trim();
  if (!accessToken) {
    throw new Error('Facebook is not configured (FACEBOOK_ACCESS_TOKEN)');
  }

  const doc = await db.collection('campaigns').doc(campaignId).get();
  if (!doc.exists) {
    throw new Error('Campaign not found');
  }
  const data = doc.data() as Record<string, unknown>;
  const facebookAdId = String(data.facebook_ad_id || '').trim();
  if (!facebookAdId) {
    throw new Error('Campaign has not been published to Facebook');
  }

  const { summary } = await fetchFacebookAdInsights(facebookAdId, accessToken);
  const breakdowns: Partial<Record<MetaImpactBreakdown, FacebookInsightsBreakdownRow[]>> = {};

  if (options.includeBreakdowns !== false) {
    for (const breakdown of META_IMPACT_BREAKDOWNS) {
      try {
        breakdowns[breakdown] = await fetchFacebookAdInsightBreakdown(
          facebookAdId,
          accessToken,
          breakdown
        );
      } catch (err) {
        console.warn(
          `Facebook breakdown ${breakdown} failed for campaign ${campaignId}:`,
          err instanceof Error ? err.message : err
        );
      }
    }
  }

  const audienceSize =
    options.includeAudienceSize === false
      ? null
      : await fetchAudienceSizeEstimateSafe(accessToken);

  await persistCampaignFacebookInsights(db, campaignId, summary, breakdowns, audienceSize);
  return { campaignId, facebookAdId, summary, breakdowns, audienceSize };
}

export async function syncAllPublishedCampaignFacebookInsights(
  db: Firestore,
  options: { limit?: number; includeBreakdowns?: boolean } = {}
): Promise<{
  synced: SyncCampaignFacebookInsightsResult[];
  skipped: { campaignId: string; reason: string }[];
  errors: { campaignId: string; error: string }[];
}> {
  const limit = Math.max(1, Math.min(200, Number(options.limit) || 50));
  const snapshot = await db.collection('campaigns').get();
  const candidates = snapshot.docs
    .filter((doc) => {
      const data = doc.data() as Record<string, unknown>;
      return typeof data.facebook_ad_id === 'string' && data.facebook_ad_id.trim();
    })
    .slice(0, limit);

  const synced: SyncCampaignFacebookInsightsResult[] = [];
  const skipped: { campaignId: string; reason: string }[] = [];
  const errors: { campaignId: string; error: string }[] = [];

  for (const doc of candidates) {
    try {
      synced.push(
        await syncCampaignFacebookInsights(db, doc.id, {
          includeBreakdowns: options.includeBreakdowns,
        })
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('not been published')) {
        skipped.push({ campaignId: doc.id, reason: message });
      } else {
        errors.push({ campaignId: doc.id, error: message });
      }
    }
  }

  return { synced, skipped, errors };
}

const STALE_INSIGHTS_MS = 6 * 60 * 60 * 1000;

/** Refresh stored insights when missing or older than 6 hours. Best-effort; never throws. */
export async function refreshCampaignFacebookInsightsIfStale(
  db: Firestore,
  campaignId: string,
  campaign: Record<string, unknown>
): Promise<boolean> {
  if (!process.env.FACEBOOK_ACCESS_TOKEN?.trim()) return false;
  if (!campaign.facebook_ad_id) return false;

  const updatedAt = campaign.facebook_insights_updated_at;
  if (typeof updatedAt === 'string' && updatedAt) {
    const age = Date.now() - new Date(updatedAt).getTime();
    if (Number.isFinite(age) && age < STALE_INSIGHTS_MS) return false;
  }

  try {
    await syncCampaignFacebookInsights(db, campaignId, { includeBreakdowns: false });
    return true;
  } catch (err) {
    console.warn(
      `Stale insights refresh failed for campaign ${campaignId}:`,
      err instanceof Error ? err.message : err
    );
    return false;
  }
}
