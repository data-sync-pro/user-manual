/**
 * Standalone Salesforce upsert smoke test.
 *
 * Authenticates via JWT (same as test-jwt.js) and upserts ONE sample record into
 * SF_OBJECT by SF_EXTERNAL_ID_FIELD = "TEST-0001". Use it to verify the custom
 * object, its fields, and the integration user's field permissions (FLS) BEFORE
 * wiring up the Functions emulator.
 *
 * Run:  node test-upsert.js
 *
 * It WRITES one record to your sandbox (safe to delete afterwards). Re-running
 * updates the same record (idempotent upsert), so it won't pile up duplicates.
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
const TEST_KEY = 'TEST-0001';

function getPrivateKey() {
  if (env.SF_PRIVATE_KEY_FILE) {
    return fs.readFileSync(path.resolve(__dirname, env.SF_PRIVATE_KEY_FILE), 'utf8');
  }
  if (env.SF_PRIVATE_KEY) return env.SF_PRIVATE_KEY.replace(/\\n/g, '\n');
  throw new Error('Missing private key — set SF_PRIVATE_KEY_FILE or SF_PRIVATE_KEY.');
}

async function getAccessToken() {
  const assertion = jwt.sign(
    {
      iss: env.SF_CLIENT_ID,
      sub: env.SF_USERNAME,
      aud: LOGIN_URL,
      exp: Math.floor(Date.now() / 1000) + 180,
    },
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

// A representative deal record — same field shape the Function writes.
const sample = {
  Name: 'JWT Smoke Test Customer',
  Amount__c: 123000,
  CustomerCompanyName__c: 'JWT Smoke Test Customer',
  CustomerWebsite__c: 'https://smoketest.example.com',
  CustomerContactFirstName__c: 'Test',
  CustomerContactLastName__c: 'Contact',
  CustomerContactEmail__c: 'test.contact@smoketest.example.com',
  Track__c: 'Solution', // picklist value must exist on the field
  Status__c: 'won', // picklist value must exist on the field
  RequestedLicenseInfo__c: 'Created by functions/test-upsert.js — safe to delete.',
};

async function main() {
  console.log(`Upsert smoke test → ${OBJECT} (${EXT_ID} = ${TEST_KEY})\n`);
  const { access_token, instance_url } = await getAccessToken();
  const url = `${instance_url}/services/data/${API}/sobjects/${OBJECT}/${EXT_ID}/${encodeURIComponent(TEST_KEY)}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(sample),
  });
  const text = await res.text();

  if (res.status === 200 || res.status === 201) {
    const data = JSON.parse(text);
    console.log(`✓ Upsert OK — record ${data.created ? 'created' : 'updated'}`);
    console.log('  id  :', data.id);
    console.log('  view:', `${instance_url}/${data.id}`);
    return;
  }
  if (res.status === 204) {
    console.log('✓ Upsert OK — record updated (no body)');
    return;
  }

  console.error(`✗ Upsert failed: HTTP ${res.status}`);
  console.error('  ' + text);
  console.error('\nCommon causes:');
  console.error(`  NOT_FOUND "The requested resource does not exist"   → object ${OBJECT} or field ${EXT_ID} missing`);
  console.error('  INVALID_FIELD "No such column \'X__c\'"               → that field isn\'t created (or wrong API name)');
  console.error('  INVALID_FIELD_FOR_INSERT_UPDATE / FLS               → integration user lacks field permission');
  console.error('  REQUIRED_FIELD_MISSING                              → a required field on the object isn\'t set here');
  console.error('  DUPLICATE_VALUE / not unique                        → SourceSystemID__c isn\'t marked External ID + Unique');
  process.exit(1);
}

main().catch((err) => {
  console.error('✗ ' + (err && err.message ? err.message : err));
  process.exit(1);
});
