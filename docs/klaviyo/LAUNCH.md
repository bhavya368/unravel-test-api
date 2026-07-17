# Campaign Launch Report — go-live

Backend fires one Klaviyo event per backer when a campaign enters the **launch** window.

| Item | Value |
|------|--------|
| Metric name | `Unravel Campaign Launch Report` |
| Runner | `POST /campaign-report-drips/run` (requires `x-api-key`) |
| Template source | `docs/klaviyo/campaign-launch-report.html` (Klaviyo flow may already have this pasted) |
| Timing | Eligible from `campaign_starts_at − KLAVIYO_REPORT_LAUNCH_LEAD_HOURS` (default **24h**) |
| Recipients | Unique backer emails from `stripe_checkout_records` |
| Idempotency | `campaigns/{id}.campaign_report_drips.launch.sentAt` |

## 1. Environment

Set on the API service:

```
KLAVIYO_API_KEY=pk_...
KLAVIYO_REVISION=2024-10-15
KLAVIYO_REPORT_LAUNCH_LEAD_HOURS=24
FRONTEND_ORIGIN=https://your-frontend-host
```

## 2. Klaviyo flow

1. Create a **metric-triggered** flow on `Unravel Campaign Launch Report` (or confirm it already exists).
2. Email HTML should bind:

| Template | Event / profile field |
|----------|------------------------|
| Greeting | `first_name` (profile) |
| Campaign | `event.campaign_name` |
| Your amount | `event.contribution_amount` |
| Personal projected reach | `event.projected_reach` |
| Pooled | `event.pooled_amount` |
| Backers | `event.total_backers` |
| Collective reach | `event.projected_collective_reach` |
| CTA | `event.impactUrl` → `/account/impact/:campaignId` |
| Secondary | `event.campaignUrl` |
| Image | `event.thumbnailUrl` |

3. Dry-run returns `sampleEvent` with the same property names for a live check.

## 3. Dry-run (safe)

Launch-only for one campaign (ignores timing; does **not** send):

```http
POST /campaign-report-drips/run
x-api-key: <API_KEY>
Content-Type: application/json

{
  "dryRun": true,
  "campaignId": "<CAMPAIGN_ID>",
  "stage": "launch",
  "forceStage": "launch"
}
```

Check `results[0].emails`, `recipientCount`, and `sampleEvent`.

## 4. Live send (one campaign)

Same payload with `"dryRun": false`. Only sends to backers not already in `campaign_report_drips.launch.recipientEmails`.

## 5. Scheduler (all due stages)

Hourly (or similar) without filters:

```http
POST /campaign-report-drips/run
x-api-key: <API_KEY>
```

Processes due **launch → mid → recap** in order per campaign (max `limit`, default 50).

## 6. Eligibility checklist

- Campaign `status` is `Approved` or `Completed`
- At least one backer with email in `stripe_checkout_records`
- Launch not already marked sent
- For automatic timing: `now >= start − lead hours`
- `KLAVIYO_API_KEY` set (live sends fail otherwise)

## 7. Overdue / backfill

Campaigns past due but never marked sent are still eligible. One run processes **one stage per campaign** (launch first, then mid, then recap on later runs). Use dry-run with `"limit": 200` to preview the backlog before a live send.
