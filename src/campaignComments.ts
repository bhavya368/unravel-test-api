import type { Firestore } from 'firebase-admin/firestore';
import { FieldValue } from 'firebase-admin/firestore';

/**
 * Campaign comments (UE-80) — v1: anyone with an Unravel account can comment.
 * v2 (not built yet): restrict to backers only.
 *
 * Firestore layout: campaigns/{campaignId}/comments/{commentId}
 * Soft-delete only (status: 'removed') so moderators can still see removed comments if needed later;
 * the public list query always filters status == 'visible'.
 */

export const MAX_COMMENT_LENGTH = 2000;

export type CommentStatus = 'visible' | 'removed';

export interface CampaignComment {
  id: string;
  campaignId: string;
  authorUid: string;
  authorName: string;
  authorAvatarUrl: string | null;
  text: string;
  status: CommentStatus;
  createdAt: string | null;
  editedAt: string | null;
}

function commentsCollection(db: Firestore, campaignId: string) {
  return db.collection('campaigns').doc(campaignId).collection('comments');
}

function toIso(value: unknown): string | null {
  // Firestore Timestamp has .toDate(); serverTimestamp() reads back null on the same
  // transaction snapshot, so callers should re-fetch after write if they need the real value.
  if (value && typeof (value as { toDate?: () => Date }).toDate === 'function') {
    return (value as { toDate: () => Date }).toDate().toISOString();
  }
  return null;
}

function serializeComment(id: string, data: Record<string, unknown>): CampaignComment {
  return {
    id,
    campaignId: String(data.campaignId || ''),
    authorUid: String(data.authorUid || ''),
    authorName: typeof data.authorName === 'string' && data.authorName.trim() ? data.authorName.trim() : 'Unravel member',
    authorAvatarUrl: typeof data.authorAvatarUrl === 'string' && data.authorAvatarUrl.trim() ? data.authorAvatarUrl.trim() : null,
    text: typeof data.text === 'string' ? data.text : '',
    status: data.status === 'removed' ? 'removed' : 'visible',
    createdAt: toIso(data.createdAt),
    editedAt: toIso(data.editedAt),
  };
}

/** Trim + length-cap + reject empty/whitespace-only. Plain text only — never rendered as HTML. */
export function sanitizeCommentText(raw: unknown): { text?: string; error?: string } {
  if (typeof raw !== 'string') return { error: 'Comment text is required' };
  const trimmed = raw.trim();
  if (!trimmed) return { error: 'Comment text is required' };
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    return { error: `Comments are limited to ${MAX_COMMENT_LENGTH} characters` };
  }
  return { text: trimmed };
}

export async function createComment(
  db: Firestore,
  params: {
    campaignId: string;
    authorUid: string;
    authorName: string;
    authorAvatarUrl: string | null;
    text: string;
  }
): Promise<{ ok: true; comment: CampaignComment } | { ok: false; status: number; error: string }> {
  const { campaignId, authorUid, authorName, authorAvatarUrl, text } = params;
  if (!campaignId || !authorUid) {
    return { ok: false, status: 400, error: 'campaignId and authorUid are required' };
  }
  const campaignSnap = await db.collection('campaigns').doc(campaignId).get();
  if (!campaignSnap.exists) {
    return { ok: false, status: 404, error: 'Campaign not found' };
  }

  const ref = commentsCollection(db, campaignId).doc();
  const docData = {
    campaignId,
    authorUid,
    authorName,
    authorAvatarUrl,
    text,
    status: 'visible' as CommentStatus,
    createdAt: FieldValue.serverTimestamp(),
    editedAt: null,
  };
  await ref.set(docData);
  const written = await ref.get();
  return { ok: true, comment: serializeComment(ref.id, written.data() || {}) };
}

/** Newest-first page of visible comments. `cursor` is the last-seen comment id from the prior page. */
export async function listComments(
  db: Firestore,
  campaignId: string,
  opts: { limit?: number; cursor?: string | null } = {}
): Promise<{ comments: CampaignComment[]; nextCursor: string | null; total: number }> {
  const limit = Math.max(1, Math.min(50, Number(opts.limit) || 15));
  let query = commentsCollection(db, campaignId)
    .where('status', '==', 'visible')
    .orderBy('createdAt', 'desc')
    .limit(limit + 1);

  if (opts.cursor) {
    const cursorSnap = await commentsCollection(db, campaignId).doc(opts.cursor).get();
    if (cursorSnap.exists) {
      query = query.startAfter(cursorSnap);
    }
  }

  const [snap, countSnap] = await Promise.all([
    query.get(),
    commentsCollection(db, campaignId).where('status', '==', 'visible').count().get(),
  ]);

  const docs = snap.docs.slice(0, limit);
  const comments = docs.map((d) => serializeComment(d.id, d.data()));
  const nextCursor = snap.docs.length > limit ? docs[docs.length - 1]?.id ?? null : null;

  return { comments, nextCursor, total: countSnap.data().count };
}

export interface CheckoutTestimonial {
  commentId: string;
  authorName: string;
  amountCents: number;
  text: string;
  createdAt: string | null;
}

/**
 * Checkout-page "What people are saying" testimonials — comments from people who actually
 * backed this campaign AND opted in to show their name (`show_name` on their checkout record,
 * the same UE-186 consent flag the backer-count/activity widget already respects). A comment
 * only becomes a testimonial when both are true; amount shown is their total backed on this
 * campaign. Capped + newest-first; no separate "leave a testimonial" field — this reuses the
 * public Comments section (UE-80) as the source, per product decision (Aug 2026).
 */
export async function listCheckoutTestimonials(
  db: Firestore,
  campaignId: string,
  opts: { limit?: number } = {}
): Promise<CheckoutTestimonial[]> {
  const limit = Math.max(1, Math.min(20, Number(opts.limit) || 12));
  if (!campaignId) return [];

  const [commentsSnap, backingsSnap] = await Promise.all([
    commentsCollection(db, campaignId).where('status', '==', 'visible').orderBy('createdAt', 'desc').limit(200).get(),
    // Single equality filter (matches the /backers endpoint's pattern) — show_name is
    // filtered in application code below, not chained here, to avoid needing a composite index.
    db.collection('stripe_checkout_records').where('campaignId', '==', campaignId).get(),
  ]);

  const optedInAmountByUid = new Map<string, number>();
  for (const doc of backingsSnap.docs) {
    const data = doc.data() as Record<string, unknown>;
    if (data.show_name !== true) continue;
    const uid = String(data.donor_uid || '').trim();
    if (!uid) continue;
    const cents = Number(data.amount_cents);
    const prior = optedInAmountByUid.get(uid) || 0;
    optedInAmountByUid.set(uid, prior + (Number.isFinite(cents) ? cents : 0));
  }
  if (!optedInAmountByUid.size) return [];

  const out: CheckoutTestimonial[] = [];
  for (const doc of commentsSnap.docs) {
    if (out.length >= limit) break;
    const data = doc.data() as Record<string, unknown>;
    const authorUid = String(data.authorUid || '').trim();
    const amountCents = optedInAmountByUid.get(authorUid);
    if (amountCents == null) continue; // not a backer, or didn't opt in — never surfaced here
    const text = typeof data.text === 'string' ? data.text : '';
    if (!text.trim()) continue;
    out.push({
      commentId: doc.id,
      authorName: typeof data.authorName === 'string' && data.authorName.trim() ? data.authorName.trim() : 'A backer',
      amountCents,
      text,
      createdAt: toIso(data.createdAt),
    });
  }
  return out;
}

/** Soft-delete — only the comment's own author may remove it in v1 (no admin override yet). */
export async function removeComment(
  db: Firestore,
  params: { campaignId: string; commentId: string; requesterUid: string }
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  const { campaignId, commentId, requesterUid } = params;
  const ref = commentsCollection(db, campaignId).doc(commentId);
  const snap = await ref.get();
  if (!snap.exists) {
    return { ok: false, status: 404, error: 'Comment not found' };
  }
  const data = snap.data() || {};
  if (String(data.authorUid || '') !== requesterUid) {
    return { ok: false, status: 403, error: 'You can only remove your own comments' };
  }
  await ref.update({ status: 'removed', editedAt: FieldValue.serverTimestamp() });
  return { ok: true };
}
