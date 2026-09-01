import path from 'path';
import { createRequire } from 'module';
import { Resvg } from '@resvg/resvg-js';

/**
 * UE-175 — social share card for the UUTS Trust Score Report.
 * SVG → PNG (same @resvg pipeline as impactOgImage.ts): overall score + band,
 * the three component scores with weight chips and bars, campaign title, and a
 * one-line assessment summary. Unscored components render greyed "Not yet scored"
 * rows so partially-reviewed campaigns still produce an honest card.
 */

const nodeRequire = createRequire(__filename);
const FONT_FAMILY = 'Roboto, DejaVu Sans, sans-serif';

export const TRUST_OG_WIDTH = 1200;
export const TRUST_OG_HEIGHT = 630;

const CARD_X = 72;
const CARD_Y = 48;
const CARD_WIDTH = 1056;
const CARD_HEIGHT = 534;
const CONTENT_X = 120;
const CONTENT_WIDTH = 960;

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

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function truncateToWidth(text: string, maxWidth: number, fontSize: number, weight: RobotoWeight): string {
  let t = String(text || '').trim();
  if (measureText(t, fontSize, weight) <= maxWidth) return t;
  while (t.length > 1 && measureText(`${t}…`, fontSize, weight) > maxWidth) {
    t = t.slice(0, -1);
  }
  return `${t.trimEnd()}…`;
}

export interface TrustReportOgLayer {
  label: string;
  weightPct: number;
  /** 0–100 layer score, or null when the layer is not scored yet. */
  score: number | null;
}

export interface TrustReportOgPayload {
  campaignTitle: string;
  category: string | null;
  composite: number | null;
  band: string | null;
  layers: TrustReportOgLayer[];
  /** Short assessment line under the title (already plain text). */
  summary: string | null;
}

function bandColor(band: string | null, composite: number | null): string {
  const label = (band || '').toLowerCase();
  if (label.includes('gold')) return '#E8A020';
  if (label.includes('high')) return '#16A34A';
  if (label.includes('moderate')) return '#D97706';
  if (composite == null) return '#64748B';
  return '#DC2626';
}

/** One component row: name + weight chip, score bar, score number (or "Not yet scored"). */
function layerRow(layer: TrustReportOgLayer, y: number): string {
  const scored = layer.score != null && Number.isFinite(layer.score);
  const barX = CONTENT_X;
  const barY = y + 34;
  const barWidth = 560;
  const barHeight = 14;
  const fillWidth = scored ? Math.max(8, Math.round((Math.min(100, Math.max(0, layer.score as number)) / 100) * barWidth)) : 0;
  const nameColor = scored ? '#0D2B3E' : '#94A3B8';
  const name = escapeXml(layer.label);
  const weightChipX = barX + measureText(layer.label, 21, 700) + 14;

  const scoreText = scored ? String(Math.round(layer.score as number)) : 'Not yet scored';
  const scoreSize = scored ? 34 : 18;
  const scoreColor = scored ? '#0D2B3E' : '#94A3B8';
  const scoreX = barX + barWidth + 36;
  const scoreY = scored ? barY + barHeight / 2 + 12 : barY + barHeight / 2 + 6;

  return `
  <text x="${barX}" y="${y + 16}" fill="${nameColor}" font-family="${FONT_FAMILY}" font-size="21" font-weight="700">${name}</text>
  <rect x="${weightChipX}" y="${y}" width="${measureText(`${layer.weightPct}% of score`, 13, 700) + 18}" height="22" rx="11" fill="#1A6BBF" fill-opacity="0.1"/>
  <text x="${weightChipX + 9}" y="${y + 15.5}" fill="#1A6BBF" font-family="${FONT_FAMILY}" font-size="13" font-weight="700">${layer.weightPct}% of score</text>
  <rect x="${barX}" y="${barY}" width="${barWidth}" height="${barHeight}" rx="7" fill="#E2E8F0"/>
  ${scored ? `<rect x="${barX}" y="${barY}" width="${fillWidth}" height="${barHeight}" rx="7" fill="#1A6BBF"/>` : ''}
  <text x="${scoreX}" y="${scoreY}" fill="${scoreColor}" font-family="${FONT_FAMILY}" font-size="${scoreSize}" font-weight="900">${escapeXml(scoreText)}</text>
  ${scored ? `<text x="${scoreX + measureText(scoreText, 34, 900) + 6}" y="${scoreY}" fill="#94A3B8" font-family="${FONT_FAMILY}" font-size="17" font-weight="700">/100</text>` : ''}`;
}

export function buildTrustReportOgSvg(payload: TrustReportOgPayload): string {
  const scored = payload.composite != null && Number.isFinite(payload.composite);
  const compositeText = scored ? String(Math.round(payload.composite as number)) : '—';
  const band = payload.band || (scored ? null : 'Review in progress');
  const accent = bandColor(payload.band, payload.composite);

  // Fit the title on one line: shrink before truncating so most titles show whole.
  const rawTitle = payload.campaignTitle || 'Campaign';
  const titleSize = measureText(rawTitle, 34, 900) <= 720 ? 34 : measureText(rawTitle, 28, 900) <= 720 ? 28 : 24;
  const title = truncateToWidth(rawTitle, 720, titleSize, 900);
  const summary = payload.summary
    ? truncateToWidth(payload.summary, CONTENT_WIDTH, 19, 500)
    : null;

  // Right-side composite block
  const compositeCx = CONTENT_X + 830;
  const compositeTop = 118;

  const rowsTop = 296;
  const rowGap = 78;
  const rows = payload.layers.map((l, i) => layerRow(l, rowsTop + i * rowGap)).join('\n');

  const bandChipWidth = band ? measureText(band, 17, 700) + 36 : 0;
  const footerY = CARD_Y + CARD_HEIGHT - 26;
  const footerIconY = CARD_Y + CARD_HEIGHT - 28;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${TRUST_OG_WIDTH}" height="${TRUST_OG_HEIGHT}" viewBox="0 0 ${TRUST_OG_WIDTH} ${TRUST_OG_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="#E8F1FB"/>
      <stop offset="52%" stop-color="#FFFFFF"/>
      <stop offset="100%" stop-color="#EAF4EE"/>
    </linearGradient>
    <linearGradient id="cardBorder" x1="0%" y1="0%" x2="100%" y2="0%">
      <stop offset="0%" stop-color="#1A6BBF" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#16A34A" stop-opacity="0.22"/>
    </linearGradient>
    <filter id="shadow" x="-8%" y="-8%" width="116%" height="116%">
      <feDropShadow dx="0" dy="10" stdDeviation="16" flood-color="#1A6BBF" flood-opacity="0.12"/>
    </filter>
  </defs>

  <rect width="${TRUST_OG_WIDTH}" height="${TRUST_OG_HEIGHT}" fill="url(#bg)"/>

  <g filter="url(#shadow)">
    <rect x="${CARD_X}" y="${CARD_Y}" width="${CARD_WIDTH}" height="${CARD_HEIGHT}" rx="28" fill="#FFFFFF" stroke="url(#cardBorder)" stroke-width="3"/>
  </g>

  <g transform="translate(${CONTENT_X}, 84)">
    <circle cx="10" cy="10" r="10" fill="#1A6BBF"/>
    <path d="M4.5 10 L8.5 14 L15.5 5.5" fill="none" stroke="#FFFFFF" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="32" y="16" fill="#1A6BBF" font-family="${FONT_FAMILY}" font-size="18" font-weight="700">UNRAVEL TRUST SCORE REPORT</text>
  </g>

  <text x="${CONTENT_X}" y="${compositeTop + 34}" fill="#0F172A" font-family="${FONT_FAMILY}" font-size="${titleSize}" font-weight="900">${escapeXml(title)}</text>
  ${payload.category ? `<text x="${CONTENT_X}" y="${compositeTop + 66}" fill="#64748B" font-family="${FONT_FAMILY}" font-size="17" font-weight="700">${escapeXml(payload.category.toUpperCase())}</text>` : ''}
  ${summary ? `<text x="${CONTENT_X}" y="${compositeTop + 106}" fill="#64748B" font-family="${FONT_FAMILY}" font-size="19" font-weight="500">${escapeXml(summary)}</text>` : ''}

  <!-- composite block (right) -->
  <text x="${compositeCx}" y="${compositeTop + 74}" text-anchor="middle" fill="${accent}" font-family="${FONT_FAMILY}" font-size="96" font-weight="900">${escapeXml(compositeText)}</text>
  <text x="${compositeCx}" y="${compositeTop + 100}" text-anchor="middle" fill="#94A3B8" font-family="${FONT_FAMILY}" font-size="16" font-weight="700">OVERALL / 100</text>
  ${
    band
      ? `<rect x="${compositeCx - bandChipWidth / 2}" y="${compositeTop + 116}" width="${bandChipWidth}" height="30" rx="15" fill="${accent}" fill-opacity="0.14"/>
  <text x="${compositeCx}" y="${compositeTop + 137}" text-anchor="middle" fill="${accent}" font-family="${FONT_FAMILY}" font-size="17" font-weight="700">${escapeXml(band)}</text>`
      : ''
  }

  <line x1="${CONTENT_X}" y1="${rowsTop - 26}" x2="${CONTENT_X + CONTENT_WIDTH}" y2="${rowsTop - 26}" stroke="#1A6BBF" stroke-opacity="0.12" stroke-width="2"/>

  ${rows}

  <text x="${CONTENT_X}" y="${footerY}" fill="#94A3B8" font-family="${FONT_FAMILY}" font-size="18" font-weight="500">The Unravel Network — independent 3-layer campaign review</text>
  <circle cx="1080" cy="${footerIconY}" r="14" fill="#1A6BBF"/>
  <path d="M1073 ${footerIconY} L1078 ${footerIconY + 5} L1088 ${footerIconY - 7}" fill="none" stroke="#FFFFFF" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

export function renderTrustReportOgPng(payload: TrustReportOgPayload): Buffer {
  const svg = buildTrustReportOgSvg(payload);
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: TRUST_OG_WIDTH },
    font: {
      fontFiles: getRobotoFontFiles(),
      loadSystemFonts: true,
      defaultFontFamily: FONT_FAMILY,
    },
  });
  return Buffer.from(resvg.render().asPng());
}
