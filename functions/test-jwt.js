/**
 * Standalone Salesforce JWT-Bearer smoke test.
 *
 * Verifies the whole auth chain WITHOUT running the Functions emulator:
 *   private key  +  Consumer Key (iss)  +  integration user (sub)  +  pre-auth.
 *
 * Run:  node test-jwt.js
 *
 * It loads functions/.env, signs a JWT with keys/server.key, exchanges it at
 * SF_LOGIN_URL, and prints the access token (masked) + instance_url on success,
 * or the raw Salesforce error on failure (the error body is the useful part).
 */
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

// --- minimal .env loader (no dotenv dependency) ---------------------------
function loadEnv(file) {
  const env = {};
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    let val = t.slice(eq + 1).trim();
    // Strip a single pair of surrounding quotes, like dotenv does.
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[t.slice(0, eq).trim()] = val;
  }
  return env;
}

const env = { ...loadEnv(path.resolve(__dirname, '.env')), ...process.env };

const LOGIN_URL = env.SF_LOGIN_URL || 'https://login.salesforce.com';
const CLIENT_ID = env.SF_CLIENT_ID;
const USERNAME = env.SF_USERNAME;

function getPrivateKey() {
  if (env.SF_PRIVATE_KEY_FILE) {
    return fs.readFileSync(path.resolve(__dirname, env.SF_PRIVATE_KEY_FILE), 'utf8');
  }
  if (env.SF_PRIVATE_KEY) return env.SF_PRIVATE_KEY.replace(/\\n/g, '\n');
  throw new Error('Missing private key — set SF_PRIVATE_KEY_FILE or SF_PRIVATE_KEY.');
}

const mask = (s) => (s && s.length > 12 ? s.slice(0, 6) + '…' + s.slice(-4) : s);

// --- sanity checks --------------------------------------------------------
const problems = [];
// Salesforce Consumer Keys start with "3MVG9" and are ~85 chars.
if (!CLIENT_ID || CLIENT_ID.length < 50 || !/^3MVG9/.test(CLIENT_ID)) {
  problems.push('SF_CLIENT_ID looks unset/invalid — paste your Connected App Consumer Key (starts with 3MVG9…).');
}
if (!USERNAME || !USERNAME.includes('@')) {
  problems.push('SF_USERNAME looks unset/invalid — set the integration user\'s Salesforce username.');
}

console.log('Salesforce JWT smoke test');
console.log('  login_url :', LOGIN_URL);
console.log('  client_id :', mask(CLIENT_ID));
console.log('  username  :', USERNAME);
console.log('  key file  :', env.SF_PRIVATE_KEY_FILE || '(inline SF_PRIVATE_KEY)');
console.log('');

if (problems.length) {
  console.error('⚠ Config not ready:');
  problems.forEach((p) => console.error('   - ' + p));
  console.error('\nFix functions/.env, then re-run: node test-jwt.js');
  process.exit(1);
}

async function main() {
  const assertion = jwt.sign(
    {
      iss: CLIENT_ID, // Connected App Consumer Key
      sub: USERNAME, // integration user
      aud: LOGIN_URL, // MUST match where the user logs in (sandbox => test.salesforce.com)
      exp: Math.floor(Date.now() / 1000) + 180,
    },
    getPrivateKey(),
    { algorithm: 'RS256' },
  );

  const res = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`✗ Token request failed: HTTP ${res.status}`);
    console.error('  ' + text);
    console.error('\nCommon causes:');
    console.error('  invalid_grant "user hasn\'t approved this consumer"  → pre-authorize the user');
    console.error('     (Connected App → Manage → Edit Policies → Permitted Users =');
    console.error('      "Admin approved users are pre-authorized", then assign the user\'s');
    console.error('      Profile or a Permission Set to the app).');
    console.error('  invalid_grant "invalid assertion / audience"        → wrong aud (sandbox vs prod) or cert≠key');
    console.error('  invalid_client_id                                   → wrong Consumer Key');
    console.error('  invalid_grant "user is not active / not found"      → wrong SF_USERNAME');
    process.exit(1);
  }

  const tok = JSON.parse(text);
  console.log('✓ Auth OK');
  console.log('  instance_url :', tok.instance_url);
  console.log('  token_type   :', tok.token_type);
  console.log('  access_token :', mask(tok.access_token));
  console.log('\nNext: start the Functions emulator and register a deal to test the upsert.');
}

main().catch((err) => {
  console.error('✗ ' + (err && err.message ? err.message : err));
  process.exit(1);
});
