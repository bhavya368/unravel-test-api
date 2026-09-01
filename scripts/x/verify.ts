/**
 * Health check for the X connection. Posts nothing.
 *
 *   npm run x:verify
 *
 * Refreshes through the same code path a real post uses, so the rotated refresh
 * token is persisted to `integrations/x` rather than being burned.
 */
import { initializeApp, applicationDefault, getApp } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { verifyXConnection } from '../../src/socialSyndication';

initializeApp({ credential: applicationDefault(), projectId: 'unravelreserchagent' });
const db = getFirestore(getApp(), 'unravel');

(async () => {
  const result = await verifyXConnection(db);
  if (result.ok) {
    console.log(`✓ X connected — posting as @${result.handle}`);
    process.exit(0);
  }
  console.error(`✗ X not usable: ${result.error}`);
  if (result.error === 'not_configured') {
    console.error('  Set X_CLIENT_ID, X_CLIENT_SECRET and X_REFRESH_TOKEN in .env');
  }
  process.exit(1);
})();
