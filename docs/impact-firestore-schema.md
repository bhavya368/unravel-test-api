# Impact report — Firestore schema (Scope B)

Additive fields and collections only. Existing documents do not require migration.

## Databases

| Instance | ID | Collections |
|----------|-----|-------------|
| Named | `unravel` | `campaigns`, `share_cards`, … |
| Default | `(default)` | `users`, `users/{uid}/contributions` |

## `users/{uid}/contributions/{sessionId}`

Written on successful Stripe checkout when the donor was signed in (`donorUid`).

| Field | Type | Notes |
|-------|------|--------|
| `sessionId` | string | Stripe Checkout session id (document id) |
| `campaignId` | string | Campaign backed |
| `campaignTitle` | string | Snapshot at checkout |
| `amount_cents` | number | Donation amount |
| `currency` | string | e.g. `usd` |
| `recordedAt` | string | ISO timestamp |
| `invoice_pdf` | string? | Stripe receipt |
| `hosted_invoice_url` | string? | Stripe hosted invoice |

## `campaigns/{id}` — impact-related fields

### Already maintained by API

| Field | Type | Source |
|-------|------|--------|
| `funding_goal` | number | Campaign create / admin |
| `funding_current` | number | Checkout transactions |
| `facebook_reach` | number | Meta insights sync (`GET/POST /facebook/.../insights`) |
| `facebook_impressions` | number | Same |
| `facebook_clicks` | number | Same |
| `facebook_inline_link_clicks` | number | Same — preferred for impact "actions" |
| `facebook_frequency` | number? | Same |
| `facebook_spend` | number? | Same |
| `facebook_cpm` | number? | Same |
| `facebook_objective` | string? | Same |
| `facebook_objective_results` | number? | Same |
| `facebook_video_p75_watched` | number? | Same |
| `facebook_total_actions` | number? | Sum of Meta `actions` array |
| `facebook_actions` | array? | `{ action_type, value }[]` from Meta |
| `facebook_insights_updated_at` | string? | Same |
| `facebook_audience_size_lower_bound` | number? | Meta Estimated Audience Size (`/reachestimate`) |
| `facebook_audience_size_upper_bound` | number? | Same |
| `facebook_audience_size_estimate_ready` | boolean? | Same |
| `facebook_audience_size_updated_at` | string? | Same |

### Saturation

```
saturation_pct = total_reach / ((lower_bound + upper_bound) / 2) × 100
```

`total_reach` is Meta unique reach (`facebook_reach` / `getCampaignReach`). Denominator is the midpoint of the Estimated Audience Size range.

### `campaigns/{id}/facebook_insight_breakdowns/{type}`

Audience breakdown rows from Meta (`age`, `gender`, `publisher_platform`, `dma`).

| Field | Type | Notes |
|-------|------|--------|
| `breakdownType` | string | e.g. `age` |
| `rows` | array | `{ breakdownValue, impressions, reach, inlineLinkClicks, clicks, spend }[]` |
| `updatedAt` | string | ISO timestamp |
| `trust_score` | number | Admin / moderation |
| `category` | string | Campaign metadata |
| `thumbnail_url` | string? | Campaign media |
| `status` | string | e.g. `Approved` |

### Scope B — optional impact metrics (admin PATCH)

Set via `PATCH /data/campaigns/:id` (validated). All optional; missing fields fall back to estimates in `impactMetrics.ts`.

| Field | Type | Validation |
|-------|------|------------|
| `perception_shift` | number | 0–100, estimated incremental shift % |
| `perception_shift_actual` | number | 0–100, survey-verified shift % |
| `thumbs_up` | integer | ≥ 0 |
| `thumbs_down` | integer | ≥ 0 |
| `net_rating` | number | Optional explicit net (otherwise `thumbs_up - thumbs_down`, else trust heuristic) |

Example PATCH body:

```json
{
  "perception_shift": 5.2,
  "perception_shift_actual": 6.1,
  "thumbs_up": 186,
  "thumbs_down": 12
}
```

## `share_cards/{token}`

Created by `POST /users/me/share-cards`. Public read via `GET /public/impact/:token`.

| Field | Type | Notes |
|-------|------|--------|
| `ownerUid` | string | Firebase uid (not exposed publicly) |
| `scope` | string | `cumulative` \| `campaign` |
| `campaignId` | string? | When scope is `campaign` |
| `displayName` | string | First name / alias for public card |
| `showAmount` | boolean | Whether dollar amount is in snapshot |
| `metrics` | object | Precomputed public-safe numbers |
| `headlineTitle` | string? | OG / card title |
| `thumbnailUrl` | string? | OG image candidate |
| `createdAt` | string | ISO |
| `revoked` | boolean | `true` → 410 on public GET |

## `share_links/{ref}` (UE-188)

Per-user (or guest) share attribution codes. Short opaque `ref` is the document id.

| Field | Type | Notes |
|-------|------|--------|
| `ref` | string | Same as doc id (8-char) |
| `campaignId` | string \| null | Campaign being shared (null for cumulative impact cards) |
| `surface` | string | `campaign` \| `interstitial` \| `lander` \| `impact_card` |
| `scope` | string? | `cumulative` \| `campaign` (impact cards) |
| `shareCardToken` | string? | Linked `share_cards` token when surface is impact_card |
| `sharerUid` | string \| null | Firebase uid; null for guest shares |
| `guestDistinctId` | string \| null | PostHog distinct id when guest |
| `createdAt` | string | ISO |
| `revoked` | boolean | |
| `stats.visits` | number | Non-crawler visits (excludes self) |
| `stats.backs` | number | Attributed completed backs |
| `stats.amountCents` | number | Gross cents from attributed backs |
| `stats.reachDriven` | number | Estimated reach from attributed backs |

Subcollection `share_links/{ref}/visits/{id}`: `visitedAt`, `visitorUid?`, `visitorDistinctId?`.

## `share_attributions/{paymentId}`

Idempotent ledger of attributed backs (keyed on PaymentIntent / coupon redemption id).

| Field | Type | Notes |
|-------|------|--------|
| `share_ref` | string | |
| `campaign_id` | string \| null | |
| `amount_cents` | number | Gross |
| `reach_driven` | number | |
| `sharer_uid` | string \| null | |
| `backer_uid` | string \| null | |
| `attributed_at` | string | ISO |
| `attribution_window_days` | number | Snapshot of config at attribution time |

**Attribution window:** env `SHARE_ATTRIBUTION_WINDOW_DAYS` (default **7**), exposed at `GET /config/attribution`. First-touch `?ref=` persists client-side for this window; server attributes a back when a visit (or link creation fallback) falls inside the window.

## API endpoints (Scope B)

| Method | Path | Auth |
|--------|------|------|
| GET | `/users/me/impact?range=all` | Firebase + API key — includes `shareStats` |
| GET | `/users/me/impact/:campaignId?range=all` | Firebase + API key — includes per-campaign `shareStats` |
| POST | `/users/me/share-cards` | Firebase + API key — response includes `ref` on URL |
| GET | `/public/impact/:token` | None |
| DELETE | `/users/me/share-cards/:token` | Firebase + API key |
| POST | `/share-links` | API key; Firebase optional (guest via `posthogDistinctId`) |
| POST | `/public/share-links/:ref/visit` | None |
| GET | `/config/attribution` | None |
| GET | `/facebook/campaign/:id/insights` | API key |
| POST | `/facebook/campaign/:id/sync-insights` | API key — full sync + breakdowns |
| POST | `/facebook/sync-insights` | API key — bulk sync all published campaigns |

`range` query: `all` (default), `30d`, `90d`, `365d`, `month`.

## Frontend

Personal impact dashboards load live data from `/users/me/impact*`. Share surfaces append `?ref=` from `POST /share-links` (or the `ref` returned with impact share cards).
