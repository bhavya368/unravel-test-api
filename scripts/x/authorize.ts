/**
 * One-time OAuth 2.0 (Authorization Code + PKCE) flow for X.
 *
 * X_CLIENT_ID / X_CLIENT_SECRET identify the *app*. They cannot post — posting needs
 * a user-context token, and an app-only Bearer token is rejected by POST /2/tweets.
 * This script runs the consent flow once, signed in as the brand account, and prints
 * the refresh token to put in X_REFRESH_TOKEN.
 *
 *   npx ts-node --transpile-only -r dotenv/config scripts/x/authorize.ts
 *
 * Prerequisites in the X developer portal for this app:
 *   - User authentication set up, App permissions = "Read and write"
 *   - Type of App = Web App / Automated App or Bot (these are confidential clients)
 *   - Callback URI includes exactly:  http://127.0.0.1:3456/callback
 *
 * The refresh token X returns rotates on every use; once the server stores it in the
 * Firestore doc `integrations/x`, that copy is the live one. Re-run this only if the
 * chain breaks (revoked, or two environments sharing one token).
 */
import { createHash, randomBytes } from 'crypto';
import { createServer } from 'http';

const REDIRECT_URI = process.env.X_REDIRECT_URI || 'http://127.0.0.1:3456/callback';
const PORT = Number(new URL(REDIRECT_URI).port || 3456);
const SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];

const clientId = (process.env.X_CLIENT_ID || '').trim();
const clientSecret = (process.env.X_CLIENT_SECRET || '').trim();

if (!clientId || !clientSecret) {
  console.error('X_CLIENT_ID and X_CLIENT_SECRET must be set in .env');
  process.exit(1);
}

/** RFC 7636 S256: base64url(sha256(verifier)). */
const base64url = (buf: Buffer): string =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

const verifier = base64url(randomBytes(64));
const challenge = base64url(createHash('sha256').update(verifier).digest());
const state = base64url(randomBytes(16));

const authUrl =
  'https://x.com/i/oauth2/authorize?' +
  new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    scope: SCOPES.join(' '),
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
  });

async function exchangeCode(code: string): Promise<void> {
  const res = await fetch('https://api.x.com/2/oauth2/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
      client_id: clientId,
    }),
  });

  const payload = (await res.json().catch(() => ({}))) as Record<string, any>;
  if (!res.ok || !payload?.refresh_token) {
    console.error(`\n✗ Token exchange failed (HTTP ${res.status})`);
    console.error(JSON.stringify(payload, null, 2));
    if (!payload?.refresh_token && res.ok) {
      console.error('\nNo refresh_token came back — the app is missing the offline.access scope.');
    }
    process.exit(1);
  }

  // Confirm the token actually works and name the account it posts as, so nobody
  // discovers they authorized a personal account only after the first live post.
  let who = '(unknown)';
  try {
    const me = await fetch('https://api.x.com/2/users/me', {
      headers: { Authorization: `Bearer ${payload.access_token}` },
    });
    const body = (await me.json().catch(() => ({}))) as Record<string, any>;
    if (body?.data?.username) who = `@${body.data.username}`;
  } catch {
    /* non-fatal: the refresh token is still valid */
  }

  console.log('\n✓ Authorized as ' + who);
  console.log(`  granted scopes: ${payload.scope ?? '(none reported)'}`);
  if (!String(payload.scope ?? '').includes('tweet.write')) {
    console.log('\n  ⚠ tweet.write was NOT granted — set App permissions to "Read and write"');
    console.log('    in the developer portal, then re-run. Posting will fail without it.');
  }
  console.log('\nAdd this line to server/.env:\n');
  console.log(`X_REFRESH_TOKEN=${payload.refresh_token}\n`);
  if (who !== '(unknown)') console.log(`X_ACCOUNT_HANDLE=${who.replace('@', '')}\n`);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || '/', REDIRECT_URI);
  if (url.pathname !== new URL(REDIRECT_URI).pathname) {
    res.writeHead(404).end('not found');
    return;
  }

  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');
  const returnedState = url.searchParams.get('state');

  const finish = (message: string) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(`<html><body style="font-family:system-ui;padding:3rem">
      <h2>${message}</h2><p>You can close this tab and return to the terminal.</p></body></html>`);
  };

  if (error) {
    finish('Authorization denied');
    console.error(`\n✗ X returned: ${error} — ${url.searchParams.get('error_description') ?? ''}`);
    server.close();
    process.exit(1);
  }
  // Guards against a callback that didn't originate from this run.
  if (returnedState !== state) {
    finish('State mismatch — ignoring');
    console.error('\n✗ state mismatch; ignoring this callback');
    return;
  }
  if (!code) {
    finish('No code in callback');
    return;
  }

  finish('Authorized — check your terminal');
  server.close();
  await exchangeCode(code);
  process.exit(0);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('\nOpen this URL while signed in as the account that should post:\n');
  console.log(authUrl + '\n');
  console.log(`Waiting for the callback on ${REDIRECT_URI} …`);
  console.log('(Ctrl+C to abort)\n');
});
