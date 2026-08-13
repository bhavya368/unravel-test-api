# Meta ad metrics for impact reports

Reference derived from the Meta metrics spec. These map to fields fetched by
`src/facebookInsights.ts` and persisted on `campaigns/{id}`.

## Dimensions (campaign-level)

| Meta field | Firestore / usage |
|------------|-------------------|
| `campaign_name` | `campaigns.title` |
| `campaign_start` | `campaigns.campaign_starts_at` |
| `campaign_end` | derived from `duration_days` / `duration_hours` |
| `campaign_id` | `campaigns.facebook_campaign_id` |

## Breakdowns (subcollection)

Stored at `campaigns/{id}/facebook_insight_breakdowns/{type}`:

- `age`
- `gender`
- `publisher_platform`
- `dma`

## Core metrics → impact report

| Meta metric | Firestore field | Impact report usage |
|-------------|-----------------|---------------------|
| `reach` | `facebook_reach` | People reached |
| `impressions` | `facebook_impressions` | Views |
| `inline_link_clicks` | `facebook_inline_link_clicks` | Link-click fallback for Actions |
| `clicks` | `facebook_clicks` | Reporting / click fallback |
| `frequency` | `facebook_frequency` | Reporting / email |
| `spend` | `facebook_spend` | Reporting |
| `cpm` | `facebook_cpm` | Reporting |
| `objective` | `facebook_objective` | Reporting |
| `results` | `facebook_objective_results` | Objective results |
| `result_rate` | `facebook_objective_result_rate` | Objective result rate |
| `video_p75_watched_actions` | `facebook_video_p75_watched` | Video engagement |
| `actions` (array) | `facebook_actions`, `facebook_total_actions` | Engagement breakdown; Actions counts shares, saves, follows, and link clicks |
| Estimated Audience Size (`/reachestimate`) | `facebook_audience_size_lower_bound`, `facebook_audience_size_upper_bound` | Saturation denominator (midpoint of range) |

## Saturation

```
saturation (%) = Meta unique reach / average(audience_size_lower, audience_size_upper) × 100
```

Audience size is fetched from Meta Ad Account `/reachestimate` during insights sync and ad publish.

## Sync endpoints

- `GET /facebook/campaign/:id/insights` — fetch + persist core metrics
- `POST /facebook/campaign/:id/sync-insights` — full sync including breakdowns
- `POST /facebook/sync-insights` — bulk sync all published campaigns

Campaign report drips refresh stale insights (>6h) before sending Klaviyo events.
