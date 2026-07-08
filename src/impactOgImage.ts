import { Resvg } from '@resvg/resvg-js';
import { formatCompactNumber } from './impactMetrics';

export type ImpactShareCardScope = 'cumulative' | 'campaign';

export interface ImpactShareCardPayload {
  scope: ImpactShareCardScope;
  displayName: string;
  headlineTitle?: string;
  metrics: Record<string, unknown>;
}

export const IMPACT_OG_WIDTH = 1200;
export const IMPACT_OG_HEIGHT = 630;

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncate(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

function formatShift(metrics: Record<string, unknown>): string | null {
  const raw = metrics.perceptionShift ?? metrics.avgPerceptionShift;
  if (raw == null) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return `+${n}%`;
}

function buildTitle(payload: ImpactShareCardPayload): string {
  const { displayName, scope, headlineTitle, metrics } = payload;
  const campaignTitle =
    typeof metrics.campaignTitle === 'string' ? metrics.campaignTitle.trim() : '';

  if (headlineTitle?.trim()) return headlineTitle.trim();
  if (scope === 'campaign' && campaignTitle) {
    return `${displayName} · ${campaignTitle}`;
  }
  return `${displayName}'s impact`;
}

function buildSubtitle(payload: ImpactShareCardPayload): string {
  const { scope, metrics } = payload;
  if (scope === 'campaign') {
    const sharePct = metrics.sharePct;
    if (sharePct != null && Number.isFinite(Number(sharePct))) {
      return `${sharePct}% of this campaign's budget — attributed reach and engagement.`;
    }
    const campaignTitle =
      typeof metrics.campaignTitle === 'string' ? metrics.campaignTitle.trim() : '';
    if (campaignTitle) return `Personal impact from backing ${campaignTitle}.`;
    return 'Personal impact from backing a campaign on The Unravel Network.';
  }

  const campaignsBacked = metrics.campaignsBacked;
  if (campaignsBacked != null && Number.isFinite(Number(campaignsBacked))) {
    const count = Number(campaignsBacked);
    return `Across ${count} campaign${count === 1 ? '' : 's'} on The Unravel Network.`;
  }
  return 'Personal impact from backing evaluated campaigns on The Unravel Network.';
}

/** SVG template for OG previews — mirrors unravel-ui SharedImpactCard styling. */
export function buildImpactOgSvg(payload: ImpactShareCardPayload): string {
  const metrics = payload.metrics || {};
  const title = truncate(buildTitle(payload), 72);
  const subtitle = truncate(buildSubtitle(payload), 110);
  const reached = formatCompactNumber(Number(metrics.peopleReached) || 0);
  const views = formatCompactNumber(Number(metrics.personalViews) || 0);
  const actions = formatCompactNumber(Number(metrics.personalActions) || 0);
  const reconsidered = formatCompactNumber(Number(metrics.reconsidered) || 0);
  const shift = formatShift(metrics);

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${IMPACT_OG_WIDTH}" height="${IMPACT_OG_HEIGHT}" viewBox="0 0 ${IMPACT_OG_WIDTH} ${IMPACT_OG_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#E8F1FB"/>
      <stop offset="52%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#FBEDEA"/>
    </linearGradient>
    <linearGradient id="cardBorder" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#1A6BBF" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#C94F3D" stop-opacity="0.2"/>
    </linearGradient>
    <filter id="shadow" x="-8%" y="-8%" width="116%" height="116%">
      <feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#1A6BBF" flood-opacity="0.12"/>
    </filter>
  </defs>

  <rect width="${IMPACT_OG_WIDTH}" height="${IMPACT_OG_HEIGHT}" fill="url(#bg)"/>

  <g filter="url(#shadow)">
    <rect x="72" y="48" width="1056" height="534" rx="28" fill="#FFFFFF" stroke="url(#cardBorder)" stroke-width="3"/>
  </g>

  <line x1="120" y1="198" x2="1080" y2="198" stroke="#1A6BBF" stroke-opacity="0.12" stroke-width="2"/>

  <g transform="translate(120, 84)">
    <circle cx="10" cy="10" r="4" fill="#1A6BBF"/>
    <circle cx="22" cy="6" r="3" fill="#1A6BBF" fill-opacity="0.75"/>
    <circle cx="30" cy="14" r="2.5" fill="#1A6BBF" fill-opacity="0.55"/>
    <text x="44" y="16" fill="#1A6BBF" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="18" font-weight="700" letter-spacing="2.2">PERSONAL IMPACT</text>
  </g>

  <text x="120" y="154" fill="#0F172A" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="44" font-weight="800">${escapeXml(title)}</text>
  <text x="120" y="186" fill="#64748B" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="22" font-weight="500">${escapeXml(subtitle)}</text>

  <rect x="120" y="228" width="960" height="132" rx="18" fill="#FFFFFF" stroke="#1A6BBF" stroke-opacity="0.18" stroke-width="2"/>
  <text x="600" y="302" text-anchor="middle" fill="#1A6BBF" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="64" font-weight="800">${escapeXml(reached)}</text>
  <text x="600" y="338" text-anchor="middle" fill="#64748B" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="16" font-weight="700" letter-spacing="1.8">PEOPLE REACHED ON THEIR BEHALF</text>

  <rect x="120" y="384" width="468" height="108" rx="16" fill="#FFFFFF" fill-opacity="0.92" stroke="#1A6BBF" stroke-opacity="0.12" stroke-width="2"/>
  <text x="354" y="442" text-anchor="middle" fill="#0F172A" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="40" font-weight="800">${escapeXml(views)}</text>
  <text x="354" y="472" text-anchor="middle" fill="#64748B" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="13" font-weight="700" letter-spacing="1.6">VIEWS</text>

  <rect x="612" y="384" width="468" height="108" rx="16" fill="#FFFFFF" fill-opacity="0.92" stroke="#1A6BBF" stroke-opacity="0.12" stroke-width="2"/>
  <text x="846" y="442" text-anchor="middle" fill="#0F172A" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="40" font-weight="800">${escapeXml(actions)}</text>
  <text x="846" y="472" text-anchor="middle" fill="#64748B" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="13" font-weight="700" letter-spacing="1.6">ACTIONS</text>

  ${
    shift
      ? `<rect x="120" y="510" width="468" height="56" rx="14" fill="#FBEDEA"/>
  <text x="354" y="548" text-anchor="middle" fill="#C94F3D" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="30" font-weight="800">${escapeXml(shift)}</text>
  <text x="354" y="572" text-anchor="middle" fill="#64748B" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="11" font-weight="700" letter-spacing="1.4">PERCEPTION SHIFT</text>`
      : ''
  }

  <rect x="${shift ? 612 : 120}" y="510" width="${shift ? 468 : 960}" height="56" rx="14" fill="#FBEDEA"/>
  <text x="${shift ? 846 : 600}" y="548" text-anchor="middle" fill="#C94F3D" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="30" font-weight="800">~${escapeXml(reconsidered)}</text>
  <text x="${shift ? 846 : 600}" y="572" text-anchor="middle" fill="#64748B" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="11" font-weight="700" letter-spacing="1.4">RECONSIDERED</text>

  <text x="120" y="598" fill="#94A3B8" font-family="ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif" font-size="18" font-weight="600">The Unravel Network</text>
  <circle cx="1080" cy="586" r="14" fill="#1A6BBF"/>
  <path d="M1073 586 L1078 591 L1088 579" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

export function renderImpactOgPng(payload: ImpactShareCardPayload): Buffer {
  const svg = buildImpactOgSvg(payload);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: IMPACT_OG_WIDTH },
  });
  return Buffer.from(resvg.render().asPng());
}
