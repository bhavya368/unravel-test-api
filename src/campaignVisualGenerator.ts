/**
 * Generate a campaign visual (cover, hero slide, or ad creative) and the copy that sits beside it.
 *
 * Two calls per request: FLUX for the picture, Groq for the caption or ad copy. They are written
 * together on purpose — a caption invented before the image exists describes a picture nobody has
 * seen, which was the failure mode of writing the two separately.
 *
 * The provider is behind env vars so a key can be swapped without touching this file:
 *   BFL_API_KEY      required
 *   BFL_IMAGE_MODEL  defaults to flux-2-pro
 *   BFL_API_BASE     defaults to https://api.bfl.ai
 */

const DEFAULT_MODEL = 'flux-2-pro';
const DEFAULT_BASE = 'https://api.bfl.ai';
const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const DEFAULT_GROQ_MODEL = 'llama-3.3-70b-versatile';

/** Every image is generated at the size the slot actually displays at, because BFL bills per
 *  megapixel rounded up. The cover is square only because the wizard cuts both a 4:3 page crop
 *  and a 4:5 ad crop out of it; the other two are generated at their final shape and stay
 *  under 1 MP, which is the cheapest band. */
export const VISUAL_SPECS = {
  cover: { width: 1400, height: 1400, label: 'campaign cover' },
  slide: { width: 1024, height: 768, label: 'hero slideshow slide' },
  ad: { width: 864, height: 1080, label: 'social ad creative' },
} as const;

export type VisualKind = keyof typeof VISUAL_SPECS;

export type VisualContext = {
  title?: string;
  category?: string;
  shortDescription?: string;
  longDescription?: string;
  targetAudience?: string;
  /** For a slide: what the earlier slides already show, so this one does not repeat them. */
  existingSlideCaptions?: string[];
  /** For the ad: the copy the creator already wrote, which the picture has to suit. */
  adHeadline?: string;
  adPrimaryText?: string;
};

export type GeneratedVisual = {
  imageBase64: string;
  /** Slide caption. Empty for the cover and the ad. */
  caption?: string;
  /** Ad copy. Empty unless kind === 'ad'. */
  adHeadline?: string;
  adPrimaryText?: string;
  /** The prompt the image was made from — shown to the creator so the result is not a black box. */
  prompt: string;
};

function contextBlock(ctx: VisualContext): string {
  return [
    `Campaign title: ${ctx.title || 'N/A'}`,
    `Category: ${ctx.category || 'N/A'}`,
    `Summary: ${ctx.shortDescription || 'N/A'}`,
    ctx.longDescription ? `Story: ${String(ctx.longDescription).replace(/<[^>]*>/g, ' ').slice(0, 1200)}` : '',
    ctx.targetAudience ? `Audience: ${ctx.targetAudience}` : '',
    ctx.adHeadline ? `Ad headline: ${ctx.adHeadline}` : '',
    ctx.adPrimaryText ? `Ad text: ${ctx.adPrimaryText}` : '',
  ].filter(Boolean).join('\n');
}

/** Ask Groq for the image prompt plus whatever copy belongs next to that image. */
async function planVisual(kind: VisualKind, ctx: VisualContext): Promise<{
  prompt: string; caption?: string; adHeadline?: string; adPrimaryText?: string;
}> {
  const apiKey = (process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) throw Object.assign(new Error('GROQ_API_KEY is required'), { status: 500 });

  const shape = kind === 'ad'
    // No copy asked for: the ad headline and text are already written by this point, and the
    // image is being drawn to suit them.
    ? '"caption": ""'
    : kind === 'slide'
      ? '"caption": "one short sentence, <=120 chars"'
      : '"caption": ""';

  const avoid = (ctx.existingSlideCaptions || []).filter(Boolean);

  const instruction = [
    `You are preparing a ${VISUAL_SPECS[kind].label} for a fundraising campaign.`,
    '',
    contextBlock(ctx),
    avoid.length ? `\nSlides already in this carousel (do not repeat these):\n- ${avoid.join('\n- ')}` : '',
    '',
    kind === 'ad'
      ? 'The ad copy above is fixed. Write an image prompt for a photograph that suits it.'
      : '',
    'Write an image prompt for a photorealistic, documentary-style photograph that could plausibly',
    'illustrate this campaign. Real people, natural light, candid framing. No text, no logos, no',
    'watermarks, no collage. Do not depict identifiable real individuals, and do not stage anything',
    'that would read as documentary evidence of a specific claimed event.',
    '',
    `Reply with JSON only: { "prompt": "...", ${shape} }`,
  ].join('\n');

  const res = await fetch(GROQ_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: (process.env.GROQ_MODEL_CAMPAIGN_DRAFT || DEFAULT_GROQ_MODEL).trim(),
      max_tokens: 700,
      temperature: 0.7,
      response_format: { type: 'json_object' },
      messages: [{ role: 'user', content: instruction }],
    }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    throw Object.assign(new Error(body?.error?.message || `Groq error ${res.status}`), { status: 502 });
  }
  const json = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  const parsed = JSON.parse(String(json?.choices?.[0]?.message?.content || '{}'));
  if (!parsed.prompt) throw Object.assign(new Error('Could not plan the image'), { status: 502 });
  return {
    prompt: String(parsed.prompt).slice(0, 1500),
    caption: parsed.caption ? String(parsed.caption).slice(0, 120) : undefined,
    adHeadline: parsed.adHeadline ? String(parsed.adHeadline).slice(0, 40) : undefined,
    adPrimaryText: parsed.adPrimaryText ? String(parsed.adPrimaryText).slice(0, 125) : undefined,
  };
}

/** BFL is asynchronous: create a job, then poll the URL it hands back until the result appears. */
async function renderWithFlux(prompt: string, kind: VisualKind): Promise<string> {
  const apiKey = (process.env.BFL_API_KEY || '').trim();
  if (!apiKey) {
    throw Object.assign(new Error('Image generation is not configured on this server.'), { status: 503 });
  }
  const base = (process.env.BFL_API_BASE || DEFAULT_BASE).replace(/\/$/, '');
  const model = (process.env.BFL_IMAGE_MODEL || DEFAULT_MODEL).trim();
  const { width, height } = VISUAL_SPECS[kind];

  const create = await fetch(`${base}/v1/${model}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-key': apiKey },
    body: JSON.stringify({ prompt, width, height, output_format: 'jpeg', safety_tolerance: 2 }),
  });
  if (!create.ok) {
    const body = await create.text().catch(() => '');
    console.error('BFL create failed:', create.status, body.slice(0, 300));
    throw Object.assign(new Error('Could not start image generation.'), { status: 502 });
  }
  const job = (await create.json()) as { id?: string; polling_url?: string };
  const pollUrl = job.polling_url;
  if (!pollUrl) throw Object.assign(new Error('Image generation did not start.'), { status: 502 });

  // ~60s ceiling. Generation normally lands in 5-15s; anything past this is a stuck job, and the
  // creator is staring at a spinner meanwhile.
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await new Promise((r) => setTimeout(r, 1500));
    const poll = await fetch(pollUrl, { headers: { 'x-key': apiKey } });
    if (!poll.ok) continue;
    const status = (await poll.json()) as { status?: string; result?: { sample?: string } };
    if (status.status === 'Ready' && status.result?.sample) {
      const img = await fetch(status.result.sample);
      if (!img.ok) throw Object.assign(new Error('Could not download the generated image.'), { status: 502 });
      const buf = Buffer.from(await img.arrayBuffer());
      return `data:image/jpeg;base64,${buf.toString('base64')}`;
    }
    if (status.status && !['Pending', 'Ready', 'Queued', 'Processing'].includes(status.status)) {
      // Content moderation lands here, and it is the creator's prompt that caused it.
      console.error('BFL job ended as:', status.status);
      throw Object.assign(
        new Error('That description could not be turned into an image. Try rewording it.'),
        { status: 422 }
      );
    }
  }
  throw Object.assign(new Error('Image generation timed out. Please try again.'), { status: 504 });
}

export async function generateCampaignVisual(kind: VisualKind, ctx: VisualContext): Promise<GeneratedVisual> {
  const plan = await planVisual(kind, ctx);
  const imageBase64 = await renderWithFlux(plan.prompt, kind);
  return {
    imageBase64,
    prompt: plan.prompt,
    caption: plan.caption,
    adHeadline: plan.adHeadline,
    adPrimaryText: plan.adPrimaryText,
  };
}
