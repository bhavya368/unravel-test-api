/**
 * Impact report KPI definitions — Meta engagement + perception shift methodology.
 * @see docs/meta-impact-metrics.md
 */

export interface MetaActionRow {
  action_type: string;
  value: number;
}

export interface PerceptionShiftSignals {
  shares: number;
  saves: number;
  follows: number;
  linkClicks: number;
  videoCompletions: number;
  impressions: number;
  isVideoAd: boolean;
}

const SHARE_TYPES = new Set(['post', 'post_share', 'share']);
const SAVE_TYPES = new Set(['onsite_conversion.post_save', 'post_save', 'save']);
const FOLLOW_TYPES = new Set(['like', 'follow', 'page_engagement']);
const LINK_CLICK_TYPES = new Set(['link_click', 'inline_link_click']);
const VIDEO_VIEW_TYPES = new Set(['video_view']);
const EXCLUDED_PERCEPTION_TYPES = new Set(['comment', 'post_reaction', 'post_comment']);

export function parseFacebookActions(raw: unknown): MetaActionRow[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const row = item as Record<string, unknown>;
      const actionType = String(row.action_type || '').trim();
      if (!actionType) return null;
      const value = Number(row.value);
      return { action_type: actionType, value: Number.isFinite(value) ? value : 0 };
    })
    .filter((item): item is MetaActionRow => Boolean(item));
}

function sumActionTypes(actions: MetaActionRow[], types: Set<string>): number {
  return actions.reduce((sum, row) => {
    const key = row.action_type.toLowerCase();
    if (types.has(key)) return sum + row.value;
    return sum;
  }, 0);
}

function getActionValue(actions: MetaActionRow[], type: string): number {
  const key = type.toLowerCase();
  const row = actions.find((a) => a.action_type.toLowerCase() === key);
  return row?.value ?? 0;
}

/** Hand-picked active Actions KPI: shares + saves + follows + link clicks. */
export function computeEngagementActions(
  actions: MetaActionRow[],
  options: {
    storedPostEngagement?: number;
    storedVideoViews?: number;
    fallbackInlineClicks?: number;
  } = {}
): number {
  const shares = sumActionTypes(actions, SHARE_TYPES);
  const saves = sumActionTypes(actions, SAVE_TYPES);
  const follows = sumActionTypes(actions, FOLLOW_TYPES);
  const linkClicks =
    sumActionTypes(actions, LINK_CLICK_TYPES) || Number(options.fallbackInlineClicks) || 0;

  return Math.max(0, Math.round(shares + saves + follows + linkClicks));
}

export function extractPerceptionShiftSignals(
  actions: MetaActionRow[],
  impressions: number,
  videoP75Watched = 0
): PerceptionShiftSignals {
  const shares = sumActionTypes(actions, SHARE_TYPES);
  const saves = sumActionTypes(actions, SAVE_TYPES);
  const follows = sumActionTypes(actions, FOLLOW_TYPES);
  const linkClicks =
    sumActionTypes(actions, LINK_CLICK_TYPES) || getActionValue(actions, 'inline_link_click');
  const videoCompletions =
    videoP75Watched > 0 ? videoP75Watched : sumActionTypes(actions, VIDEO_VIEW_TYPES);

  return {
    shares,
    saves,
    follows,
    linkClicks,
    videoCompletions,
    impressions: Math.max(0, impressions),
    isVideoAd: videoCompletions > 0,
  };
}

/**
 * Perception Shift Score =
 * (Shares + Saves + Follows + 0.80 × (Link Clicks + Video Completions)) / Impressions × 100
 */
export function computePerceptionShiftScore(signals: PerceptionShiftSignals): number {
  const { shares, saves, follows, linkClicks, videoCompletions, impressions } = signals;
  if (!impressions) return 0;

  const numerator = shares + saves + follows + 0.8 * (linkClicks + videoCompletions);
  return Math.round((numerator / impressions) * 1000) / 10;
}

export function computePerceptionShiftFromMetaActions(
  actions: MetaActionRow[],
  impressions: number,
  videoP75Watched = 0
): { score: number; signals: PerceptionShiftSignals; source: 'actual' | 'estimated' } {
  const signals = extractPerceptionShiftSignals(actions, impressions, videoP75Watched);
  const hasSignals =
    signals.shares > 0 ||
    signals.saves > 0 ||
    signals.follows > 0 ||
    signals.linkClicks > 0 ||
    signals.videoCompletions > 0;

  if (!hasSignals || !impressions) {
    return { score: 0, signals, source: 'estimated' };
  }

  return {
    score: computePerceptionShiftScore(signals),
    signals,
    source: 'actual',
  };
}

/** Total dollars contributed to a campaign (denominator for personal impact). */
export function getCampaignTotalContributionCents(campaign: {
  funding_current?: number;
  amount_raised?: number;
  funding_raised?: number;
  funding_goal?: number;
}): number {
  const raised =
    Number(campaign?.funding_current ?? campaign?.amount_raised ?? campaign?.funding_raised ?? 0) ||
    0;
  if (raised > 0) return Math.round(raised * 100);
  const goal = Number(campaign?.funding_goal) || 0;
  return goal > 0 ? Math.round(goal * 100) : 0;
}
