/**
 * Read a synced deal back FROM Salesforce — confirms the write actually landed.
 *
 * Usage:
 *   node sf-query.js DR-2026-1234   → fetch that one deal by SourceSystemID
 *   node sf-query.js                → list the 10 most recently created records
 *
 * Authenticates with the same JWT flow as the Cloud Function and runs a SOQL
 * query against SF_OBJECT, printing the key fields.
 */
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');

function loadEnv(file) {
  const env = {};
  const raw = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const eq = t.indexOf('=');
    if (eq === -1) continue;
    let val = t.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    env[t.slice(0, eq).trim()] = val;
  }
  return env;
}

const env = { ...loadEnv(path.resolve(__dirname, '.env')), ...process.env };
const LOGIN_URL = env.SF_LOGIN_URL || 'https://login.salesforce.com';
const API = env.SF_API_VERSION || 'v60.0';
const OBJECT = env.SF_OBJECT || 'Lead';
const EXT_ID = env.SF_EXTERNAL_ID_FIELD || 'Deal_Registration_Id__c';

function getPrivateKey() {
  if (env.SF_PRIVATE_KEY_FILE) {
    return fs.readFileSync(path.resolve(__dirname, env.SF_PRIVATE_KEY_FILE), 'utf8');
  }
  if (env.SF_PRIVATE_KEY) return env.SF_PRIVATE_KEY.replace(/\\n/g, '\n');
  throw new Error('Missing private key — set SF_PRIVATE_KEY_FILE or SF_PRIVATE_KEY.');
}

async function getAccessToken() {
  const assertion = jwt.sign(
    { iss: env.SF_CLIENT_ID, sub: env.SF_USERNAME, aud: LOGIN_URL, exp: Math.floor(Date.now() / 1000) + 180 },
    getPrivateKey(),
    { algorithm: 'RS256' },
  );
  const res = await fetch(`${LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  });
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

const FIELDS = [
  'Id',
  'Name',
  EXT_ID,
  'Amount__c',
  'Track__c',
  'Status__c',
  'CustomerCompanyName__c',
  'CustomerWebsite__c',
  'CustomerContactFirstName__c',
  'CustomerContactLastName__c',
  'CustomerContactEmail__c',
  'CreatedDate',
];

async function main() {
  const dealId = process.argv[2];
  const where = dealId ? ` WHERE ${EXT_ID} = '${dealId.replace(/'/g, "\\'")}'` : '';
  const order = dealId ? '' : ' ORDER BY CreatedDate DESC LIMIT 10';
  const soql = `SELECT ${FIELDS.join(', ')} FROM ${OBJECT}${where}${order}`;

  const { access_token, instance_url } = await getAccessToken();
  const url = `${instance_url}/services/data/${API}/query?q=${encodeURIComponent(soql)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
  const text = await res.text();
  if (!res.ok) {
    console.error(`✗ Query failed: HTTP ${res.status}\n  ${text}`);
    process.exit(1);
  }

  const data = JSON.parse(text);
  console.log(`${OBJECT} — ${data.totalSize} record(s)${dealId ? ` for ${EXT_ID}=${dealId}` : ' (latest 10)'}\n`);
  if (!data.totalSize) {
    console.log('  (none — was the deal registered AND synced? check the functions emulator log)');
    return;
  }
  for (const r of data.records) {
    console.log(`• ${r[EXT_ID] || '(no ext id)'}  ${r.Name || ''}`);
    console.log(`    sfId     : ${r.Id}`);
    console.log(`    company  : ${r.CustomerCompanyName__c || '—'}   website: ${r.CustomerWebsite__c || '—'}`);
    console.log(`    amount   : ${r.Amount__c != null ? r.Amount__c : '—'}   track: ${r.Track__c || '—'}   status: ${r.Status__c || '—'}`);
    console.log(`    contact  : ${[r.CustomerContactFirstName__c, r.CustomerContactLastName__c].filter(Boolean).join(' ') || '—'}  <${r.CustomerContactEmail__c || '—'}>`);
    console.log(`    created  : ${r.CreatedDate}`);
    console.log(`    view     : ${instance_url}/${r.Id}`);
    console.log('');
  }
}

main().catch((err) => {
  console.error('✗ ' + (err && err.message ? err.message : err));
  process.exit(1);
});
