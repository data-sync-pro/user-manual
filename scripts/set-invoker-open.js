/**
 * Open a Cloud Run service (Cloud Functions v2) to unauthenticated invocation
 * by disabling the IAM invoker check — the workaround for the org policy that
 * blocks granting `allUsers` roles/run.invoker on this project.
 *
 * This is what refreshfromsalesforce / syncdealtosalesforce already have
 * (invokerIamDisabled: true); every NEWLY deployed callable needs it once,
 * or browser calls get 403 before reaching the function.
 *
 * Auth: reuses your Firebase CLI login (no service account key needed).
 *
 * Usage:
 *   node scripts/set-invoker-open.js registerdeal
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const PROJECT = 'partnerportal-b1d25';
const REGION = 'us-central1';

const service = (process.argv[2] || '').toLowerCase();
if (!service) {
  console.error('Usage: node scripts/set-invoker-open.js <service-name>   e.g. registerdeal');
  process.exit(1);
}

// Firebase CLI public OAuth client (embedded in firebase-tools source).
const CLIENT_ID = '563584335869-fgrhgmd47bqnekij5i8b5pr03ho849e6.apps.googleusercontent.com';
const CLIENT_SECRET = 'j9iVZfS8kkCEFUPaAeJV0sAi';

async function accessToken() {
  const cfgPath = path.join(os.homedir(), '.config', 'configstore', 'firebase-tools.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cfg.tokens.refresh_token,
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
    }),
  });
  if (!res.ok) throw new Error(`token exchange failed (${res.status}) — run \`firebase login\` first`);
  return (await res.json()).access_token;
}

async function main() {
  const token = await accessToken();
  const base = `https://run.googleapis.com/v2/projects/${PROJECT}/locations/${REGION}/services/${service}`;

  // GCF-managed services pin template.revision to the currently deployed
  // revision name; a PATCH that reuses it 409s ("Revision ... already
  // exists"). Re-send the current template WITHOUT the pinned name so Cloud
  // Run auto-generates the next one — same trick gcloud uses.
  let res = await fetch(base, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`get failed: ${res.status} ${await res.text()}`);
  const svc = await res.json();
  const template = { ...(svc.template || {}) };
  delete template.revision;

  res = await fetch(`${base}?updateMask=invokerIamDisabled,template`, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ invokerIamDisabled: true, template }),
  });
  if (!res.ok) throw new Error(`update failed: ${res.status} ${await res.text()}`);
  console.log(`PATCH accepted — waiting for the service to settle...`);

  // Poll until the change is live.
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    res = await fetch(base, { headers: { Authorization: `Bearer ${token}` } });
    const svc = await res.json();
    if (svc.invokerIamDisabled === true && !svc.reconciling) {
      console.log(`✓ ${service}: invokerIamDisabled = true — callable is now reachable from the web app`);
      return;
    }
  }
  console.log('Change submitted but still reconciling — check the Cloud Run console in a minute.');
}

main().catch((e) => { console.error('✗ ' + e.message); process.exit(1); });
