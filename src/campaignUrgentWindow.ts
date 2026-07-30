import { FieldValue, type Firestore } from 'firebase-admin/firestore';
import {
  loadCampaignBackers,
  getCampaignEndMs,
  timestampToMs,
  type CampaignBacker,
} from './campaignReportDrips';

/**
 * UE-184 urgent-window email (Tim, comment 11703; audience confirmed 2026-07-30 = "email who
 * backed"). When a campaign crosses into its final 48h, email backers of OTHER campaigns in the
 * SAME category (people who've shown interest in the topic), nudging them to help close the gap.
 * Excludes anyone who already backed this campaign. Fires once per campaign.
 *
 * Mirrors the campaign-report-drips job: scheduled endpoint, dry-run support, claim/lease so a
 * campaign is only processed once. Backer emails come from `stripe_checkout_records`.
 */

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_WINDOW_HOURS = 48;
/** Don't email the same person about a closing campaign more than once per this window. */
const DEFAULT_FREQ_CAP_HOURS = 72;
const DEFAULT_LIMIT = 50;
const METRIC_NAME = 'Unravel Campaign Closing Soon';
/** Cap how many recipient emails we persist on the campaign doc (audit, not the send list). */
const MAX_STORED_RECIPIENTS = 500;
const NOTIFICATION_COLLECTION = 'urgent_window_notifications';

/**
 * Conservative reach-per-$ mirrors the UI model default (unravel-ui/src/utils/reach.js). The email
 * must show the SAME reach the recipient sees on the campaign page it links to, or we recreate the
 * kind of number-mismatch we're trying to avoid. Per-campaign `reach_per_dollar` overrides win.
 * NOTE: unifying this with the server's impactMetrics REACH_PER_DOLLAR (10) is pending Tim's final
 * reach calibration — tracked on UE-183.
 */
const CONSERVATIVE_REACH_PER_DOLLAR = 27;

const ACTIVE_STATUSES = ['Approved', 'Completed'];

export interface UrgentWindowOptions {
  dryRun?: boolean;
  limit?: number;
  nowMs?: number;
  /** Final-window size in hours (default 48). */
  windowHours?: number;
  /** Per-recipient suppression window in hours (default 72). */
  freqCapHours?: number;
  /** Only consider these campaign ids. */
  campaignIds?: string[];
  usersDb?: Firestore;
}

interface UrgentEvent {
  metricName: string;
  campaignId: string;
  campaign_name: string;
  category: string | null;
  campaignUrl: string;
  thumbnailUrl: string | null;
  funding_goal: string;
  funding_raised: string;
  percent_funded: number;
  trust_score: number | null;
  dollars_to_go: string;
  dollars_to_go_amount: number;
  more_people_reached: number;
  more_people_reached_display: string;
  hours_left: number;
  deadline: string;
  generatedAt: string;
}

interface RunItem {
  campaignId: string;
  title: string;
  category?: string | null;
  hoursLeft?: number;
  recipientCount?: number;
  emails?: string[];
  suppressedCount?: number;
  excludedBackerCount?: number;
  sent?: boolean;
  dryRun?: boolean;
  skipped?: string;
  error?: string;
  sampleEvent?: UrgentEvent;
}

function asDollars(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function formatUsd(dollars: number): string {
  const n = Math.max(0, Number(dollars) || 0);
  if (Number.isInteger(n)) return `$${n.toLocaleString('en-US')}`;
  return `$${n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function getFrontendOrigin(): string {
  const raw = process.env.FRONTEND_ORIGIN || process.env.FRONTEND_BASE_URL || 'http://localhost:5173';
  return raw.split(',')[0].trim().replace(/\/$/, '');
}

function getRaisedDollars(campaign: Record<string, unknown>): number {
  return asDollars(campaign.funding_current ?? campaign.amount_raised ?? campaign.funding_raised);
}

function percentFunded(campaign: Record<string, unknown>): number | null {
  const goal = asDollars(campaign.funding_goal);
  if (!(goal > 0)) return null;
  return Math.min(100, Math.round((getRaisedDollars(campaign) / goal) * 1000) / 10);
}

/** Reach for a dollar amount — mirrors the UI's round-DOWN, deploy-adjusted conservative model. */
function reachForDollars(campaign: Record<string, unknown>, dollars: number): number {
  const override = Number(campaign.reach_per_dollar ?? campaign.reachPerDollar);
  const ratio = Number.isFinite(override) && override > 0 ? override : CONSERVATIVE_REACH_PER_DOLLAR;
  const raw = Math.max(0, dollars) * ratio;
  if (!(raw > 0)) return 0;
  return raw > 100 ? Math.floor(raw / 10) * 10 : Math.floor(raw);
}

function buildUrgentEvent(
  campaignId: string,
  campaign: Record<string, unknown>,
  endMs: number,
  nowMs: number
): UrgentEvent {
  const goalDollars = asDollars(campaign.funding_goal);
  const raisedDollars = getRaisedDollars(campaign);
  const dollarsToGo = Math.max(1, Math.ceil(goalDollars - raisedDollars));
  const reached = reachForDollars(campaign, dollarsToGo);
  const trust = Number(campaign.trust_score);
  const origin = getFrontendOrigin();
  return {
    metricName: METRIC_NAME,
    campaignId,
    campaign_name: String(campaign.title || 'Campaign'),
    category: typeof campaign.category === 'string' ? campaign.category : null,
    campaignUrl: `${origin}/campaign/${encodeURIComponent(campaignId)}`,
    thumbnailUrl: typeof campaign.thumbnail_url === 'string' ? campaign.thumbnail_url : null,
    funding_goal: formatUsd(goalDollars),
    funding_raised: formatUsd(raisedDollars),
    percent_funded: percentFunded(campaign) ?? 0,
    trust_score: Number.isFinite(trust) && trust > 0 ? Math.round(trust) : null,
    dollars_to_go: formatUsd(dollarsToGo),
    dollars_to_go_amount: dollarsToGo,
    more_people_reached: reached,
    more_people_reached_display: reached.toLocaleString('en-US'),
    hours_left: Math.max(0, Math.ceil((endMs - nowMs) / HOUR_MS)),
    deadline: new Date(endMs).toISOString(),
    generatedAt: new Date(nowMs).toISOString(),
  };
}

/**
 * Backers of OTHER approved/completed campaigns in the same category, deduped by email.
 * These are the topic-interested people we nudge.
 */
async function loadCategoryBackers(
  db: Firestore,
  category: string,
  excludeCampaignId: string,
  usersDb?: Firestore
): Promise<CampaignBacker[]> {
  const snapshot = await db.collection('campaigns').where('category', '==', category).get();
  const byEmail = new Map<string, CampaignBacker>();

  for (const doc of snapshot.docs) {
    if (doc.id === excludeCampaignId) continue;
    const status = String((doc.data() as Record<string, unknown>).status || '').trim();
    if (!ACTIVE_STATUSES.includes(status)) continue;

    const backers = await loadCampaignBackers(db, doc.id, usersDb);
    for (const b of backers) {
      const prev = byEmail.get(b.email);
      if (prev) {
        prev.contributionCents += b.contributionCents;
        if (!prev.firstName && b.firstName) prev.firstName = b.firstName;
        if (!prev.lastName && b.lastName) prev.lastName = b.lastName;
        if (!prev.fullName && b.fullName) prev.fullName = b.fullName;
      } else {
        byEmail.set(b.email, { ...b });
      }
    }
  }

  return [...byEmail.values()].sort((a, b) => a.email.localeCompare(b.email));
}

/** Emails notified about ANY closing campaign since the cutoff — the frequency-cap suppression set. */
async function loadRecentlyNotified(db: Firestore, cutoffMs: number): Promise<Set<string>> {
  const snapshot = await db.collection(NOTIFICATION_COLLECTION).where('sentAtMs', '>=', cutoffMs).get();
  const set = new Set<string>();
  for (const doc of snapshot.docs) {
    const email = String((doc.data() as Record<string, unknown>).email || '').trim().toLowerCase();
    if (email) set.add(email);
  }
  return set;
}

function alreadySent(campaign: Record<string, unknown>): boolean {
  const state = campaign.urgent_window_email as Record<string, unknown> | undefined;
  return Boolean(state?.sentAt);
}

/** Claim the campaign so only one run sends its urgent email (lease + sentAt guard). */
async function claimCampaign(db: Firestore, campaignId: string, nowMs: number): Promise<boolean> {
  const ref = db.collection('campaigns').doc(campaignId);
  const leaseExpiresAt = new Date(nowMs + 10 * 60 * 1000).toISOString();
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return false;
    const state = ((snap.data() as Record<string, unknown>).urgent_window_email ?? {}) as Record<string, unknown>;
    if (state.sentAt) return false;
    const leaseMs = timestampToMs(state.sendingExpiresAt);
    if (leaseMs != null && leaseMs > nowMs) return false;
    tx.update(ref, {
      'urgent_window_email.sendingAt': new Date(nowMs).toISOString(),
      'urgent_window_email.sendingExpiresAt': leaseExpiresAt,
      'urgent_window_email.attempts': FieldValue.increment(1),
      updatedAt: new Date(nowMs).toISOString(),
    });
    return true;
  });
}

async function markCampaignSent(
  db: Firestore,
  campaignId: string,
  recipientEmails: string[],
  event: UrgentEvent,
  nowMs: number
): Promise<void> {
  await db.collection('campaigns').doc(campaignId).update({
    'urgent_window_email.sentAt': new Date(nowMs).toISOString(),
    'urgent_window_email.recipientCount': recipientEmails.length,
    'urgent_window_email.recipientEmails': recipientEmails.slice(0, MAX_STORED_RECIPIENTS),
    'urgent_window_email.metricName': event.metricName,
    'urgent_window_email.event': event,
    'urgent_window_email.sendingAt': FieldValue.delete(),
    'urgent_window_email.sendingExpiresAt': FieldValue.delete(),
    'urgent_window_email.lastError': FieldValue.delete(),
    updatedAt: new Date(nowMs).toISOString(),
  });
}

async function markCampaignFailed(
  db: Firestore,
  campaignId: string,
  sentEmails: string[],
  error: string,
  nowMs: number
): Promise<void> {
  await db.collection('campaigns').doc(campaignId).update({
    'urgent_window_email.recipientCount': sentEmails.length,
    'urgent_window_email.recipientEmails': sentEmails.slice(0, MAX_STORED_RECIPIENTS),
    'urgent_window_email.lastError': error.slice(0, 1000),
    'urgent_window_email.failedAt': new Date(nowMs).toISOString(),
    'urgent_window_email.sendingAt': FieldValue.delete(),
    'urgent_window_email.sendingExpiresAt': FieldValue.delete(),
    updatedAt: new Date(nowMs).toISOString(),
  });
}

/** Record a per-recipient send for the frequency cap (doc id = email). */
async function logNotification(
  db: Firestore,
  email: string,
  campaignId: string,
  nowMs: number
): Promise<void> {
  const id = email.replace(/[^a-zA-Z0-9._-]/g, '_');
  await db.collection(NOTIFICATION_COLLECTION).doc(id).set({
    email,
    lastCampaignId: campaignId,
    sentAt: new Date(nowMs).toISOString(),
    sentAtMs: nowMs,
  });
}

async function sendKlaviyoUrgentEvent(profile: CampaignBacker, event: UrgentEvent): Promise<void> {
  const apiKey = process.env.KLAVIYO_API_KEY?.trim();
  if (!apiKey) throw new Error('KLAVIYO_API_KEY is not configured');
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
          properties: event,
          metric: { data: { type: 'metric', attributes: { name: event.metricName } } },
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

export async function runCampaignUrgentWindow(db: Firestore, options: UrgentWindowOptions = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const windowMs = Math.max(1, Number(options.windowHours) || DEFAULT_WINDOW_HOURS) * HOUR_MS;
  const freqCapMs = Math.max(0, Number(options.freqCapHours ?? DEFAULT_FREQ_CAP_HOURS)) * HOUR_MS;
  const limit = Math.max(1, Math.min(200, Number(options.limit) || DEFAULT_LIMIT));
  const campaignIdFilter = new Set((options.campaignIds ?? []).map((id) => id.trim()).filter(Boolean));

  // Candidate campaigns.
  const campaigns: { id: string; data: Record<string, unknown> }[] = [];
  if (campaignIdFilter.size > 0) {
    for (const id of campaignIdFilter) {
      const doc = await db.collection('campaigns').doc(id).get();
      if (doc.exists) campaigns.push({ id: doc.id, data: doc.data() as Record<string, unknown> });
    }
  } else {
    const snapshot = await db.collection('campaigns').where('status', '==', 'Approved').get();
    for (const doc of snapshot.docs) {
      campaigns.push({ id: doc.id, data: doc.data() as Record<string, unknown> });
    }
  }

  const suppress = freqCapMs > 0 ? await loadRecentlyNotified(db, nowMs - freqCapMs) : new Set<string>();

  // Rank by soonest deadline.
  const eligible = campaigns
    .map((c) => ({ ...c, endMs: getCampaignEndMs(c.data) }))
    .filter((c) => c.endMs != null && c.endMs > nowMs && c.endMs <= nowMs + windowMs)
    .sort((a, b) => (a.endMs as number) - (b.endMs as number));

  const results: RunItem[] = [];
  for (const campaign of eligible) {
    if (results.length >= limit) break;
    const title = String(campaign.data.title || 'Campaign');
    const endMs = campaign.endMs as number;

    if (!options.dryRun && alreadySent(campaign.data)) {
      continue;
    }

    const pct = percentFunded(campaign.data);
    if (pct != null && pct >= 100) {
      results.push({ campaignId: campaign.id, title, skipped: 'Already funded' });
      continue;
    }

    const category = typeof campaign.data.category === 'string' ? campaign.data.category.trim() : '';
    if (!category) {
      results.push({ campaignId: campaign.id, title, skipped: 'No category — cannot match backers' });
      continue;
    }

    // Audience: category backers, minus this campaign's own backers, minus recently-notified.
    const categoryBackers = await loadCategoryBackers(db, category, campaign.id, options.usersDb);
    const ownBackers = await loadCampaignBackers(db, campaign.id, options.usersDb);
    const ownEmails = new Set(ownBackers.map((b) => b.email));
    const afterExclude = categoryBackers.filter((b) => !ownEmails.has(b.email));
    const recipients = afterExclude.filter((b) => !suppress.has(b.email));
    const event = buildUrgentEvent(campaign.id, campaign.data, endMs, nowMs);

    if (options.dryRun) {
      results.push({
        campaignId: campaign.id,
        title,
        category,
        hoursLeft: event.hours_left,
        recipientCount: recipients.length,
        emails: recipients.map((b) => b.email),
        excludedBackerCount: ownEmails.size,
        suppressedCount: afterExclude.length - recipients.length,
        dryRun: true,
        ...(recipients[0] ? { sampleEvent: event } : {}),
        ...(recipients.length === 0
          ? { skipped: categoryBackers.length === 0 ? 'No category backers' : 'All excluded or suppressed' }
          : {}),
      });
      continue;
    }

    const claimed = await claimCampaign(db, campaign.id, nowMs);
    if (!claimed) {
      results.push({ campaignId: campaign.id, title, skipped: 'Already sent or currently sending' });
      continue;
    }

    // No recipients — mark sent so we don't re-scan this campaign every run.
    if (recipients.length === 0) {
      await markCampaignSent(db, campaign.id, [], event, nowMs);
      results.push({
        campaignId: campaign.id,
        title,
        category,
        recipientCount: 0,
        sent: true,
        skipped: categoryBackers.length === 0 ? 'No category backers' : 'All excluded or suppressed',
      });
      continue;
    }

    const sentEmails: string[] = [];
    try {
      for (const backer of recipients) {
        await sendKlaviyoUrgentEvent(backer, event);
        sentEmails.push(backer.email);
        // Suppress within this run too, and persist for the cross-run frequency cap.
        suppress.add(backer.email);
        await logNotification(db, backer.email, campaign.id, nowMs);
      }
      await markCampaignSent(db, campaign.id, sentEmails, event, nowMs);
      results.push({
        campaignId: campaign.id,
        title,
        category,
        hoursLeft: event.hours_left,
        recipientCount: sentEmails.length,
        sent: true,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await markCampaignFailed(db, campaign.id, sentEmails, message, nowMs).catch((markError) => {
        console.error('Failed to mark urgent-window failure:', markError);
      });
      results.push({
        campaignId: campaign.id,
        title,
        category,
        recipientCount: sentEmails.length,
        error: message,
      });
    }
  }

  return {
    ok: results.every((item) => !item.error),
    dryRun: Boolean(options.dryRun),
    windowHours: windowMs / HOUR_MS,
    checkedCampaigns: campaigns.length,
    eligibleCampaigns: eligible.length,
    processed: results.length,
    results,
  };
}

export function parseUrgentWindowRequest(input: {
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
}): UrgentWindowOptions {
  const body = input.body ?? {};
  const query = input.query ?? {};
  const truthy = (v: unknown) => v === true || v === 'true' || v === '1';
  const num = (v: unknown) => (v != null && v !== '' && Number.isFinite(Number(v)) ? Number(v) : undefined);
  const ids = body.campaignIds ?? body.campaignId ?? query.campaignIds ?? query.campaignId;
  const campaignIds = ids == null
    ? []
    : [...new Set((Array.isArray(ids) ? ids : String(ids).split(',')).map((s) => String(s).trim()).filter(Boolean))];
  return {
    dryRun: truthy(body.dryRun) || truthy(query.dryRun),
    limit: num(body.limit ?? query.limit),
    windowHours: num(body.windowHours ?? query.windowHours),
    freqCapHours: num(body.freqCapHours ?? query.freqCapHours),
    campaignIds,
  };
}
