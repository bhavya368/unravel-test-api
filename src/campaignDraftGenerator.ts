// Kept in sync with unravel-ui's src/constants/campaignCategories.js (CAMPAIGN_CATEGORY_OPTIONS keys).
// Duplicated here rather than shared across repos, same as other category-slug handling in this backend.
const CAMPAIGN_CATEGORY_SLUGS = [
  'art',
  'civic',
  'community',
  'consumer',
  'economicPolicy',
  'education',
  'environment',
  'foodBeverage',
  'geopolitical',
  'health',
  'journalism',
  'localBusiness',
  'music',
  'news',
  'nonprofit',
  'politics',
  'publicPolicy',
  'safety',
  'science',
  'sports',
  'technology',
  'other',
] as const;

const DEFAULT_CATEGORY_SLUG = 'other';
const SLIDE_COUNT = 3;
const DEFAULT_GROQ_MODEL = 'openai/gpt-oss-120b';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';

export type CampaignDraft = {
  title: string;
  category: string;
  tagline: string;
  descriptionHtml: string;
  sources: string[];
  whyBackersShouldCareHtml: string;
  targetAudience: string;
  adHeadline: string;
  adPrimaryText: string;
  adImagePrompt: string;
  slides: { description: string }[];
  /** Hero-slideshow contribution prompts (support heading + action button label). The action
   *  button URL stays unset on purpose — blank means the in-app contribute page. */
  slideshowSupportTitle: string;
  slideshowBackButtonText: string;
};

function defaultCampaignDraftModel(): string {
  return (process.env.GROQ_MODEL_CAMPAIGN_DRAFT || DEFAULT_GROQ_MODEL).trim() || DEFAULT_GROQ_MODEL;
}

// Strips markdown code fences and pulls out the first {...} block, same approach as
// the extractJson helper in uutsPrescreen.ts (kept local here to avoid cross-module coupling).
function extractJson(textValue: string): Record<string, unknown> {
  const trimmed = textValue.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1] ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start < 0 || end <= start) {
    throw new Error('Campaign draft response did not contain a JSON object');
  }
  return JSON.parse(candidate.slice(start, end + 1)) as Record<string, unknown>;
}

function str(value: unknown, maxLength?: number): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (maxLength && s.length > maxLength) return s.slice(0, maxLength).trim();
  return s;
}

function normalizeCategory(value: unknown): string {
  const slug = typeof value === 'string' ? value.trim() : '';
  return (CAMPAIGN_CATEGORY_SLUGS as readonly string[]).includes(slug) ? slug : DEFAULT_CATEGORY_SLUG;
}

function normalizeSources(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => (typeof v === 'string' ? v.trim() : ''))
    .filter((v) => v.length > 0)
    .slice(0, 20);
}

function normalizeSlides(value: unknown): { description: string }[] {
  const raw = Array.isArray(value) ? value : [];
  const descriptions = raw
    .map((entry) => {
      if (typeof entry === 'string') return str(entry, 140);
      if (entry && typeof entry === 'object') return str((entry as { description?: unknown }).description, 140);
      return '';
    })
    .filter((d) => d.length > 0);
  const padded = [...descriptions];
  while (padded.length < SLIDE_COUNT) {
    padded.push(padded[padded.length - 1] || '');
  }
  return padded.slice(0, SLIDE_COUNT).map((description) => ({ description }));
}

function buildPrompt(description: string): string {
  return `You are a fundraising strategist helping a creator launch a crowdfunding campaign on Unravel, a platform for community-powered media and civic/social campaigns.

The creator gave this description of their campaign idea:
"""
${description}
"""

Based on this, generate complete, ready-to-use content for every section of the campaign builder. Write in a compelling, authentic voice — not generic marketing copy. Infer sensible specifics where the creator didn't spell them out, but stay grounded in what they actually described.

Respond with ONLY a single JSON object (no markdown fences, no commentary) matching exactly this shape:

{
  "title": "Campaign title, <=120 characters",
  "category": "One of: ${CAMPAIGN_CATEGORY_SLUGS.join(', ')}",
  "tagline": "Short one/two-sentence summary for the campaign card, <=150 characters",
  "descriptionHtml": "Full campaign description as simple HTML using only <p>, <strong>, <em>, <ul>, <li> tags. Several paragraphs, tells the story, the plan, and the impact.",
  "sources": ["Any URLs or citations that plausibly support claims made in the description — omit if none apply. Array of strings, can be empty."],
  "whyBackersShouldCareHtml": "1-2 short paragraphs of simple HTML (same allowed tags) explaining the impact of backing this campaign.",
  "targetAudience": "One line describing who this campaign is aimed at, e.g. 'People in the East Coast over the age of 25'",
  "adHeadline": "Short ad headline, <=60 characters",
  "adPrimaryText": "Catchy ad primary text, <=200 characters",
  "adImagePrompt": "A vivid, concrete visual description (for an AI image generator) of the ideal ad creative image.",
  "slides": [
    { "description": "Vivid visual description for hero slide 1's image, <=140 characters" },
    { "description": "Vivid visual description for hero slide 2's image, <=140 characters" },
    { "description": "Vivid visual description for hero slide 3's image, <=140 characters" }
  ],
  "slideshowSupportTitle": "Heading above the contribution prompt on the hero carousel, <=60 characters. Campaign-specific, e.g. 'Power a village for good' (default is 'Support this campaign')",
  "slideshowBackButtonText": "Label for the contribution button, <=30 characters, action-led, e.g. 'Fund the training' (default is 'Back This Campaign')"
}`;
}

export async function generateCampaignDraft(description: string): Promise<CampaignDraft> {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) {
    throw Object.assign(new Error('GROQ_API_KEY is required to generate a campaign draft'), { status: 500 });
  }
  const model = defaultCampaignDraftModel();

  const response = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      max_tokens: 4096,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: buildPrompt(description) }],
    }),
  });

  if (!response.ok) {
    const errBody = (await response.json().catch(() => ({}))) as { error?: { message?: string } };
    const detail = errBody?.error?.message || `Groq API error: ${response.status}`;
    throw Object.assign(new Error(detail), { status: response.status >= 500 ? 502 : 500 });
  }

  const result = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const responseText = String(result?.choices?.[0]?.message?.content || '').trim();

  if (!responseText) {
    throw new Error('Campaign draft generation returned an empty response');
  }

  const parsed = extractJson(responseText);

  const draft: CampaignDraft = {
    title: str(parsed.title, 120),
    category: normalizeCategory(parsed.category),
    tagline: str(parsed.tagline, 150),
    descriptionHtml: str(parsed.descriptionHtml),
    sources: normalizeSources(parsed.sources),
    whyBackersShouldCareHtml: str(parsed.whyBackersShouldCareHtml),
    targetAudience: str(parsed.targetAudience, 200),
    adHeadline: str(parsed.adHeadline, 60),
    adPrimaryText: str(parsed.adPrimaryText, 200),
    adImagePrompt: str(parsed.adImagePrompt, 2000),
    slides: normalizeSlides(parsed.slides),
    slideshowSupportTitle: str(parsed.slideshowSupportTitle, 60),
    slideshowBackButtonText: str(parsed.slideshowBackButtonText, 30),
  };

  if (!draft.title || !draft.descriptionHtml) {
    throw new Error('Campaign draft generation returned incomplete content');
  }

  return draft;
}
