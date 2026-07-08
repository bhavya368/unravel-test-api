import path from 'path';
import { createRequire } from 'module';
import { Resvg } from '@resvg/resvg-js';
import { formatCompactNumber } from './impactMetrics';

const nodeRequire = createRequire(__filename);
const FONT_FAMILY = 'Roboto, DejaVu Sans, sans-serif';

const CARD_X = 72;
const CARD_Y = 48;
const CARD_WIDTH = 1056;
const CARD_HEIGHT = 534;
const CONTENT_X = 120;
const CONTENT_WIDTH = 960;
const TITLE_WIDTH = 820;

type RobotoWeight = 500 | 700 | 900;

function getRobotoFontFiles(): string[] {
  const base = path.join(
    path.dirname(nodeRequire.resolve('@fontsource/roboto/package.json')),
    'files',
  );
  return [400, 500, 700, 900].map((weight) =>
    path.join(base, `roboto-latin-${weight}-normal.woff`),
  );
}

function measureText(text: string, fontSize: number, weight: RobotoWeight): number {
  const weightScale = weight >= 900 ? 1.08 : weight >= 700 ? 1.02 : 1;
  let width = 0;
  for (const ch of text) {
    if (ch === ' ') width += fontSize * 0.28;
    else if (/[ilI1'`.,:;]/.test(ch)) width += fontSize * 0.3;
    else if (/[mwMW]/.test(ch)) width += fontSize * 0.85;
    else if (/[A-Z]/.test(ch)) width += fontSize * 0.66;
    else width += fontSize * 0.54;
  }
  return width * weightScale;
}

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

function wrapText(
  text: string,
  maxWidth: number,
  fontSize: number,
  weight: RobotoWeight,
  maxLines?: number,
): string[] {
  const words = String(text || '')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return [];

  const lines: string[] = [];
  let current = '';

  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (measureText(candidate, fontSize, weight) > maxWidth && current) {
      lines.push(current);
      current = word;
      if (maxLines != null && lines.length >= maxLines) break;
    } else {
      current = candidate;
    }
  }

  if (current && (maxLines == null || lines.length < maxLines)) {
    lines.push(current);
  } else if (maxLines != null && lines.length >= maxLines && current) {
    const last = lines[maxLines - 1];
    let trimmed = last;
    while (trimmed.length > 1 && measureText(`${trimmed}…`, fontSize, weight) > maxWidth) {
      trimmed = trimmed.slice(0, -1);
    }
    lines[maxLines - 1] = `${trimmed}…`;
  }

  return maxLines != null ? lines.slice(0, maxLines) : lines;
}

function pickTitleStyle(text: string): { fontSize: number; lineHeight: number; maxLines: number } {
  const candidates = [
    { fontSize: 36, lineHeight: 42, maxLines: 2 },
    { fontSize: 31, lineHeight: 37, maxLines: 3 },
    { fontSize: 27, lineHeight: 32, maxLines: 4 },
  ];

  for (const style of candidates) {
    const lines = wrapText(text, TITLE_WIDTH, style.fontSize, 900);
    if (lines.length <= style.maxLines) return style;
  }

  return candidates[candidates.length - 1];
}

function textBlockHeight(lines: string[], fontSize: number, lineHeight: number): number {
  if (!lines.length) return 0;
  return fontSize + (lines.length - 1) * lineHeight;
}

function baselineFromTop(top: number, fontSize: number): number {
  return top + fontSize * 0.82;
}

function multilineText(
  lines: string[],
  x: number,
  startY: number,
  fontSize: number,
  lineHeight: number,
  weight: RobotoWeight,
  fill: string,
): string {
  if (!lines.length) return '';

  const tspans = lines
    .map((line, index) => {
      const dy = index === 0 ? 0 : lineHeight;
      return `<tspan x="${x}" dy="${dy}">${escapeXml(line)}</tspan>`;
    })
    .join('');

  return `<text x="${x}" y="${startY}" fill="${fill}" font-family="${FONT_FAMILY}" font-size="${fontSize}" font-weight="${weight}">${tspans}</text>`;
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
  const titleText = buildTitle(payload);
  const titleStyle = pickTitleStyle(titleText);
  const titleLines = wrapText(
    titleText,
    TITLE_WIDTH,
    titleStyle.fontSize,
    900,
    titleStyle.maxLines,
  );
  const subtitleLines = wrapText(buildSubtitle(payload), CONTENT_WIDTH, 22, 500, 2);

  const titleTop = 122;
  const titleStartY = baselineFromTop(titleTop, titleStyle.fontSize);
  const titleBlockHeight = textBlockHeight(
    titleLines,
    titleStyle.fontSize,
    titleStyle.lineHeight,
  );
  const subtitleTop = titleTop + titleBlockHeight + (subtitleLines.length ? 14 : 0);
  const subtitleStartY = baselineFromTop(subtitleTop, 22);
  const subtitleLineHeight = 28;
  const subtitleBlockHeight = textBlockHeight(subtitleLines, 22, subtitleLineHeight);
  const dividerY = Math.max(218, subtitleTop + subtitleBlockHeight + 18);
  const metricsTop = dividerY + 18;

  const mainBoxHeight = 100;
  const secondaryTop = metricsTop + mainBoxHeight + 12;
  const secondaryHeight = 78;
  const bottomTop = secondaryTop + secondaryHeight + 10;
  const bottomHeight = 48;

  const reached = formatCompactNumber(Number(metrics.peopleReached) || 0);
  const views = formatCompactNumber(Number(metrics.personalViews) || 0);
  const actions = formatCompactNumber(Number(metrics.personalActions) || 0);
  const reconsidered = formatCompactNumber(Number(metrics.reconsidered) || 0);
  const shift = formatShift(metrics);

  const mainValueY = metricsTop + 62;
  const mainLabelY = metricsTop + 84;
  const secondaryValueY = secondaryTop + 48;
  const secondaryLabelY = secondaryTop + 66;
  const bottomValueY = bottomTop + 30;
  const bottomLabelY = bottomTop + 43;
  const footerY = CARD_Y + CARD_HEIGHT - 26;
  const footerIconY = CARD_Y + CARD_HEIGHT - 28;

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
    <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="28" fill="#FFFFFF" stroke="url(#cardBorder)" stroke-width="3"/>
  </g>

  <line x1="${CONTENT_X}" y1="${dividerY}" x2="${CONTENT_X + CONTENT_WIDTH}" y2="${dividerY}" stroke="#1A6BBF" stroke-opacity="0.12" stroke-width="2"/>

  <g transform="translate(${CONTENT_X}, 84)">
    <circle cx="10" cy="10" r="4" fill="#1A6BBF"/>
    <circle cx="22" cy="6" r="3" fill="#1A6BBF" fill-opacity="0.75"/>
    <circle cx="30" cy="14" r="2.5" fill="#1A6BBF" fill-opacity="0.55"/>
    <text x="44" y="16" fill="#1A6BBF" font-family="${FONT_FAMILY}" font-size="18" font-weight="700">PERSONAL IMPACT</text>
  </g>

  ${multilineText(titleLines, CONTENT_X, titleStartY, titleStyle.fontSize, titleStyle.lineHeight, 900, '#0F172A')}
  ${multilineText(subtitleLines, CONTENT_X, subtitleStartY, 22, subtitleLineHeight, 500, '#64748B')}

  <rect x="${CONTENT_X}" y="${metricsTop}" width="${CONTENT_WIDTH}" height="${mainBoxHeight}" rx="18" fill="#FFFFFF" stroke="#1A6BBF" stroke-opacity="0.18" stroke-width="2"/>
  <text x="600" y="${mainValueY}" text-anchor="middle" fill="#1A6BBF" font-family="${FONT_FAMILY}" font-size="58" font-weight="900">${escapeXml(reached)}</text>
  <text x="600" y="${mainLabelY}" text-anchor="middle" fill="#64748B" font-family="${FONT_FAMILY}" font-size="15" font-weight="700">PEOPLE REACHED ON THEIR BEHALF</text>

  <rect x="${CONTENT_X}" y="${secondaryTop}" width="468" height="${secondaryHeight}" rx="16" fill="#FFFFFF" fill-opacity="0.92" stroke="#1A6BBF" stroke-opacity="0.12" stroke-width="2"/>
  <text x="354" y="${secondaryValueY}" text-anchor="middle" fill="#0F172A" font-family="${FONT_FAMILY}" font-size="36" font-weight="900">${escapeXml(views)}</text>
  <text x="354" y="${secondaryLabelY}" text-anchor="middle" fill="#64748B" font-family="${FONT_FAMILY}" font-size="12" font-weight="700">VIEWS</text>

  <rect x="612" y="${secondaryTop}" width="468" height="${secondaryHeight}" rx="16" fill="#FFFFFF" fill-opacity="0.92" stroke="#1A6BBF" stroke-opacity="0.12" stroke-width="2"/>
  <text x="846" y="${secondaryValueY}" text-anchor="middle" fill="#0F172A" font-family="${FONT_FAMILY}" font-size="36" font-weight="900">${escapeXml(actions)}</text>
  <text x="846" y="${secondaryLabelY}" text-anchor="middle" fill="#64748B" font-family="${FONT_FAMILY}" font-size="12" font-weight="700">ACTIONS</text>

  ${
    shift
      ? `<rect x="${CONTENT_X}" y="${bottomTop}" width="468" height="${bottomHeight}" rx="14" fill="#FBEDEA"/>
  <text x="354" y="${bottomValueY}" text-anchor="middle" fill="#C94F3D" font-family="${FONT_FAMILY}" font-size="26" font-weight="900">${escapeXml(shift)}</text>
  <text x="354" y="${bottomLabelY}" text-anchor="middle" fill="#64748B" font-family="${FONT_FAMILY}" font-size="10" font-weight="700">PERCEPTION SHIFT</text>`
      : ''
  }

  <rect x="${shift ? 612 : CONTENT_X}" y="${bottomTop}" width="${shift ? 468 : CONTENT_WIDTH}" height="${bottomHeight}" rx="14" fill="#FBEDEA"/>
  <text x="${shift ? 846 : 600}" y="${bottomValueY}" text-anchor="middle" fill="#C94F3D" font-family="${FONT_FAMILY}" font-size="26" font-weight="900">~${escapeXml(reconsidered)}</text>
  <text x="${shift ? 846 : 600}" y="${bottomLabelY}" text-anchor="middle" fill="#64748B" font-family="${FONT_FAMILY}" font-size="10" font-weight="700">RECONSIDERED</text>

  <text x="${CONTENT_X}" y="${footerY}" fill="#94A3B8" font-family="${FONT_FAMILY}" font-size="18" font-weight="500">The Unravel Network</text>
  <circle cx="1080" cy="${footerIconY}" r="14" fill="#1A6BBF"/>
  <path d="M1073 ${footerIconY} L1078 ${footerIconY + 5} L1088 ${footerIconY - 7}" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

export function renderImpactOgPng(payload: ImpactShareCardPayload): Buffer {
  const svg = buildImpactOgSvg(payload);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: IMPACT_OG_WIDTH },
    font: {
      fontFiles: getRobotoFontFiles(),
      loadSystemFonts: true,
      defaultFontFamily: FONT_FAMILY,
    },
  });
  return Buffer.from(resvg.render().asPng());
}
