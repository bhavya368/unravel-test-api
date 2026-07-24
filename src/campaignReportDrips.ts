import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  computePersonalAttribution,
  getCampaignActions,
  getCampaignBudgetCents,
  getCampaignPerceptionShift,
  getCampaignReach,
  getCampaignViews,
  REACH_PER_DOLLAR,
  type CampaignRow,
} from './impactMetrics';
import { getCampaignTotalContributionCents } from './impactKpi';
import { refreshCampaignFacebookInsightsIfStale } from './facebookInsights';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_LAUNCH_LEAD_HOURS = 24;
const DEFAULT_LIMIT = 50;

export type CampaignReportStage = 'launch' | 'mid' | 'recap';

const ALL_STAGES: CampaignReportStage[] = ['launch', 'mid', 'recap'];

interface CampaignReportDripOptions {
  dryRun?: boolean;
  limit?: number;
  nowMs?: number;
  usersDb?: Firestore;
  /** Only process these campaign ids (case-sensitive Firestore ids). */
  campaignIds?: string[];
  /** Only consider these stages when picking the next due stage. */
  stages?: CampaignReportStage[];
  /**
   * Force this stage for the filtered campaign(s), ignoring timing windows.
   * Still skips if that stage was already marked sent. Requires campaignIds.
   */
  forceStage?: CampaignReportStage;
}

interface RecipientProfile {
  email: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
}

interface CampaignTiming {
  startMs: number | null;
  endMs: number | null;
  midpointMs: number | null;
  durationDays: number | null;
  elapsedDays: number | null;
  percentComplete: number | null;
}

/** Base campaign fields shared by all report stages. */
interface CampaignReport {
  stage: CampaignReportStage;
  stageLabel: string;
  metricName: string;
  campaignId: string;
  campaignTitle: string;
  campaign_name: string;
  campaignUrl: string;
  impactUrl: string;
  thumbnailUrl: string | null;
  /** Facebook ad creative fields (same fallbacks as AdPreviewCard on the site). */
  ad_headline: string;
  ad_primary_text: string | null;
  ad_image_url: string | null;
  category: string | null;
  status: string | null;
  fundingGoalDollars: number;
  fundingRaisedDollars: number;
  budgetDollars: number;
  percentFunded: number | null;
  reach: number;
  reachSource: string;
  views: number;
  actions: number;
  actionsSource: string;
  perceptionShift: number;
  netRating: number | null;
  startAt: string | null;
  endAt: string | null;
  durationDays: number | null;
  elapsedDays: number | null;
  percentComplete: number | null;
  generatedAt: string;
  pooled_amount: string;
  total_backers: number;
  projected_collective_reach: number;
}

/** Per-backer payload for launch / mid / recap (Klaviyo template bind names). */
interface BackerStageReport extends CampaignReport {
  contribution_amount: string;
  projected_reach: number;
  contributionAmountCents: number;
  /** Mid: personal reach attributed so far. */
  reached_so_far?: number;
  /** Mid: personal actions attributed so far. */
  actions_so_far?: number;
  /** Mid: personal reached / projected × 100 (0–100). */
  percent_to_goal?: number;
  /** Mid: campaign reach so far. */
  collective_reach_so_far?: number;
  /** Mid: perception shift % (alias of perceptionShift). */
  perception_shift_mid?: number;
  /** Recap: final personal attributed reach. */
  final_reach?: number;
  /** Recap: personal actions attributed. */
  actions_sparked?: number;
  /** Recap / shared: perception shift % (snake_case for templates). */
  perception_shift?: number;
  /** Recap: final campaign reach. */
  final_collective_reach?: number;
  /** Recap: pooled spend display string. */
  total_spend?: string;
}

interface CampaignBacker {
  email: string;
  firstName?: string;
  lastName?: string;
  fullName?: string;
  contributionCents: number;
  donorUid?: string;
}

interface RunItem {
  campaignId: string;
  title: string;
  stage?: CampaignReportStage;
  metricName?: string;
  email?: string;
  emails?: string[];
  recipientCount?: number;
  sent?: boolean;
  dryRun?: boolean;
  skipped?: string;
  error?: string;
  /** Dry-run only: first pending backer's event properties (for Klaviyo template checks). */
  sampleEvent?: BackerStageReport;
}

function timestampToMs(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === 'object') {
    if ('_seconds' in value) {
      const s = Number((value as { _seconds?: unknown })._seconds);
      const n = Number((value as { _nanoseconds?: unknown })._nanoseconds ?? 0);
      return Number.isFinite(s) ? s * 1000 + Math.floor(n / 1e6) : null;
    }
    if ('seconds' in value) {
      const s = Number((value as { seconds?: unknown }).seconds);
      const n = Number((value as { nanoseconds?: unknown }).nanoseconds ?? 0);
      return Number.isFinite(s) ? s * 1000 + Math.floor(n / 1e6) : null;
    }
    return null;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  const t = new Date(String(value)).getTime();
  return Number.isNaN(t) ? null : t;
}

function getCampaignStartMs(campaign: Record<string, unknown>): number | null {
  return (
    timestampToMs(campaign.campaign_starts_at) ??
    timestampToMs(campaign.createdAt) ??
    timestampToMs(campaign.creation_date) ??
    timestampToMs(campaign.created_at)
  );
}

function getCampaignDurationMs(campaign: Record<string, unknown>): number | null {
  const days = Number(campaign.duration_days);
  const hours = Number(campaign.duration_hours);
  const hasDays = Number.isFinite(days) && days > 0;
  const hasHours = Number.isFinite(hours) && hours > 0;
  if (!hasDays && !hasHours) return null;
  return (hasDays ? days * DAY_MS : 0) + (hasHours ? hours * HOUR_MS : 0);
}

function getCampaignEndMs(campaign: Record<string, unknown>): number | null {
  const durationMs = getCampaignDurationMs(campaign);
  if (durationMs == null) return timestampToMs(campaign.campaign_ends_at);
  const startMs = getCampaignStartMs(campaign);
  return startMs == null ? null : startMs + durationMs;
}

function buildTiming(campaign: Record<string, unknown>, nowMs: number): CampaignTiming {
  const startMs = getCampaignStartMs(campaign);
  const endMs = getCampaignEndMs(campaign);
  const durationMs = startMs != null && endMs != null ? Math.max(0, endMs - startMs) : null;
  const elapsedMs = startMs != null ? Math.max(0, nowMs - startMs) : null;
  return {
    startMs,
    endMs,
    midpointMs: startMs != null && durationMs != null ? startMs + durationMs / 2 : null,
    durationDays: durationMs != null ? Math.round((durationMs / DAY_MS) * 10) / 10 : null,
    elapsedDays: elapsedMs != null ? Math.round((elapsedMs / DAY_MS) * 10) / 10 : null,
    percentComplete:
      durationMs && elapsedMs != null
        ? Math.max(0, Math.min(100, Math.round((elapsedMs / durationMs) * 1000) / 10))
        : null,
  };
}

function stageIsSent(campaign: Record<string, unknown>, stage: CampaignReportStage): boolean {
  const drips = campaign.campaign_report_drips as Record<string, unknown> | undefined;
  const stageState = drips?.[stage] as Record<string, unknown> | undefined;
  return Boolean(stageState?.sentAt);
}

function getStageRecipientEmails(campaign: Record<string, unknown>, stage: CampaignReportStage): string[] {
  const drips = campaign.campaign_report_drips as Record<string, unknown> | undefined;
  const stageState = drips?.[stage] as Record<string, unknown> | undefined;
  const raw = stageState?.recipientEmails;
  if (!Array.isArray(raw)) return [];
  return raw.map((e) => String(e).trim().toLowerCase()).filter(Boolean);
}

function nextDueStage(
  campaign: Record<string, unknown>,
  timing: CampaignTiming,
  nowMs: number,
  allowedStages: Set<CampaignReportStage> = new Set(ALL_STAGES)
): CampaignReportStage | null {
  const status = String(campaign.status || '').trim();
  if (status !== 'Approved' && status !== 'Completed') return null;

  const launchLeadMs =
    Math.max(0, Number(process.env.KLAVIYO_REPORT_LAUNCH_LEAD_HOURS ?? DEFAULT_LAUNCH_LEAD_HOURS)) * HOUR_MS;
  const launchDueMs = (timing.startMs ?? nowMs) - launchLeadMs;
  if (
    allowedStages.has('launch') &&
    !stageIsSent(campaign, 'launch') &&
    nowMs >= launchDueMs
  ) {
    return 'launch';
  }

  if (
    allowedStages.has('mid') &&
    timing.midpointMs != null &&
    !stageIsSent(campaign, 'mid') &&
    nowMs >= timing.midpointMs
  ) {
    return 'mid';
  }

  if (
    allowedStages.has('recap') &&
    !stageIsSent(campaign, 'recap') &&
    (status === 'Completed' || (timing.endMs != null && nowMs >= timing.endMs))
  ) {
    return 'recap';
  }

  return null;
}

function resolveStage(
  campaign: Record<string, unknown>,
  timing: CampaignTiming,
  nowMs: number,
  options: Pick<CampaignReportDripOptions, 'stages' | 'forceStage'>
): CampaignReportStage | null {
  const allowed = new Set(
    (options.stages?.length ? options.stages : ALL_STAGES).filter((s) =>
      ALL_STAGES.includes(s)
    )
  );
  if (allowed.size === 0) return null;

  if (options.forceStage) {
    if (!allowed.has(options.forceStage)) return null;
    const status = String(campaign.status || '').trim();
    if (status !== 'Approved' && status !== 'Completed') return null;
    if (stageIsSent(campaign, options.forceStage)) return null;
    return options.forceStage;
  }

  return nextDueStage(campaign, timing, nowMs, allowed);
}

function normalizeCampaignIds(raw: unknown): string[] {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return [...new Set(list.map((id) => String(id).trim()).filter(Boolean))];
}

function normalizeStages(raw: unknown): CampaignReportStage[] {
  if (raw == null) return [];
  const list = Array.isArray(raw) ? raw : String(raw).split(',');
  return [
    ...new Set(
      list
        .map((s) => String(s).trim().toLowerCase())
        .filter((s): s is CampaignReportStage => ALL_STAGES.includes(s as CampaignReportStage))
    ),
  ];
}

export function parseCampaignReportDripRequest(input: {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
}): {
  dryRun: boolean;
  limit: number | undefined;
  campaignIds: string[];
  stages: CampaignReportStage[];
  forceStage: CampaignReportStage | undefined;
} {
  const body = input.body ?? {};
  const query = input.query ?? {};
  const dryRun =
    body.dryRun === true ||
    query.dryRun === 'true' ||
    query.dryRun === '1' ||
    body.dryRun === 'true' ||
    body.dryRun === '1';
  const limitRaw = body.limit ?? query.limit;
  const limit = limitRaw != null && limitRaw !== '' ? Number(limitRaw) : undefined;
  const campaignIds = normalizeCampaignIds(
    body.campaignIds ?? body.campaignId ?? query.campaignIds ?? query.campaignId
  );
  const stages = normalizeStages(body.stages ?? body.stage ?? query.stages ?? query.stage);
  const forceRaw = String(body.forceStage ?? query.forceStage ?? '').trim().toLowerCase();
  const forceStage = ALL_STAGES.includes(forceRaw as CampaignReportStage)
    ? (forceRaw as CampaignReportStage)
    : undefined;

  return { dryRun, limit, campaignIds, stages, forceStage };
}

function asDollars(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function formatUsdFromCents(cents: number): string {
  const dollars = Math.max(0, cents) / 100;
  if (Number.isInteger(dollars)) return `$${dollars.toLocaleString('en-US')}`;
  return `$${dollars.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function formatUsdFromDollars(dollars: number): string {
  const n = Math.max(0, Number(dollars) || 0);
  if (Number.isInteger(n)) return `$${n.toLocaleString('en-US')}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getFrontendOrigin(): string {
  const raw =
    process.env.FRONTEND_ORIGIN ||
    process.env.FRONTEND_BASE_URL ||
    'http://localhost:5173';
  return raw.split(',')[0].trim().replace(/\/$/, '');
}

function getApiPublicBase(): string {
  const raw =
    process.env.API_PUBLIC_URL ||
    process.env.API_BASE_URL ||
    'https://unravel-api-297290600394.us-central1.run.app';
  return raw.split(',')[0].trim().replace(/\/$/, '');
}

/** Absolutize Firestore image paths for email clients (same rules as OG/thumbnail resolve). */
function resolveCampaignImageUrl(raw: unknown): string | null {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return null;
  if (s.startsWith('http://') || s.startsWith('https://') || s.startsWith('data:')) return s;
  const apiBase = getApiPublicBase();
  if (s.startsWith('/')) return `${apiBase}${s}`;
  if (!s.includes('/') && !s.includes(':')) return `${apiBase}/images/${s}`;
  return null;
}

function stripHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getCampaignAdFields(campaign: Record<string, unknown>, campaignTitle: string): {
  ad_headline: string;
  ad_primary_text: string | null;
  ad_image_url: string | null;
  thumbnailUrl: string | null;
} {
  const adHeadline = String(campaign.ad_headline || '').trim();
  const adPrimary = String(campaign.ad_primary_text || '').trim();
  const shortDescription = stripHtml(campaign.short_description ?? campaign.tagline ?? campaign.description);
  const thumbnailUrl = resolveCampaignImageUrl(campaign.thumbnail_url);
  const adImageUrl = resolveCampaignImageUrl(campaign.ad_image_url) ?? thumbnailUrl;
  return {
    ad_headline: adHeadline || campaignTitle,
    ad_primary_text: adPrimary || shortDescription || null,
    ad_image_url: adImageUrl,
    thumbnailUrl,
  };
}

function getCreatorProfileFromCampaign(campaign: Record<string, unknown>): RecipientProfile | null {
  const email = String(campaign.creator_email || '').trim().toLowerCase();
  if (!email) return null;
  const firstName = String(campaign.creator_first_name || '').trim();
  const lastName = String(campaign.creator_last_name || '').trim();
  const fullName = String(campaign.creator_name || campaign.creator || '').trim();
  return {
    email,
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(fullName ? { fullName } : {}),
  };
}

async function getCreatorProfile(
  campaign: Record<string, unknown>,
  usersDb?: Firestore
): Promise<RecipientProfile | null> {
  const snapshotProfile = getCreatorProfileFromCampaign(campaign);
  if (snapshotProfile || !usersDb) return snapshotProfile;

  const uid = String(campaign.created_by || campaign.created_by_uid || '').trim();
  if (!uid) return null;

  const userDoc = await usersDb.collection('users').doc(uid).get();
  if (!userDoc.exists) return null;

  const user = userDoc.data() as Record<string, unknown>;
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) return null;

  const firstName = String(user.firstName || '').trim();
  const lastName = String(user.lastName || '').trim();
  const fullName = `${firstName} ${lastName}`.trim();
  return {
    email,
    ...(firstName ? { firstName } : {}),
    ...(lastName ? { lastName } : {}),
    ...(fullName ? { fullName } : {}),
  };
}

function metricNameForStage(stage: CampaignReportStage): string {
  if (stage === 'launch') return 'Unravel Campaign Launch Report';
  if (stage === 'mid') return 'Unravel Campaign Mid Campaign Report';
  return 'Unravel Campaign Recap Report';
}

function stageLabel(stage: CampaignReportStage): string {
  if (stage === 'launch') return 'Launch report';
  if (stage === 'mid') return 'Progress report';
  return 'Recap report';
}

function buildReport(
  campaignId: string,
  campaign: Record<string, unknown>,
  stage: CampaignReportStage,
  timing: CampaignTiming,
  nowMs: number,
  totalBackers: number
): CampaignReport {
  const campaignRow = { id: campaignId, ...campaign } as CampaignRow;
  const reach = getCampaignReach(campaignRow);
  const views = getCampaignViews(campaignRow, null, reach);
  const actions = getCampaignActions(campaignRow);
  const fundingGoalDollars = asDollars(campaign.funding_goal);
  const fundingRaisedDollars = asDollars(
    campaign.funding_current ?? campaign.amount_raised ?? campaign.funding_raised
  );
  const budgetDollars = Math.round((getCampaignBudgetCents(campaignRow) / 100) * 100) / 100;
  const frontendOrigin = getFrontendOrigin();
  const campaignTitle = String(campaign.title || 'Campaign');
  const adFields = getCampaignAdFields(campaign, campaignTitle);

  return {
    stage,
    stageLabel: stageLabel(stage),
    metricName: metricNameForStage(stage),
    campaignId,
    campaignTitle,
    campaign_name: campaignTitle,
    campaignUrl: `${frontendOrigin}/campaign/${encodeURIComponent(campaignId)}`,
    impactUrl: `${frontendOrigin}/campaign/${encodeURIComponent(campaignId)}/impact`,
    thumbnailUrl: adFields.thumbnailUrl,
    ad_headline: adFields.ad_headline,
    ad_primary_text: adFields.ad_primary_text,
    ad_image_url: adFields.ad_image_url,
    category: typeof campaign.category === 'string' ? campaign.category : null,
    status: typeof campaign.status === 'string' ? campaign.status : null,
    fundingGoalDollars,
    fundingRaisedDollars,
    budgetDollars,
    percentFunded:
      fundingGoalDollars > 0
        ? Math.min(100, Math.round((fundingRaisedDollars / fundingGoalDollars) * 1000) / 10)
        : null,
    reach: reach.value,
    reachSource: reach.source,
    views: views.value,
    actions: actions.value,
    actionsSource: actions.source,
    perceptionShift: getCampaignPerceptionShift(campaignRow),
    netRating:
      campaign.net_rating != null && Number.isFinite(Number(campaign.net_rating))
        ? Number(campaign.net_rating)
        : null,
    startAt: timing.startMs != null ? new Date(timing.startMs).toISOString() : null,
    endAt: timing.endMs != null ? new Date(timing.endMs).toISOString() : null,
    durationDays: timing.durationDays,
    elapsedDays: timing.elapsedDays,
    percentComplete: timing.percentComplete,
    generatedAt: new Date(nowMs).toISOString(),
    pooled_amount: formatUsdFromDollars(fundingRaisedDollars),
    total_backers: totalBackers,
    projected_collective_reach: reach.value,
  };
}

function estimatedFullCampaignReach(campaign: Record<string, unknown>, currentReach: number): number {
  const budgetDollars = getCampaignTotalContributionCents(campaign as CampaignRow) / 100;
  const fromBudget = Math.round(budgetDollars * REACH_PER_DOLLAR);
  return Math.max(currentReach, fromBudget);
}

function buildBackerStageReport(
  base: CampaignReport,
  backer: CampaignBacker,
  campaign: Record<string, unknown>
): BackerStageReport {
  const campaignRow = { id: base.campaignId, ...campaign } as CampaignRow;
  const totalContributionCents = getCampaignTotalContributionCents(campaignRow);
  const actions = getCampaignActions(campaignRow);
  const frontendOrigin = getFrontendOrigin();

  const soFarAttr = computePersonalAttribution({
    userContributionCents: backer.contributionCents,
    totalContributionCents,
    campaignReach: base.reach,
    campaignViews: base.views,
    campaignActions: actions.value,
    perceptionShiftPct: base.perceptionShift,
  });

  const projectedCampaignReach = estimatedFullCampaignReach(campaign, base.reach);
  const projectedAttr = computePersonalAttribution({
    userContributionCents: backer.contributionCents,
    totalContributionCents,
    campaignReach: projectedCampaignReach,
    campaignViews: base.views,
    campaignActions: actions.value,
    perceptionShiftPct: base.perceptionShift,
  });

  const projectedReach = projectedAttr.personalReach;
  const reachedSoFar = soFarAttr.personalReach;
  const percentToGoal =
    projectedReach > 0
      ? Math.max(0, Math.min(100, Math.round((reachedSoFar / projectedReach) * 1000) / 10))
      : 0;

  const shared: BackerStageReport = {
    ...base,
    contribution_amount: formatUsdFromCents(backer.contributionCents),
    projected_reach: projectedReach,
    contributionAmountCents: backer.contributionCents,
    projected_collective_reach: projectedCampaignReach,
    // Backer impact page (personal), not campaign-level creator report.
    impactUrl: `${frontendOrigin}/account/impact/${encodeURIComponent(base.campaignId)}`,
  };

  if (base.stage === 'mid') {
    return {
      ...shared,
      // At mid, "projected" personal target vs progress so far.
      projected_reach: projectedReach,
      reached_so_far: reachedSoFar,
      actions_so_far: soFarAttr.personalActions,
      percent_to_goal: percentToGoal,
      collective_reach_so_far: base.reach,
      perception_shift_mid: base.perceptionShift,
    };
  }

  if (base.stage === 'recap') {
    return {
      ...shared,
      // At recap, current campaign metrics are final.
      projected_reach: projectedReach,
      final_reach: reachedSoFar,
      actions_sparked: soFarAttr.personalActions,
      perception_shift: base.perceptionShift,
      final_collective_reach: base.reach,
      total_spend: base.pooled_amount,
      total_backers: base.total_backers,
    };
  }

  // Launch: projected personal reach (often estimated from budget before ads run).
  return {
    ...shared,
    projected_reach: projectedReach,
  };
}

/**
 * Load unique backers for a campaign from stripe_checkout_records (paid + coupon-only).
 * Aggregates multiple contributions per email.
 */
async function loadCampaignBackers(
  db: Firestore,
  campaignId: string,
  usersDb?: Firestore
): Promise<CampaignBacker[]> {
  const snapshot = await db.collection('stripe_checkout_records').where('campaignId', '==', campaignId).get();
  const byEmail = new Map<string, CampaignBacker>();

  for (const doc of snapshot.docs) {
    const data = doc.data() as Record<string, unknown>;
    const amountCents = Math.max(0, Number(data.amount_cents) || 0);
    const donorUid = String(data.donor_uid || '').trim() || undefined;
    let email = String(data.donor_email || '').trim().toLowerCase();
    let firstName = String(data.donor_name || '')
      .trim()
      .split(/\s+/)[0];
    let lastName = String(data.donor_name || '')
      .trim()
      .split(/\s+/)
      .slice(1)
      .join(' ');
    let fullName = String(data.donor_name || '').trim();

    if ((!email || !fullName) && donorUid && usersDb) {
      const userDoc = await usersDb.collection('users').doc(donorUid).get();
      if (userDoc.exists) {
        const user = userDoc.data() as Record<string, unknown>;
        if (!email) email = String(user.email || '').trim().toLowerCase();
        const fn = String(user.firstName || '').trim();
        const ln = String(user.lastName || '').trim();
        if (!firstName && fn) firstName = fn;
        if (!lastName && ln) lastName = ln;
        if (!fullName) fullName = `${fn} ${ln}`.trim();
      }
    }

    if (!email) continue;

    const prev = byEmail.get(email);
    if (prev) {
      prev.contributionCents += amountCents;
      if (!prev.donorUid && donorUid) prev.donorUid = donorUid;
      if (!prev.firstName && firstName) prev.firstName = firstName;
      if (!prev.lastName && lastName) prev.lastName = lastName;
      if (!prev.fullName && fullName) prev.fullName = fullName;
    } else {
      byEmail.set(email, {
        email,
        contributionCents: amountCents,
        ...(donorUid ? { donorUid } : {}),
        ...(firstName ? { firstName } : {}),
        ...(lastName ? { lastName } : {}),
        ...(fullName ? { fullName } : {}),
      });
    }
  }

  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

async function sendKlaviyoReportEvent(
  profile: RecipientProfile,
  report: CampaignReport | BackerStageReport
): Promise<void> {
  const apiKey = process.env.KLAVIYO_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('KLAVIYO_API_KEY is not configured');
  }

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
          properties: report,
          metric: {
            data: {
              type: 'metric',
              attributes: {
                name: report.metricName,
              },
            },
          },
          profile: {
            data: {
              type: 'profile',
              attributes: {
                email: profile.email,
                ...(profile.firstName ? { first_name: profile.firstName } : {}),
                ...(profile.lastName ? { last_name: profile.lastName } : {}),
                ...(profile.fullName ? { properties: { full_name: profile.fullName } } : {}),
              },
            },
          },
        },
      },
    }),
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Klaviyo event failed (${response.status}): ${text.slice(0, 500)}`);
  }
}

async function claimStage(
  db: Firestore,
  campaignId: string,
  stage: CampaignReportStage,
  nowMs: number
): Promise<boolean> {
  const ref = db.collection('campaigns').doc(campaignId);
  const leaseExpiresAt = new Date(nowMs + 10 * 60 * 1000).toISOString();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const campaign = snap.data() as Record<string, unknown>;
    const stageState = ((campaign.campaign_report_drips as Record<string, unknown> | undefined)?.[stage] ??
      {}) as Record<string, unknown>;
    if (stageState.sentAt) return false;
    const existingLeaseMs = timestampToMs(stageState.sendingExpiresAt);
    if (existingLeaseMs != null && existingLeaseMs > nowMs) return false;

    tx.update(ref, {
      [`campaign_report_drips.${stage}.sendingAt`]: new Date(nowMs).toISOString(),
      [`campaign_report_drips.${stage}.sendingExpiresAt`]: leaseExpiresAt,
      [`campaign_report_drips.${stage}.attempts`]: FieldValue.increment(1),
      updatedAt: new Date(nowMs).toISOString(),
    });
    return true;
  });
}

async function markStageSent(
  db: Firestore,
  campaignId: string,
  stage: CampaignReportStage,
  recipientEmails: string[],
  report: CampaignReport,
  nowMs: number
): Promise<void> {
  await db.collection('campaigns').doc(campaignId).update({
    [`campaign_report_drips.${stage}.sentAt`]: new Date(nowMs).toISOString(),
    [`campaign_report_drips.${stage}.recipientEmail`]: recipientEmails[0] || null,
    [`campaign_report_drips.${stage}.recipientEmails`]: recipientEmails,
    [`campaign_report_drips.${stage}.recipientCount`]: recipientEmails.length,
    [`campaign_report_drips.${stage}.metricName`]: report.metricName,
    [`campaign_report_drips.${stage}.report`]: report,
    [`campaign_report_drips.${stage}.sendingAt`]: FieldValue.delete(),
    [`campaign_report_drips.${stage}.sendingExpiresAt`]: FieldValue.delete(),
    [`campaign_report_drips.${stage}.lastError`]: FieldValue.delete(),
    updatedAt: new Date(nowMs).toISOString(),
  });
}

async function markStagePartialProgress(
  db: Firestore,
  campaignId: string,
  stage: CampaignReportStage,
  recipientEmails: string[],
  error: string,
  nowMs: number
): Promise<void> {
  await db.collection('campaigns').doc(campaignId).update({
    [`campaign_report_drips.${stage}.recipientEmails`]: recipientEmails,
    [`campaign_report_drips.${stage}.recipientCount`]: recipientEmails.length,
    [`campaign_report_drips.${stage}.lastError`]: error.slice(0, 1000),
    [`campaign_report_drips.${stage}.failedAt`]: new Date(nowMs).toISOString(),
    [`campaign_report_drips.${stage}.sendingAt`]: FieldValue.delete(),
    [`campaign_report_drips.${stage}.sendingExpiresAt`]: FieldValue.delete(),
    updatedAt: new Date(nowMs).toISOString(),
  });
}

async function markStageFailed(
  db: Firestore,
  campaignId: string,
  stage: CampaignReportStage,
  error: string,
  nowMs: number
): Promise<void> {
  await db.collection('campaigns').doc(campaignId).update({
    [`campaign_report_drips.${stage}.lastError`]: error.slice(0, 1000),
    [`campaign_report_drips.${stage}.failedAt`]: new Date(nowMs).toISOString(),
    [`campaign_report_drips.${stage}.sendingAt`]: FieldValue.delete(),
    [`campaign_report_drips.${stage}.sendingExpiresAt`]: FieldValue.delete(),
    updatedAt: new Date(nowMs).toISOString(),
  });
}


export async function runCampaignReportDrips(db: Firestore, options: CampaignReportDripOptions = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const limit = Math.max(1, Math.min(200, Number(options.limit) || DEFAULT_LIMIT));
  const campaignIdFilter = new Set((options.campaignIds ?? []).map((id) => id.trim()).filter(Boolean));
  if (options.forceStage && campaignIdFilter.size === 0) {
    return {
      ok: false,
      dryRun: Boolean(options.dryRun),
      checkedCampaigns: 0,
      processed: 0,
      results: [],
      error: 'forceStage requires campaignId or campaignIds',
    };
  }

  const statuses = ['Approved', 'Completed'];
  const campaigns: { id: string; data: Record<string, unknown> }[] = [];

  if (campaignIdFilter.size > 0) {
    for (const id of campaignIdFilter) {
      const doc = await db.collection('campaigns').doc(id).get();
      if (!doc.exists) continue;
      const data = doc.data() as Record<string, unknown>;
      const status = String(data.status || '').trim();
      if (status !== 'Approved' && status !== 'Completed') continue;
      campaigns.push({ id: doc.id, data });
    }
  } else {
    for (const status of statuses) {
      const snapshot = await db.collection('campaigns').where('status', '==', status).get();
      for (const doc of snapshot.docs) {
        campaigns.push({ id: doc.id, data: doc.data() as Record<string, unknown> });
      }
    }
  }

  campaigns.sort((a, b) => {
    const aStart = getCampaignStartMs(a.data) ?? timestampToMs(a.data.createdAt) ?? 0;
    const bStart = getCampaignStartMs(b.data) ?? timestampToMs(b.data.createdAt) ?? 0;
    return aStart - bStart;
  });

  const results: RunItem[] = [];
  for (const campaign of campaigns) {
    if (results.length >= limit) break;
    const title = String(campaign.data.title || 'Campaign');
    const timing = buildTiming(campaign.data, nowMs);
    const stage = resolveStage(campaign.data, timing, nowMs, {
      stages: options.stages,
      forceStage: options.forceStage,
    });
    if (!stage) continue;

    // Launch + mid + recap → each backer with personal impact fields.
    if (stage === 'launch' || stage === 'mid' || stage === 'recap') {
      const backers = await loadCampaignBackers(db, campaign.id, options.usersDb);
      const alreadySent = new Set(getStageRecipientEmails(campaign.data, stage));
      const pending = backers.filter((b) => !alreadySent.has(b.email));
      const basePreview = buildReport(campaign.id, campaign.data, stage, timing, nowMs, backers.length);

      if (options.dryRun) {
        const sampleBacker = pending[0];
        results.push({
          campaignId: campaign.id,
          title,
          stage,
          metricName: basePreview.metricName,
          emails: pending.map((b) => b.email),
          recipientCount: pending.length,
          dryRun: true,
          ...(sampleBacker
            ? { sampleEvent: buildBackerStageReport(basePreview, sampleBacker, campaign.data) }
            : {}),
          ...(pending.length === 0
            ? { skipped: backers.length === 0 ? 'No backers with email' : 'All backers already sent' }
            : {}),
        });
        continue;
      }

      const claimed = await claimStage(db, campaign.id, stage, nowMs);
      if (!claimed) {
        results.push({
          campaignId: campaign.id,
          title,
          stage,
          skipped: 'Already sent or currently sending',
        });
        continue;
      }

      let campaignData = campaign.data;
      const refreshed = await refreshCampaignFacebookInsightsIfStale(db, campaign.id, campaignData);
      if (refreshed) {
        const refreshedDoc = await db.collection('campaigns').doc(campaign.id).get();
        if (refreshedDoc.exists) {
          campaignData = refreshedDoc.data() as Record<string, unknown>;
        }
      }

      const baseReport = buildReport(campaign.id, campaignData, stage, timing, nowMs, backers.length);

      // No eligible recipients — mark complete so we don't retry forever.
      if (pending.length === 0) {
        const allEmails = [...alreadySent];
        await markStageSent(db, campaign.id, stage, allEmails, baseReport, nowMs);
        results.push({
          campaignId: campaign.id,
          title,
          stage,
          metricName: baseReport.metricName,
          emails: allEmails,
          recipientCount: allEmails.length,
          sent: true,
          skipped: backers.length === 0 ? 'No backers with email' : 'All backers already sent',
        });
        continue;
      }

      const sentEmails = [...alreadySent];
      try {
        for (const backer of pending) {
          const report = buildBackerStageReport(baseReport, backer, campaignData);
          await sendKlaviyoReportEvent(
            {
              email: backer.email,
              ...(backer.firstName ? { firstName: backer.firstName } : {}),
              ...(backer.lastName ? { lastName: backer.lastName } : {}),
              ...(backer.fullName ? { fullName: backer.fullName } : {}),
            },
            report
          );
          sentEmails.push(backer.email);
        }
        await markStageSent(db, campaign.id, stage, sentEmails, baseReport, nowMs);
        results.push({
          campaignId: campaign.id,
          title,
          stage,
          metricName: baseReport.metricName,
          emails: sentEmails,
          recipientCount: sentEmails.length,
          sent: true,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await markStagePartialProgress(db, campaign.id, stage, sentEmails, message, nowMs).catch(
          (markError) => {
            console.error('Failed to mark campaign report drip partial progress:', markError);
          }
        );
        results.push({
          campaignId: campaign.id,
          title,
          stage,
          metricName: baseReport.metricName,
          emails: sentEmails,
          recipientCount: sentEmails.length,
          error: message,
        });
      }
      continue;
    }
  }

  return {
    ok: results.every((item) => !item.error),
    dryRun: Boolean(options.dryRun),
    checkedCampaigns: campaigns.length,
    processed: results.length,
    results,
  };
}
