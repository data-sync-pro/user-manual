/**
 * Sync registered deals into Salesforce (live).
 *
 * Trigger: a new deals/{dealId} document is created in Firestore.
 * Action:  upsert a matching record into Salesforce (idempotent, keyed by the
 *          deal id via a Salesforce External Id field), authenticated with the
 *          OAuth 2.0 JWT Bearer flow, then write the Salesforce Id back onto the
 *          deal document.
 *
 * Config (functions/.env locally, Secret Manager in production):
 *   SF_LOGIN_URL          https://login.salesforce.com (prod/dev) | https://test.salesforce.com (sandbox)
 *   SF_CLIENT_ID          Connected App Consumer Key
 *   SF_USERNAME           integration user's username
 *   SF_PRIVATE_KEY_FILE   path (relative to functions/) to the PEM private key  — OR —
 *   SF_PRIVATE_KEY        the PEM private key contents (\n-escaped)
 *   SF_OBJECT             Lead | Opportunity | Deal_Registration__c   (default Lead)
 *   SF_EXTERNAL_ID_FIELD  external-id field API name (default Deal_Registration_Id__c)
 *   SF_API_VERSION        default v60.0
 */
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

initializeApp();
const db = getFirestore();

setGlobalOptions({ region: 'us-central1', maxInstances: 5 });

const SF_OBJECT = process.env.SF_OBJECT || 'Lead';
const SF_EXTERNAL_ID_FIELD = process.env.SF_EXTERNAL_ID_FIELD || 'Deal_Registration_Id__c';
const SF_API_VERSION = process.env.SF_API_VERSION || 'v60.0';
const SF_LOGIN_URL = process.env.SF_LOGIN_URL || 'https://login.salesforce.com';

function getPrivateKey() {
  if (process.env.SF_PRIVATE_KEY_FILE) {
    return fs.readFileSync(path.resolve(__dirname, process.env.SF_PRIVATE_KEY_FILE), 'utf8');
  }
  if (process.env.SF_PRIVATE_KEY) return process.env.SF_PRIVATE_KEY.replace(/\\n/g, '\n');
  throw new Error('Missing private key — set SF_PRIVATE_KEY_FILE or SF_PRIVATE_KEY.');
}

function assertConfigured() {
  const missing = ['SF_CLIENT_ID', 'SF_USERNAME'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error('Salesforce not configured — missing: ' + missing.join(', '));
}

// Trim a value to a text field's max length; '' / null -> undefined (omit field).
function clip(value, max) {
  const v = value == null ? '' : String(value).trim();
  if (!v) return undefined;
  return max ? v.slice(0, max) : v;
}

// Normalize a bare domain into a URL field value (Salesforce URL fields want a
// scheme); '' -> undefined.
function toUrl(domain) {
  const v = clip(domain, 255);
  if (!v) return undefined;
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

// Split a full name into { first, last } (last = everything after the first token).
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  return { first: parts[0], last: parts.slice(1).join(' ') };
}

// Map a deal document -> DealRegistration__c fields (API names per the org's
// schema). The External Id field (SF_EXTERNAL_ID_FIELD) is NOT included here —
// it travels in the upsert URL, not the body. Lookup fields (Customer/Partner
// Account & Contact, Opportunity) and ExpirationDate are left unset.
function mapDealToSObject(deal, dealId) {
  const contact = deal.contact || {};
  const orgs = Array.isArray(deal.orgs) ? deal.orgs : [];
  const orgSummary = orgs
    .map((o) => `${o.name || 'org'} (${o.connections || 0} conn / ${o.executables || 0} exec)`)
    .join('; ');
  // Prefer the explicit first/last fields; fall back to splitting a combined
  // name for legacy deals registered before the form captured them separately.
  const fallback = splitName(contact.name);
  const first = contact.firstName || fallback.first;
  const last = contact.lastName || fallback.last;

  return {
    Name: clip(deal.customer || dealId, 80), // "Deal Registration Name" (record label)
    Amount__c: deal.arr != null ? Number(deal.arr) : undefined,
    CustomerCompanyName__c: clip(deal.customer, 50),
    CustomerWebsite__c: toUrl(deal.domain),
    CustomerContactFirstName__c: clip(first, 20),
    CustomerContactLastName__c: clip(last, 20),
    CustomerContactEmail__c: clip(contact.email, 80),
    Track__c: clip(deal.track), // picklist — value must exist (Solution / Referral)
    Status__c: clip(deal.status), // picklist — value must exist (pending/accepted/won/lost)
    RequestedLicenseInfo__c: clip(
      [
        deal.stage ? `Stage: ${deal.stage}` : '',
        contact.title ? `Contact title: ${contact.title}` : '',
        contact.phone ? `Contact phone: ${contact.phone}` : '',
        deal.hqCountry ? `HQ country: ${deal.hqCountry}` : '',
        deal.industry ? `Industry: ${deal.industry}` : '',
        deal.companySize ? `Company size: ${deal.companySize}` : '',
        deal.orgType ? `Org type: ${deal.orgType}` : '',
        orgSummary ? `Customer SF orgs: ${orgSummary}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      32768,
    ),
  };
}

// OAuth 2.0 JWT Bearer -> { access_token, instance_url }.
async function getAccessToken() {
  const jwt = require('jsonwebtoken');
  const assertion = jwt.sign(
    {
      iss: process.env.SF_CLIENT_ID, // Connected App Consumer Key
      sub: process.env.SF_USERNAME, // integration user
      aud: SF_LOGIN_URL, // login.salesforce.com (prod) / test.salesforce.com (sandbox)
      exp: Math.floor(Date.now() / 1000) + 180,
    },
    getPrivateKey(),
    { algorithm: 'RS256' },
  );

  const res = await fetch(`${SF_LOGIN_URL}/services/oauth2/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion,
    }),
  });
  if (!res.ok) throw new Error(`Salesforce token request failed: ${res.status} ${await res.text()}`);
  return res.json();
}

// Idempotent upsert by External Id: PATCH .../sobjects/<Object>/<ExternalIdField>/<dealId>.
async function upsertSalesforce(sobject, dealId) {
  const { access_token, instance_url } = await getAccessToken();
  const url = `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${SF_OBJECT}/${SF_EXTERNAL_ID_FIELD}/${encodeURIComponent(dealId)}`;

  const res = await fetch(url, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(sobject),
  });
  if (res.status === 200 || res.status === 201) {
    const data = await res.json(); // { id, success, created }
    return { id: data.id, created: !!data.created };
  }
  if (res.status === 204) return { id: dealId, created: false }; // updated, no body
  throw new Error(`Salesforce upsert failed: ${res.status} ${await res.text()}`);
}

exports.syncDealToSalesforce = onDocumentCreated('deals/{dealId}', async (event) => {
  const snap = event.data;
  if (!snap) return;
  const dealId = event.params.dealId;
  const deal = snap.data() || {};

  // Idempotency guard: never sync the same deal twice.
  if (deal.salesforceId) {
    logger.info(`deal ${dealId} already synced (${deal.salesforceId}) — skipping`);
    return;
  }

  try {
    assertConfigured();
    const result = await upsertSalesforce(mapDealToSObject(deal, dealId), dealId);
    await snap.ref.update({
      salesforceId: result.id,
      salesforceObject: SF_OBJECT,
      salesforceSyncedAt: FieldValue.serverTimestamp(),
      salesforceSyncError: FieldValue.delete(),
    });
    logger.info(`Synced deal ${dealId} -> ${SF_OBJECT} ${result.id}`);
  } catch (err) {
    logger.error(`Salesforce sync failed for deal ${dealId}: ${err.message}`);
    await snap.ref.update({ salesforceSyncError: err.message });
    throw err; // let Functions retry (if enabled)
  }
});
