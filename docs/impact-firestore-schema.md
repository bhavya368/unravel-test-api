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
| `facebook_impressions` | number | `GET /facebook/campaign/:id/insights` |
| `facebook_clicks` | number | Same |
| `facebook_insights_updated_at` | string? | Same |
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

## API endpoints (Scope B)

| Method | Path | Auth |
|--------|------|------|
| GET | `/users/me/impact?range=all` | Firebase + API key |
| GET | `/users/me/impact/:campaignId?range=all` | Firebase + API key |
| POST | `/users/me/share-cards` | Firebase + API key |
| GET | `/public/impact/:token` | None |
| DELETE | `/users/me/share-cards/:token` | Firebase + API key |

`range` query: `all` (default), `30d`, `90d`, `365d`, `month`.

## Frontend

Dashboards default to **demo data** when `VITE_DEMO_IMPACT` is not `false` (see unravel-ui `.env`).

Demo share tokens (`demo`, `demo-campaign`) are client-only and do not use Firestore.
