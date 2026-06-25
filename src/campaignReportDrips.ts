import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  getCampaignActions,
  getCampaignBudgetCents,
  getCampaignPerceptionShift,
  getCampaignReach,
  getCampaignViews,
  type CampaignRow,
} from './impactMetrics';

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_LAUNCH_LEAD_HOURS = 24;
const DEFAULT_LIMIT = 50;

export type CampaignReportStage = 'launch' | 'mid' | 'recap';

interface CampaignReportDripOptions {
  dryRun?: boolean;
  limit?: number;
  nowMs?: number;
  usersDb?: Firestore;
}

interface CreatorProfile {
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

interface CampaignReport {
  stage: CampaignReportStage;
  stageLabel: string;
  metricName: string;
  campaignId: string;
  campaignTitle: string;
  campaignUrl: string;
  impactUrl: string;
  thumbnailUrl: string | null;
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
}

interface RunItem {
  campaignId: string;
  title: string;
  stage?: CampaignReportStage;
  metricName?: string;
  email?: string;
  sent?: boolean;
  dryRun?: boolean;
  skipped?: string;
  error?: string;
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

function nextDueStage(
  campaign: Record<string, unknown>,
  timing: CampaignTiming,
  nowMs: number
): CampaignReportStage | null {
  const status = String(campaign.status || '').trim();
  if (status !== 'Approved' && status !== 'Completed') return null;

  const launchLeadMs =
    Math.max(0, Number(process.env.KLAVIYO_REPORT_LAUNCH_LEAD_HOURS ?? DEFAULT_LAUNCH_LEAD_HOURS)) * HOUR_MS;
  const launchDueMs = (timing.startMs ?? nowMs) - launchLeadMs;
  if (!stageIsSent(campaign, 'launch') && nowMs >= launchDueMs) return 'launch';

  if (
    timing.midpointMs != null &&
    !stageIsSent(campaign, 'mid') &&
    nowMs >= timing.midpointMs
  ) {
    return 'mid';
  }

  if (
    !stageIsSent(campaign, 'recap') &&
    (status === 'Completed' || (timing.endMs != null && nowMs >= timing.endMs))
  ) {
    return 'recap';
  }

  return null;
}

function asDollars(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

function getFrontendOrigin(): string {
  const raw =
    process.env.FRONTEND_ORIGIN ||
    process.env.FRONTEND_BASE_URL ||
    'http://localhost:5173';
  return raw.split(',')[0].trim().replace(/\/$/, '');
}

function getCreatorProfileFromCampaign(campaign: Record<string, unknown>): CreatorProfile | null {
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
): Promise<CreatorProfile | null> {
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
  nowMs: number
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

  return {
    stage,
    stageLabel: stageLabel(stage),
    metricName: metricNameForStage(stage),
    campaignId,
    campaignTitle: String(campaign.title || 'Campaign'),
    campaignUrl: `${frontendOrigin}/campaign/${encodeURIComponent(campaignId)}`,
    impactUrl: `${frontendOrigin}/campaign/${encodeURIComponent(campaignId)}/impact`,
    thumbnailUrl: typeof campaign.thumbnail_url === 'string' ? campaign.thumbnail_url : null,
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
  };
}

async function sendKlaviyoReportEvent(profile: CreatorProfile, report: CampaignReport): Promise<void> {
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
  profile: CreatorProfile,
  report: CampaignReport,
  nowMs: number
): Promise<void> {
  await db.collection('campaigns').doc(campaignId).update({
    [`campaign_report_drips.${stage}.sentAt`]: new Date(nowMs).toISOString(),
    [`campaign_report_drips.${stage}.recipientEmail`]: profile.email,
    [`campaign_report_drips.${stage}.metricName`]: report.metricName,
    [`campaign_report_drips.${stage}.report`]: report,
    [`campaign_report_drips.${stage}.sendingAt`]: FieldValue.delete(),
    [`campaign_report_drips.${stage}.sendingExpiresAt`]: FieldValue.delete(),
    [`campaign_report_drips.${stage}.lastError`]: FieldValue.delete(),
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
  const statuses = ['Approved', 'Completed'];
  const campaigns: { id: string; data: Record<string, unknown> }[] = [];

  for (const status of statuses) {
    const snapshot = await db.collection('campaigns').where('status', '==', status).get();
    for (const doc of snapshot.docs) {
      campaigns.push({ id: doc.id, data: doc.data() as Record<string, unknown> });
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
    const stage = nextDueStage(campaign.data, timing, nowMs);
    if (!stage) continue;

    const profile = await getCreatorProfile(campaign.data, options.usersDb);
    if (!profile) {
      results.push({
        campaignId: campaign.id,
        title,
        stage,
        skipped: 'Campaign has no creator_email',
      });
      continue;
    }

    const report = buildReport(campaign.id, campaign.data, stage, timing, nowMs);
    if (options.dryRun) {
      results.push({
        campaignId: campaign.id,
        title,
        stage,
        metricName: report.metricName,
        email: profile.email,
        dryRun: true,
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

    try {
      await sendKlaviyoReportEvent(profile, report);
      await markStageSent(db, campaign.id, stage, profile, report, nowMs);
      results.push({
        campaignId: campaign.id,
        title,
        stage,
        metricName: report.metricName,
        email: profile.email,
        sent: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markStageFailed(db, campaign.id, stage, message, nowMs).catch((markError) => {
        console.error('Failed to mark campaign report drip failure:', markError);
      });
      results.push({
        campaignId: campaign.id,
        title,
        stage,
        metricName: report.metricName,
        email: profile.email,
        error: message,
      });
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
