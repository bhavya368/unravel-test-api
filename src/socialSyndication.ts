import { type Firestore } from 'firebase-admin/firestore';

/**
 * Cross-posts approved campaigns to Unravel's own X and Reddit accounts for reach.
 *
 * Mirrors `publishFacebookAdForCampaign` in index.ts: load the campaign, refuse
 * anything that isn't Approved, push to the platform, then record the resulting
 * post id back on the campaign doc.
 *
 * Two deliberate differences from the Facebook path:
 *  - Posting is idempotent. The recorded post id short-circuits a second attempt,
 *    so an admin double-click or a ts-node-dev respawn can't double-post to a
 *    public brand account. Pass `force` to override.
 *  - Failures are values, not exceptions. `syndicateApprovedCampaign` never throws,
 *    so a dead X token can't roll back a campaign approval.
 *
 * Link previews need no work here: the OG/twitter:card tags served in index.ts
 * already cover `twitterbot` and `redditbot`, so posting the bare campaign URL
 * renders a card with the hero image.
 */

const X_TOKEN_URL = 'https://api.x.com/2/oauth2/token';
const X_TWEETS_URL = 'https://api.x.com/2/tweets';
const REDDIT_TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const REDDIT_SUBMIT_URL = 'https://oauth.reddit.com/api/submit';

/** X counts every link as this many characters regardless of real length (t.co). */
const X_LINK_WEIGHT = 23;
const X_MAX_CHARS = 280;
const REDDIT_MAX_TITLE = 300;

/** Firestore doc holding rotated OAuth tokens. Cloud Run has no persistent disk. */
const INTEGRATION_COLLECTION = 'integrations';

export type SyndicationPlatform = 'x' | 'reddit';

export interface SyndicationResult {
  platform: SyndicationPlatform;
  status: 'posted' | 'skipped' | 'failed';
  /** Platform-native id of the created post, when status is 'posted'. */
  postId?: string;
  /** Permalink to the created post, when the platform returns one. */
  url?: string;
  /** Why it was skipped — 'not_configured' | 'already_posted' | 'not_approved'. */
  reason?: string;
  error?: string;
}

interface PublishOptions {
  /** Post again even if this campaign already has a recorded post id. */
  force?: boolean;
  /** Reddit only: override the configured target subreddit. */
  subreddit?: string;
}

interface XConfig {
  clientId: string;
  clientSecret: string;
  /** Seed refresh token; the live one is kept in Firestore because X rotates it. */
  seedRefreshToken: string;
}

interface RedditConfig {
  clientId: string;
  clientSecret: string;
  userAgent: string;
  subreddit: string;
  refreshToken?: string;
  username?: string;
  password?: string;
}

const env = (name: string): string => (process.env[name] || '').trim();

/** Returns null (rather than throwing) when unconfigured, matching the PostHog pattern. */
export function getXConfig(): XConfig | null {
  const clientId = env('X_CLIENT_ID');
  const clientSecret = env('X_CLIENT_SECRET');
  const seedRefreshToken = env('X_REFRESH_TOKEN');
  if (!clientId || !clientSecret || !seedRefreshToken) return null;
  return { clientId, clientSecret, seedRefreshToken };
}

export function getRedditConfig(): RedditConfig | null {
  const clientId = env('REDDIT_CLIENT_ID');
  const clientSecret = env('REDDIT_CLIENT_SECRET');
  const subreddit = env('REDDIT_SUBREDDIT').replace(/^\/?r\//i, '');
  // Reddit 429s generic user agents; the format is enforced by their API docs.
  const userAgent = env('REDDIT_USER_AGENT') || 'web:network.unravel.syndication:v1.0';
  const refreshToken = env('REDDIT_REFRESH_TOKEN');
  const username = env('REDDIT_USERNAME');
  const password = env('REDDIT_PASSWORD');
  if (!clientId || !clientSecret || !subreddit) return null;
  // Needs a user context to submit: either a stored refresh token or script creds.
  if (!refreshToken && !(username && password)) return null;
  return { clientId, clientSecret, userAgent, subreddit, refreshToken, username, password };
}

/**
 * Whether approval should cross-post automatically. Deliberately separate from
 * having credentials: the campaigns DB is the live one even in local dev — the
 * named 'unravel' database ignores FIRESTORE_EMULATOR_HOST — so approving a
 * campaign on a laptop touches real rows, and must not reach real followers by
 * accident. Admins can always post manually from the review queue.
 */
export function isAutoSyndicationEnabled(): boolean {
  return env('SOCIAL_SYNDICATION_AUTO').toLowerCase() === 'true';
}

const basicAuth = (id: string, secret: string): string =>
  `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`;

/**
 * First value that is a non-blank string, else ''. Campaign docs carry empty
 * strings for skipped fields, which `??` would happily pass through.
 */
function firstNonEmpty(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed) return trimmed;
  }
  return '';
}

/** Trim to `max` on a word boundary, adding an ellipsis only when something was cut. */
function truncate(text: string, max: number): string {
  const clean = (text || '').replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;
  const cut = clean.slice(0, max - 1);
  const lastSpace = cut.lastIndexOf(' ');
  return `${(lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).trimEnd()}…`;
}

/**
 * Public campaign link. FRONTEND_BASE_URL is stored without a scheme in some
 * environments (`unravel.network`), so add one — same normalisation the OG tags
 * use. A bare host would be rejected by Reddit's link submit and posted as plain
 * text by X.
 */
function campaignLandingUrl(campaignId: string): string {
  const raw = (process.env.FRONTEND_BASE_URL || process.env.FRONTEND_ORIGIN || '')
    .split(',')[0]
    .trim()
    .replace(/\/$/, '');
  if (!raw) throw new Error('Set FRONTEND_BASE_URL (or FRONTEND_ORIGIN) to build campaign links');
  const base = /^https?:\/\//i.test(raw) ? raw : `https://${raw.replace(/^\/+/, '')}`;
  return `${base}/campaign/${campaignId}`;
}

/**
 * Post copy for X. Reuses the ad primary text the creator already wrote in the
 * Ad Preview section, falling back to the campaign's short description.
 */
export function buildXPostText(campaign: Record<string, any>, landingUrl: string): string {
  const title = firstNonEmpty(campaign?.title) || 'New campaign on Unravel';
  const body =
    firstNonEmpty(campaign?.ad_primary_text, campaign?.short_description, campaign?.tagline) || '';
  // The URL is appended on its own line, so budget for it plus two newlines.
  const budget = X_MAX_CHARS - X_LINK_WEIGHT - 2;
  const headline = truncate(title, Math.min(budget, 120));
  const remaining = budget - headline.length - 1;
  const blurb = remaining > 24 ? truncate(body, remaining) : '';
  return `${[headline, blurb].filter(Boolean).join('\n\n')}\n${landingUrl}`;
}

export function buildRedditTitle(campaign: Record<string, any>): string {
  const title = firstNonEmpty(campaign?.title) || 'New campaign on Unravel';
  const category = firstNonEmpty(campaign?.category);
  // A bare title reads as spam; the category prefix gives subreddit readers context.
  const prefix = category ? `[${category}] ` : '';
  return truncate(`${prefix}${title}`, REDDIT_MAX_TITLE);
}

// ---------------------------------------------------------------- X (Twitter)

/**
 * X rotates the refresh token on every use, so the newest one is persisted to
 * Firestore. Losing it means redoing the OAuth2 PKCE flow by hand.
 */
async function getXAccessToken(db: Firestore, cfg: XConfig): Promise<string> {
  const ref = db.collection(INTEGRATION_COLLECTION).doc('x');
  const snap = await ref.get();
  const stored = (snap.exists ? snap.data() : {}) as Record<string, any>;

  const cachedToken = String(stored?.access_token ?? '');
  const expiresAtMs = Number(stored?.access_token_expires_at_ms ?? 0);
  // 60s of slack so a token can't expire mid-request.
  if (cachedToken && expiresAtMs > Date.now() + 60_000) return cachedToken;

  const refreshToken = String(stored?.refresh_token ?? '') || cfg.seedRefreshToken;
  const res = await fetch(X_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(cfg.clientId, cfg.clientSecret),
    },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: cfg.clientId,
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !payload?.access_token) {
    const detail = payload?.error_description || payload?.error || `HTTP ${res.status}`;
    throw new Error(
      `X token refresh failed (${detail}). If the refresh token was revoked or already ` +
        `rotated elsewhere, redo the OAuth2 PKCE flow and reset X_REFRESH_TOKEN.`
    );
  }

  const accessToken = String(payload.access_token);
  await ref.set(
    {
      access_token: accessToken,
      access_token_expires_at_ms: Date.now() + Number(payload.expires_in ?? 7200) * 1000,
      // X returns a fresh refresh token; the old one is dead the moment this succeeds.
      refresh_token: String(payload.refresh_token ?? refreshToken),
      updated_at: new Date(),
    },
    { merge: true }
  );
  return accessToken;
}

/**
 * Read-only health check: refresh the token and ask X who we are.
 *
 * Deliberately posts nothing. Goes through `getXAccessToken` rather than
 * re-implementing the refresh, so the rotated token is persisted the same way a
 * real post would persist it — checking with a throwaway refresh would burn the
 * stored token and leave the next post unable to authenticate.
 */
export async function verifyXConnection(
  db: Firestore
): Promise<{ ok: boolean; handle?: string; scopes?: string; error?: string }> {
  const cfg = getXConfig();
  if (!cfg) return { ok: false, error: 'not_configured' };
  try {
    const accessToken = await getXAccessToken(db, cfg);
    const res = await fetch('https://api.x.com/2/users/me', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || !payload?.data?.username) {
      const detail = payload?.detail || payload?.title || `HTTP ${res.status}`;
      return { ok: false, error: String(detail) };
    }
    return { ok: true, handle: payload.data.username };
  } catch (error: unknown) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

export async function publishCampaignToX(
  db: Firestore,
  campaignId: string,
  options: PublishOptions = {}
): Promise<SyndicationResult> {
  const cfg = getXConfig();
  if (!cfg) {
    return { platform: 'x', status: 'skipped', reason: 'not_configured' };
  }

  const doc = await db.collection('campaigns').doc(campaignId).get();
  if (!doc.exists) throw new Error('Campaign not found');
  const data = doc.data() as Record<string, any>;

  if (data?.status !== 'Approved') {
    return { platform: 'x', status: 'skipped', reason: 'not_approved' };
  }
  const existing = String(data?.x_post_id ?? '').trim();
  if (existing && !options.force) {
    return { platform: 'x', status: 'skipped', reason: 'already_posted', postId: existing };
  }

  const landingUrl = campaignLandingUrl(campaignId);
  const text = buildXPostText(data, landingUrl);
  const accessToken = await getXAccessToken(db, cfg);

  const res = await fetch(X_TWEETS_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({ text }),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !payload?.data?.id) {
    const detail =
      payload?.detail || payload?.title || payload?.errors?.[0]?.message || `HTTP ${res.status}`;
    throw new Error(`X post failed: ${detail}`);
  }

  const postId = String(payload.data.id);
  const handle = env('X_ACCOUNT_HANDLE') || 'i';
  const url = `https://x.com/${handle}/status/${postId}`;
  await db.collection('campaigns').doc(campaignId).update({
    x_post_id: postId,
    x_post_url: url,
    x_published_at: new Date(),
  });
  return { platform: 'x', status: 'posted', postId, url };
}

// ------------------------------------------------------------------- Reddit

/** Reddit access tokens last ~24h and its refresh tokens don't rotate, so cache in memory. */
let redditTokenCache: { token: string; expiresAtMs: number } | null = null;

async function getRedditAccessToken(cfg: RedditConfig): Promise<string> {
  if (redditTokenCache && redditTokenCache.expiresAtMs > Date.now() + 60_000) {
    return redditTokenCache.token;
  }

  // A stored refresh token is preferred; script-app password grant breaks under 2FA.
  const body = cfg.refreshToken
    ? new URLSearchParams({ grant_type: 'refresh_token', refresh_token: cfg.refreshToken })
    : new URLSearchParams({
        grant_type: 'password',
        username: cfg.username ?? '',
        password: cfg.password ?? '',
      });

  const res = await fetch(REDDIT_TOKEN_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuth(cfg.clientId, cfg.clientSecret),
      'User-Agent': cfg.userAgent,
    },
    body,
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !payload?.access_token) {
    const detail = payload?.error || `HTTP ${res.status}`;
    throw new Error(`Reddit token request failed: ${detail}`);
  }

  const token = String(payload.access_token);
  redditTokenCache = {
    token,
    expiresAtMs: Date.now() + Number(payload.expires_in ?? 3600) * 1000,
  };
  return token;
}

export async function publishCampaignToReddit(
  db: Firestore,
  campaignId: string,
  options: PublishOptions = {}
): Promise<SyndicationResult> {
  const cfg = getRedditConfig();
  if (!cfg) {
    return { platform: 'reddit', status: 'skipped', reason: 'not_configured' };
  }

  const doc = await db.collection('campaigns').doc(campaignId).get();
  if (!doc.exists) throw new Error('Campaign not found');
  const data = doc.data() as Record<string, any>;

  if (data?.status !== 'Approved') {
    return { platform: 'reddit', status: 'skipped', reason: 'not_approved' };
  }
  const existing = String(data?.reddit_post_id ?? '').trim();
  if (existing && !options.force) {
    return { platform: 'reddit', status: 'skipped', reason: 'already_posted', postId: existing };
  }

  const subreddit = (options.subreddit || cfg.subreddit).replace(/^\/?r\//i, '');
  const landingUrl = campaignLandingUrl(campaignId);
  const accessToken = await getRedditAccessToken(cfg);

  const res = await fetch(REDDIT_SUBMIT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Bearer ${accessToken}`,
      'User-Agent': cfg.userAgent,
    },
    body: new URLSearchParams({
      api_type: 'json',
      kind: 'link',
      sr: subreddit,
      title: buildRedditTitle(data),
      url: landingUrl,
      resubmit: 'true',
      sendreplies: 'true',
    }),
  });
  const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok) {
    throw new Error(`Reddit submit failed: HTTP ${res.status}`);
  }
  // Reddit returns 200 with an errors array for rule violations, rate limits and bans.
  const errors = payload?.json?.errors;
  if (Array.isArray(errors) && errors.length > 0) {
    const [code, message] = errors[0];
    throw new Error(`Reddit rejected the post (${code}): ${message}`);
  }

  const submitted = payload?.json?.data ?? {};
  const postId = String(submitted?.id ?? submitted?.name ?? '').trim();
  const url = String(submitted?.url ?? '').trim();
  if (!postId) {
    throw new Error('Reddit accepted the request but returned no post id');
  }

  await db.collection('campaigns').doc(campaignId).update({
    reddit_post_id: postId,
    reddit_post_url: url,
    reddit_subreddit: subreddit,
    reddit_published_at: new Date(),
  });
  return { platform: 'reddit', status: 'posted', postId, url };
}

// ------------------------------------------------------------------ combined

/**
 * Fire-and-report syndication for a campaign that just became Approved.
 *
 * Never throws. Approval already created a Stripe product by this point, so a
 * platform outage must not surface as a failed approval — failures are logged
 * and returned for the caller to record.
 */
export async function syndicateApprovedCampaign(
  db: Firestore,
  campaignId: string,
  options: PublishOptions = {}
): Promise<SyndicationResult[]> {
  const tasks: Array<[SyndicationPlatform, Promise<SyndicationResult>]> = [
    ['x', publishCampaignToX(db, campaignId, options)],
    ['reddit', publishCampaignToReddit(db, campaignId, options)],
  ];

  const results = await Promise.all(
    tasks.map(async ([platform, task]): Promise<SyndicationResult> => {
      try {
        return await task;
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`[syndication] ${platform} failed for campaign ${campaignId}:`, message);
        return { platform, status: 'failed', error: message };
      }
    })
  );

  const posted = results.filter(r => r.status === 'posted').map(r => r.platform);
  if (posted.length > 0) {
    console.log(`[syndication] campaign ${campaignId} posted to: ${posted.join(', ')}`);
  }
  return results;
}
