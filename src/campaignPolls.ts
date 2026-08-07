import type { Firestore, Transaction } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

export const POLL_RESPONSES_COLLECTION = 'campaign_poll_responses';

export const POLL_QUESTIONS = {
  thumbs: { answers: ['up', 'down'] as const },
  mind_change: { answers: ['yes', 'somewhat', 'no'] as const },
  funding_worth: { answers: ['yes', 'maybe', 'no'] as const },
  review_credibility: { answers: ['yes', 'somewhat', 'no'] as const },
  fact_check_useful: { answers: ['yes', 'no'] as const },
} as const;

export type PollQuestionId = keyof typeof POLL_QUESTIONS;
export type PollAnswer = string;

export const DEFAULT_POLL_CONFIG = {
  activeSessionSeconds: 30,
  scrollPastStory: true,
  fundingWorthPopupRate: 0.3,
};

export type PollConfig = typeof DEFAULT_POLL_CONFIG;

export type PollRespondent =
  | { type: 'user'; firebaseUid: string }
  | { type: 'anon'; fingerprint: string };

export type QuestionAggregate = {
  counts: Record<string, number>;
  total: number;
  updatedAt: string;
};

export type CampaignPollAggregates = Record<string, QuestionAggregate>;

function sanitizeIdPart(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/[/\\#?[\]]/g, '_')
    .slice(0, 128);
}

export function isPollQuestionId(value: unknown): value is PollQuestionId {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(POLL_QUESTIONS, value);
}

export function isValidAnswer(questionId: PollQuestionId, answer: unknown): boolean {
  if (typeof answer !== 'string') return false;
  const allowed = POLL_QUESTIONS[questionId].answers as readonly string[];
  return allowed.includes(answer);
}

export function resolveRespondent(
  firebaseUid: string | undefined,
  fingerprint: unknown
): { respondent?: PollRespondent; error?: string } {
  const uid = typeof firebaseUid === 'string' ? firebaseUid.trim() : '';
  if (uid) return { respondent: { type: 'user', firebaseUid: uid } };

  const fp = typeof fingerprint === 'string' ? fingerprint.trim() : '';
  if (!fp) {
    return { error: 'fingerprint is required for guest respondents' };
  }
  if (fp.length > 200) {
    return { error: 'fingerprint is too long' };
  }
  return { respondent: { type: 'anon', fingerprint: fp } };
}

export function respondentKey(respondent: PollRespondent): string {
  if (respondent.type === 'user') {
    return `uid:${sanitizeIdPart(respondent.firebaseUid)}`;
  }
  return `fp:${sanitizeIdPart(respondent.fingerprint)}`;
}

export function responseDocId(
  campaignId: string,
  questionId: PollQuestionId,
  respondent: PollRespondent
): string {
  return `${sanitizeIdPart(campaignId)}_${questionId}_${respondentKey(respondent)}`;
}

export function emptyQuestionAggregate(answers: readonly string[]): QuestionAggregate {
  const counts: Record<string, number> = {};
  for (const a of answers) counts[a] = 0;
  return { counts, total: 0, updatedAt: new Date().toISOString() };
}

export function normalizeQuestionAggregate(
  questionId: PollQuestionId,
  raw: unknown
): QuestionAggregate {
  const answers = POLL_QUESTIONS[questionId].answers as readonly string[];
  const base = emptyQuestionAggregate(answers);
  if (!raw || typeof raw !== 'object') return base;
  const obj = raw as Record<string, unknown>;
  const countsIn =
    obj.counts && typeof obj.counts === 'object' ? (obj.counts as Record<string, unknown>) : {};
  for (const a of answers) {
    const n = Number(countsIn[a] ?? 0);
    base.counts[a] = Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }
  const totalFromCounts = answers.reduce((s, a) => s + (base.counts[a] || 0), 0);
  const totalRaw = Number(obj.total);
  base.total =
    Number.isFinite(totalRaw) && totalRaw >= 0 ? Math.floor(totalRaw) : totalFromCounts;
  if (base.total !== totalFromCounts) base.total = totalFromCounts;
  if (typeof obj.updatedAt === 'string') base.updatedAt = obj.updatedAt;
  return base;
}

/** % yes + somewhat for mind_change → perception_shift_actual (0–100, 1 decimal). */
export function computePerceptionShiftActual(agg: QuestionAggregate): number | null {
  if (!agg.total || agg.total <= 0) return null;
  const yes = Number(agg.counts.yes || 0);
  const somewhat = Number(agg.counts.somewhat || 0);
  const pct = ((yes + somewhat) / agg.total) * 100;
  return Math.round(pct * 10) / 10;
}

function applyAnswerDelta(
  agg: QuestionAggregate,
  answer: string,
  delta: number
): QuestionAggregate {
  const next: QuestionAggregate = {
    counts: { ...agg.counts },
    total: agg.total,
    updatedAt: new Date().toISOString(),
  };
  next.counts[answer] = Math.max(0, (next.counts[answer] || 0) + delta);
  next.total = Math.max(0, next.total + delta);
  return next;
}

function buildCampaignMetricPatch(
  questionId: PollQuestionId,
  aggregates: CampaignPollAggregates
): Record<string, unknown> {
  const patch: Record<string, unknown> = {
    poll_aggregates: aggregates,
  };

  if (questionId === 'thumbs' || aggregates.thumbs) {
    const thumbs = aggregates.thumbs || emptyQuestionAggregate(POLL_QUESTIONS.thumbs.answers);
    const up = Number(thumbs.counts.up || 0);
    const down = Number(thumbs.counts.down || 0);
    patch.thumbs_up = up;
    patch.thumbs_down = down;
    patch.net_rating = up - down;
  }

  if (questionId === 'mind_change' || aggregates.mind_change) {
    const mind = aggregates.mind_change || emptyQuestionAggregate(POLL_QUESTIONS.mind_change.answers);
    const shift = computePerceptionShiftActual(mind);
    if (shift != null) {
      patch.perception_shift_actual = shift;
    }
  }

  return patch;
}

export function parsePollConfig(raw: Record<string, unknown> | null | undefined): PollConfig {
  const cfg = { ...DEFAULT_POLL_CONFIG };
  if (!raw) return cfg;

  const seconds = Number(raw.activeSessionSeconds ?? raw.active_session_seconds);
  if (Number.isFinite(seconds) && seconds >= 0) {
    cfg.activeSessionSeconds = Math.floor(seconds);
  }

  if (typeof raw.scrollPastStory === 'boolean') {
    cfg.scrollPastStory = raw.scrollPastStory;
  } else if (typeof raw.scroll_past_story === 'boolean') {
    cfg.scrollPastStory = raw.scroll_past_story;
  }

  const rate = Number(raw.fundingWorthPopupRate ?? raw.funding_worth_popup_rate);
  if (Number.isFinite(rate) && rate >= 0 && rate <= 1) {
    cfg.fundingWorthPopupRate = rate;
  }

  return cfg;
}

export async function loadPollConfig(db: Firestore): Promise<PollConfig> {
  try {
    const doc = await db.collection('settings').doc('polls').get();
    if (!doc.exists) return { ...DEFAULT_POLL_CONFIG };
    return parsePollConfig(doc.data() as Record<string, unknown>);
  } catch {
    return { ...DEFAULT_POLL_CONFIG };
  }
}

export type UpsertPollResult =
  | { ok: true; answer: string; changed: boolean; aggregates: CampaignPollAggregates }
  | { ok: false; status: number; error: string };

export async function upsertPollAnswer(
  db: Firestore,
  params: {
    campaignId: string;
    questionId: PollQuestionId;
    answer: string;
    respondent: PollRespondent;
    placement?: string;
  }
): Promise<UpsertPollResult> {
  const { campaignId, questionId, answer, respondent, placement } = params;
  if (!isValidAnswer(questionId, answer)) {
    return { ok: false, status: 400, error: `Invalid answer for ${questionId}` };
  }

  const docId = responseDocId(campaignId, questionId, respondent);
  const responseRef = db.collection(POLL_RESPONSES_COLLECTION).doc(docId);
  const campaignRef = db.collection('campaigns').doc(campaignId);

  return db.runTransaction(async (tx: Transaction) => {
    const [responseSnap, campaignSnap] = await Promise.all([
      tx.get(responseRef),
      tx.get(campaignRef),
    ]);

    if (!campaignSnap.exists) {
      return { ok: false, status: 404, error: 'Campaign not found' };
    }

    const campaignData = (campaignSnap.data() || {}) as Record<string, unknown>;
    if (respondent.type !== 'user') {
      return { ok: false, status: 401, error: 'Sign in required to submit feedback' };
    }

    const existing = responseSnap.exists ? (responseSnap.data() as Record<string, unknown>) : null;
    const priorAnswer =
      existing && typeof existing.answer === 'string' && !existing.dismissed
        ? existing.answer
        : null;
    const wasDismissedOnly = Boolean(existing?.dismissed) && !priorAnswer;

    if (!isCampaignFeedbackOpen(campaignData)) {
      return {
        ok: false,
        status: 403,
        error: 'Feedback is closed for this campaign',
      };
    }

    if (priorAnswer === answer) {
      const aggregatesRaw =
        (campaignData.poll_aggregates as CampaignPollAggregates | undefined) || {};
      const aggregates: CampaignPollAggregates = { ...aggregatesRaw };
      aggregates[questionId] = normalizeQuestionAggregate(questionId, aggregates[questionId]);
      return { ok: true, answer, changed: false, aggregates };
    }

    const aggregatesRaw =
      (campaignData.poll_aggregates as CampaignPollAggregates | undefined) || {};
    const aggregates: CampaignPollAggregates = { ...aggregatesRaw };
    let agg = normalizeQuestionAggregate(questionId, aggregates[questionId]);

    if (priorAnswer) {
      agg = applyAnswerDelta(agg, priorAnswer, -1);
    }
    agg = applyAnswerDelta(agg, answer, 1);
    aggregates[questionId] = agg;

    const now = new Date().toISOString();
    const responseDoc: Record<string, unknown> = {
      campaignId,
      questionId,
      answer,
      respondentType: respondent.type,
      dismissed: false,
      updatedAt: now,
      ...(placement ? { placement: String(placement).slice(0, 64) } : {}),
      firebase_uid: respondent.firebaseUid,
    };
    if (!responseSnap.exists || wasDismissedOnly) {
      responseDoc.createdAt = existing?.createdAt || now;
    }

    tx.set(responseRef, responseDoc, { merge: true });
    tx.set(campaignRef, buildCampaignMetricPatch(questionId, aggregates), { merge: true });

    return { ok: true, answer, changed: true, aggregates };
  });
}

export type DismissPollResult =
  | { ok: true; alreadyAnswered: boolean }
  | { ok: false; status: number; error: string };

export async function dismissPoll(
  db: Firestore,
  params: {
    campaignId: string;
    questionId: PollQuestionId;
    respondent: PollRespondent;
    placement?: string;
  }
): Promise<DismissPollResult> {
  const { campaignId, questionId, respondent, placement } = params;
  const docId = responseDocId(campaignId, questionId, respondent);
  const responseRef = db.collection(POLL_RESPONSES_COLLECTION).doc(docId);
  const campaignRef = db.collection('campaigns').doc(campaignId);

  return db.runTransaction(async (tx: Transaction) => {
    const [responseSnap, campaignSnap] = await Promise.all([
      tx.get(responseRef),
      tx.get(campaignRef),
    ]);

    if (!campaignSnap.exists) {
      return { ok: false, status: 404, error: 'Campaign not found' };
    }

    if (responseSnap.exists) {
      const data = responseSnap.data() as Record<string, unknown>;
      if (typeof data.answer === 'string' && data.answer && !data.dismissed) {
        return { ok: true, alreadyAnswered: true };
      }
      if (data.dismissed) {
        return { ok: true, alreadyAnswered: false };
      }
    }

    const now = new Date().toISOString();
    tx.set(
      responseRef,
      {
        campaignId,
        questionId,
        dismissed: true,
        respondentType: respondent.type,
        updatedAt: now,
        createdAt: responseSnap.exists
          ? (responseSnap.data() as Record<string, unknown>).createdAt || now
          : now,
        ...(placement ? { placement: String(placement).slice(0, 64) } : {}),
        ...(respondent.type === 'user'
          ? { firebase_uid: respondent.firebaseUid }
          : { fingerprint: respondent.fingerprint }),
      },
      { merge: true }
    );

    return { ok: true, alreadyAnswered: false };
  });
}

export async function getMyPollResponses(
  db: Firestore,
  campaignId: string,
  respondent: PollRespondent
): Promise<Record<string, { answer?: string; dismissed?: boolean }>> {
  const out: Record<string, { answer?: string; dismissed?: boolean }> = {};
  const questionIds = Object.keys(POLL_QUESTIONS) as PollQuestionId[];

  await Promise.all(
    questionIds.map(async (questionId) => {
      const docId = responseDocId(campaignId, questionId, respondent);
      const snap = await db.collection(POLL_RESPONSES_COLLECTION).doc(docId).get();
      if (!snap.exists) return;
      const data = snap.data() as Record<string, unknown>;
      out[questionId] = {
        ...(typeof data.answer === 'string' ? { answer: data.answer } : {}),
        ...(data.dismissed ? { dismissed: true } : {}),
      };
    })
  );

  return out;
}

export function summarizePollAggregates(
  raw: unknown
): Record<string, QuestionAggregate> {
  const summary: Record<string, QuestionAggregate> = {};
  const src = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  for (const questionId of Object.keys(POLL_QUESTIONS) as PollQuestionId[]) {
    summary[questionId] = normalizeQuestionAggregate(questionId, src[questionId]);
  }
  return summary;
}

/** Env overrides for poll config (optional). */
export function pollConfigFromEnv(): Partial<PollConfig> {
  const out: Partial<PollConfig> = {};
  const seconds = Number(process.env.POLL_ACTIVE_SESSION_SECONDS);
  if (Number.isFinite(seconds) && seconds >= 0) out.activeSessionSeconds = Math.floor(seconds);
  if (process.env.POLL_SCROLL_PAST_STORY === 'false') out.scrollPastStory = false;
  if (process.env.POLL_SCROLL_PAST_STORY === 'true') out.scrollPastStory = true;
  const rate = Number(process.env.POLL_FUNDING_WORTH_POPUP_RATE);
  if (Number.isFinite(rate) && rate >= 0 && rate <= 1) out.fundingWorthPopupRate = rate;
  return out;
}

export function mergePollConfig(
  firestoreCfg: PollConfig,
  envPartial: Partial<PollConfig> = pollConfigFromEnv()
): PollConfig {
  return { ...firestoreCfg, ...envPartial };
}

/** Feedback allowed during fund collection + ad deployment; blocked when closed. */
export function isCampaignFeedbackOpen(campaign: Record<string, unknown> | null | undefined): boolean {
  if (!campaign) return false;
  const status = String(campaign.status || '')
    .trim()
    .toLowerCase();
  if (status === 'closed') return false;
  if (status === 'rejected' || status === 'disapproved') return false;
  if (campaign.ads_closed === true) return false;
  const adsStatus = String(campaign.ads_status || campaign.ad_status || '')
    .trim()
    .toLowerCase();
  if (adsStatus === 'closed' || adsStatus === 'ended') return false;
  return true;
}
