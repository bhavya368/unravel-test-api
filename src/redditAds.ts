import { type Firestore } from 'firebase-admin/firestore';

/**
 * Creates Reddit ad campaigns for approved Unravel campaigns.
 *
 * Separate from `socialSyndication.ts`, which posts free organic content to X and
 * Reddit. This is the paid side: ads.reddit.com, a different API and a different
 * set of credentials.
 *
 * Quirks of the Reddit Ads API, per the account owner's handover notes — each one
 * is load-bearing:
 *  - Every request needs a User-Agent, or Reddit rate-limits with errors that look
 *    like auth failures and send you debugging the wrong thing.
 *  - The refresh token never expires; the access token lasts ~24h. Cache it rather
 *    than refreshing per request.
 *  - Request and response bodies are wrapped in a `data` envelope.
 *  - URLs are asymmetric: create/list is nested under the ad account, but get and
 *    update are top-level (`/campaigns/{id}`, not `/ad_accounts/{id}/campaigns/{id}`).
 *  - There is no DELETE. Archiving is a PATCH to `configured_status: ARCHIVED`.
 *
 * Everything is created PAUSED. Nothing here can spend money on its own.
 */

const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const ADS_API_BASE = 'https://ads-api.reddit.com/api/v3';

/** Reddit campaign names are capped; leave room for the id suffix we append. */
const MAX_NAME = 100;

export interface RedditAdResult {
  status: 'created' | 'skipped' | 'failed';
  /** Reddit's campaign id, when one was created or already existed. */
  adCampaignId?: string;
  /** 'not_configured' | 'already_created' | 'not_approved' */
  reason?: string;
  error?: string;
  /** True when Reddit says the funding source cannot currently serve ads. */
  unfunded?: boolean;
}

interface RedditAdsConfig {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  userAgent: string;
  adAccountId: string;
  fundingInstrumentId: string;
}

const env = (name: string): string => (process.env[name] || '').trim();

export function getRedditAdsConfig(): RedditAdsConfig | null {
  const clientId = env('REDDIT_CLIENT_ID');
  const clientSecret = env('REDDIT_CLIENT_SECRET');
  const refreshToken = env('REDDIT_REFRESH_TOKEN');
  const adAccountId = env('REDDIT_AD_ACCOUNT_ID');
  const fundingInstrumentId = env('REDDIT_FUNDING_INSTRUMENT_ID');
  // A generic agent gets rate-limited, so fall back to a specific one rather than ''.
  const userAgent = env('REDDIT_USER_AGENT') || 'web:network.unravel.ads:v1.0';
  if (!clientId || !clientSecret || !refreshToken || !adAccountId || !fundingInstrumentId) {
    return null;
  }
  return { clientId, clientSecret, refreshToken, userAgent, adAccountId, fundingInstrumentId };
}

/** Access tokens last ~24h and the refresh token is permanent, so cache in memory. */
let tokenCache: { token: string; expiresAtMs: number } | null = null;

async function getAccessToken(cfg: RedditAdsConfig): Promise<string> {
  if (tokenCache && tokenCache.expiresAtMs > Date.now() + 60_000) return tokenCache.token;

  const res = await fetch(REDDIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization:
        'Basic ' + Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`).toString('base64'),
      'User-Agent': cfg.userAgent,
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken }),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !payload?.access_token) {
    throw new Error(`Reddit Ads token request failed: ${payload?.error || `HTTP ${res.status}`}`);
  }
  tokenCache = {
    token: String(payload.access_token),
    expiresAtMs: Date.now() + Number(payload.expires_in ?? 86400) * 1000,
  };
  return tokenCache.token;
}

/**
 * One call against the Ads API. Unwraps the `data` envelope and turns Reddit's
 * error shapes into a readable message — its failures are otherwise opaque.
 */
async function adsApi<T = any>(
  cfg: RedditAdsConfig,
  method: 'GET' | 'POST' | 'PATCH',
  path: string,
  body?: unknown
): Promise<T> {
  const token = await getAccessToken(cfg);
  const res = await fetch(`${ADS_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'User-Agent': cfg.userAgent,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    // Reddit expects the payload wrapped, the same way it wraps its responses.
    ...(body ? { body: JSON.stringify({ data: body }) } : {}),
  });

  const text = await res.text();
  let parsed: any = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    /* non-JSON error page; the raw text below is more useful than a parse error */
  }

  if (!res.ok) {
    const detail =
      parsed?.errors?.[0]?.detail ||
      parsed?.errors?.[0]?.reason ||
      parsed?.error ||
      parsed?.message ||
      text.slice(0, 200) ||
      `HTTP ${res.status}`;
    throw new Error(`Reddit Ads ${method} ${path} failed (${res.status}): ${detail}`);
  }
  return (parsed?.data ?? parsed) as T;
}

/** Whether the ad account can actually serve ads, and why not if it can't. */
export async function getRedditFundingStatus(
  cfg: RedditAdsConfig
): Promise<{ servable: boolean; reasons: string[] }> {
  const list = await adsApi<any[]>(
    cfg,
    'GET',
    `/ad_accounts/${cfg.adAccountId}/funding_instruments`
  );
  const fi = (Array.isArray(list) ? list : []).find(
    f => String(f?.id) === cfg.fundingInstrumentId
  );
  if (!fi) return { servable: false, reasons: ['FUNDING_INSTRUMENT_NOT_FOUND'] };
  return {
    servable: Boolean(fi.is_servable),
    reasons: Array.isArray(fi.reasons_not_servable) ? fi.reasons_not_servable.map(String) : [],
  };
}

/** Read-only health check. Creates nothing. */
export async function verifyRedditAdsConnection(): Promise<{
  ok: boolean;
  accountName?: string;
  servable?: boolean;
  reasons?: string[];
  error?: string;
}> {
  const cfg = getRedditAdsConfig();
  if (!cfg) return { ok: false, error: 'not_configured' };
  try {
    const account = await adsApi<any>(cfg, 'GET', `/ad_accounts/${cfg.adAccountId}`);
    const funding = await getRedditFundingStatus(cfg);
    return {
      ok: true,
      accountName: String(account?.name ?? cfg.adAccountId),
      servable: funding.servable,
      reasons: funding.reasons,
    };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function adCampaignName(campaign: Record<string, any>, campaignId: string): string {
  const title = String(campaign?.title ?? '').replace(/\s+/g, ' ').trim() || 'Unravel campaign';
  // The id suffix makes the ad findable from a Unravel campaign and vice versa.
  const suffix = ` [${campaignId}]`;
  return title.slice(0, MAX_NAME - suffix.length) + suffix;
}

/**
 * Create a paused Reddit ad campaign for an approved Unravel campaign.
 *
 * Idempotent: a recorded `reddit_ads_campaign_id` short-circuits a second call, so
 * a retry or a double-click can't litter the ad account with duplicates.
 *
 * Creates the campaign only — Reddit's hierarchy is campaign → ad group → ad, and
 * the lower two levels need a budget and targeting that nobody has decided yet.
 * Nothing is shown to anyone until those exist AND the account has a valid card.
 */
export async function createRedditAdCampaign(
  db: Firestore,
  campaignId: string,
  options: { force?: boolean; objective?: string } = {}
): Promise<RedditAdResult> {
  const cfg = getRedditAdsConfig();
  if (!cfg) return { status: 'skipped', reason: 'not_configured' };

  const doc = await db.collection('campaigns').doc(campaignId).get();
  if (!doc.exists) throw new Error('Campaign not found');
  const data = doc.data() as Record<string, any>;

  if (data?.status !== 'Approved') {
    return { status: 'skipped', reason: 'not_approved' };
  }
  const existing = String(data?.reddit_ads_campaign_id ?? '').trim();
  if (existing && !options.force) {
    return { status: 'skipped', reason: 'already_created', adCampaignId: existing };
  }

  // Surfaced rather than blocking: a paused campaign is still worth creating so it
  // is ready the moment billing is sorted, but the caller should know it can't run.
  const funding = await getRedditFundingStatus(cfg);

  const created = await adsApi<any>(cfg, 'POST', `/ad_accounts/${cfg.adAccountId}/campaigns`, {
    name: adCampaignName(data, campaignId),
    objective: options.objective || 'CLICKS',
    funding_instrument_id: cfg.fundingInstrumentId,
    // Never ACTIVE from code. A human activates it in Reddit Ads Manager.
    configured_status: 'PAUSED',
  });

  const adCampaignId = String(created?.id ?? '').trim();
  if (!adCampaignId) {
    throw new Error('Reddit accepted the request but returned no campaign id');
  }

  await db.collection('campaigns').doc(campaignId).update({
    reddit_ads_campaign_id: adCampaignId,
    reddit_ads_account_id: cfg.adAccountId,
    reddit_ads_status: 'PAUSED',
    reddit_ads_created_at: new Date(),
  });

  return {
    status: 'created',
    adCampaignId,
    unfunded: !funding.servable,
    ...(funding.servable ? {} : { reason: funding.reasons.join(', ') }),
  };
}

/** Reddit has no DELETE; archiving is how a campaign is retired. */
export async function archiveRedditAdCampaign(adCampaignId: string): Promise<void> {
  const cfg = getRedditAdsConfig();
  if (!cfg) throw new Error('Reddit Ads is not configured');
  await adsApi(cfg, 'PATCH', `/campaigns/${adCampaignId}`, { configured_status: 'ARCHIVED' });
}
