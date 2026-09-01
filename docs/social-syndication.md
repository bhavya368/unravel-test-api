# Campaign syndication to X and Reddit

Cross-posts approved campaigns to Unravel's own X and Reddit accounts for reach.

Code lives in [`src/socialSyndication.ts`](../src/socialSyndication.ts). It follows the
same shape as `publishFacebookAdForCampaign` in `index.ts`.

## When it fires

Campaigns are created as `Pending` and go through UUTS review. Syndication happens on the
`Pending -> Approved` transition in `PATCH /data/:collection/:id`, right after the write
lands — the same place the Stripe product is created. Nothing unreviewed is ever posted.

Automatic posting additionally requires `SOCIAL_SYNDICATION_AUTO=true`. That flag is
separate from having credentials on purpose: **the campaigns database is the live one even
in local dev** (see "Local dev" below), so without the flag a laptop approval can't reach
real followers. Leave it unset locally; set it only on the deployed service.

Admins can always post manually from the review queue regardless of the flag.

## Behaviour

- **Idempotent.** A recorded `x_post_id` / `reddit_post_id` short-circuits a second attempt,
  so a double-click or a `ts-node-dev` respawn can't double-post. `force: true` overrides.
- **Non-fatal.** `syndicateApprovedCampaign` never throws. A dead token cannot turn a
  successful approval into a 500.
- **No image upload needed.** The OG / `twitter:card` tags already served from `index.ts`
  cover `twitterbot` and `redditbot`, so posting the campaign URL renders a card with the
  hero image.

Fields written back to the campaign doc: `x_post_id`, `x_post_url`, `x_published_at`,
`reddit_post_id`, `reddit_post_url`, `reddit_subreddit`, `reddit_published_at`.

## Manual endpoint

```
POST /social/publish
x-api-key: <API_KEY>

{ "campaignId": "abc123", "platform": "x" | "reddit" | "all", "force": false }
```

`platform: "all"` returns per-platform results and a 502 if either failed, so a partial
failure is never reported as success.

## Environment

Everything is optional — with nothing set, both platforms return
`{ status: 'skipped', reason: 'not_configured' }` and nothing breaks.

```
# --- X ---
X_CLIENT_ID=
X_CLIENT_SECRET=
X_REFRESH_TOKEN=          # seed value; the live token is stored in Firestore
X_ACCOUNT_HANDLE=unravel  # cosmetic, used to build the permalink

# --- Reddit ---
REDDIT_CLIENT_ID=
REDDIT_CLIENT_SECRET=
REDDIT_SUBREDDIT=unravel
REDDIT_USER_AGENT=web:network.unravel.syndication:v1.0 (by /u/YourBotAccount)
REDDIT_REFRESH_TOKEN=     # preferred
REDDIT_USERNAME=          # fallback (script apps only; breaks under 2FA)
REDDIT_PASSWORD=

# --- shared ---
FRONTEND_BASE_URL=https://unravel.network   # builds the campaign link
SOCIAL_SYNDICATION_AUTO=true                # deployed environments only
```

On Cloud Run these are service env vars — `cloudbuild.yaml` doesn't carry them, so set them
with `gcloud run services update unravel-api --update-env-vars ...` or in the console.

## Setting up X

X moved to pay-per-use in February 2026. There is **no free tier**, and Basic/Pro are closed
to new signups. Posts containing a link cost **$0.20 each** (vs $0.015 without), so budget
~$0.20 per approved campaign — negligible at current volume, but it is not zero.

1. Create a project + app at developer.x.com and enable billing.
2. Set the app to **Read and write**, type **Web App / Automated App**, with a callback URL.
3. Add `http://127.0.0.1:3456/callback` to the app's **Callback URI** list.
4. The gotcha: **an app-only Bearer token cannot post.** `X_CLIENT_ID` / `X_CLIENT_SECRET`
   only identify the app; posting needs a user-context token. Run the consent flow once:

   ```bash
   npm run x:authorize
   ```

   It prints a URL — open it while signed in **as the account that should post**, approve,
   and the script prints the `X_REFRESH_TOKEN` line to paste into `.env`. It also reports
   which account you authorized and warns if `tweet.write` wasn't granted.

### Checking the connection

```bash
npm run x:verify      # posts nothing; prints the account it would post as
```

It refreshes through the same path a real post uses, so the rotated token is persisted
rather than burned. Note this means the `X_REFRESH_TOKEN` in `.env` is only a seed — after
the first refresh the live token lives in `integrations/x`, and the `.env` value is spent.

### Verifying the credentials alone

The token endpoint tells you which half it dislikes, which makes a cheap check:

| what you send | response |
| --- | --- |
| good id + good secret | 400 — complains about the *token* |
| good id + bad secret | 401 — `Missing valid authorization header` |
| bad id | 400 — `Value passed for the client id was invalid.` |

So POSTing `grant_type=refresh_token` with a junk refresh token confirms the client pair
without needing a real one.

X **rotates the refresh token on every use**, so the live one is persisted to the Firestore
doc `integrations/x`. Don't hand-edit it. If it is lost or used by two environments at once,
the chain breaks and you must re-run `npm run x:authorize`.

## Setting up Reddit

This is the long pole — **start it first**.

Reddit closed self-service app registration under its Responsible Builder Policy. Every new
OAuth client now needs manual approval, typically **2–4 weeks**. Commercial use — which a
crowdfunding platform auto-posting campaigns squarely is — additionally requires a written
agreement. File the application before writing anything else.

Once approved:

1. Register the app, note the client id/secret.
2. Authorize the brand account with `duration=permanent` and scopes `identity submit`, and
   keep the refresh token. Reddit's refresh tokens don't rotate.
3. Set a real `REDDIT_USER_AGENT` — Reddit rate-limits generic ones aggressively.

**Where to post matters more than the code.** Most subreddits ban fundraising links, and an
account that auto-posts them gets shadowbanned quickly. Post to a subreddit Unravel owns
(create r/unravel and set `REDDIT_SUBREDDIT`). Cross-posting to topical subreddits needs
per-subreddit moderator relationships, not configuration.

## Local dev

`getFirestore(getApp(), 'unravel')` — the campaigns database — **ignores
`FIRESTORE_EMULATOR_HOST`** and connects to production. Only the default database (user
profiles) is emulated. So local campaign reads and writes hit live data, which is why
`SOCIAL_SYNDICATION_AUTO` exists and why it should stay unset on developer machines.
