/**
 * Salesforce <-> Partner Portal integration.
 *
 * 1. syncDealToSalesforce / registerDeal — push registered deals into Salesforce.
 *    Trigger: a new deals/{dealId} document is created in Firestore.
 *    Action:  upsert a matching record into Salesforce (idempotent, keyed by the
 *             deal id via a Salesforce External Id field), authenticated with the
 *             OAuth 2.0 JWT Bearer flow, then write the Salesforce Id back onto the
 *             deal document.
 *
 * 2. refreshFromSalesforce — mirror Salesforce-side deal edits back into Firestore.
 *
 * 3. sfProvisionPartner — HTTPS endpoint Salesforce calls (Apex callout with a
 *    shared secret) to provision a portal login for a partner Account's primary
 *    contact. Replaced the scheduled pull on 2026-07-17: the Integration-license
 *    API user cannot read Account/Contact, so Salesforce pushes the data with
 *    each request instead. See the PARTNER PROVISIONING section at the bottom
 *    of this file.
 *
 *    OFFBOARDING: to revoke a partner, DISABLE the user in the Firebase
 *    Authentication console — provisioning skips disabled accounts forever.
 *    Deleting partners/{uid} is NOT the way and NOT reversible here: with the
 *    Auth user still present, the next push sees a uid with no profile, takes
 *    the adopt-refusal path (it cannot prove the account is the real
 *    partner's), and only logs a warning — forever. The partner loses the portal
 *    and no new invite is ever mailed; recovery is `scripts/bootstrap.js` by hand.
 *
 * Config (functions/.env — bundled with the deploy; TODO: move the private key
 * to Secret Manager via defineSecret before broad production use):
 *   SF_LOGIN_URL          https://login.salesforce.com (prod/dev) | https://test.salesforce.com (sandbox)
 *   SF_CLIENT_ID          Connected App Consumer Key
 *   SF_USERNAME           integration user's username
 *   SF_PRIVATE_KEY_FILE   path (relative to functions/) to the PEM private key  — OR —
 *   SF_PRIVATE_KEY        the PEM private key contents (\n-escaped)
 *   SF_OBJECT             Lead | Opportunity | Deal_Registration__c   (default Lead)
 *   SF_EXTERNAL_ID_FIELD  external-id field API name (default Deal_Registration_Id__c)
 *   SF_API_VERSION        default v60.0
 *   SF_PARTNER_SYNC_MODE  off | dryrun | live   (default OFF — see below)
 *   SF_PARTNER_TYPE_FIELD Account field whose non-empty value marks a partner
 *                         Account AND supplies the partner's track (default PartnerType__c)
 *   SF_PRIMARY_CONTACT_FIELD  Account Lookup(Contact) naming the one contact who
 *                         gets the portal login (default Primary_Contact__c)
 *   SF_PUSH_SECRET        shared secret for the sfProvisionPartner endpoint
 *                         (>= 32 chars; the Apex callout sends it in the
 *                         X-Portal-Secret header; unset disables the endpoint)
 *
 * NOTE on SF_PARTNER_SYNC_MODE's default: functions/.env is gitignored but IS
 * uploaded with the deploy, so a deploy from a machine without it silently takes
 * the default. A default that could create accounts and send mail is unacceptable,
 * so the default is `off`.
 */
const { onDocumentCreated } = require('firebase-functions/v2/firestore');
const { onCall, onRequest, HttpsError } = require('firebase-functions/v2/https');
const { setGlobalOptions } = require('firebase-functions/v2');
const logger = require('firebase-functions/logger');
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore, FieldValue, Timestamp } = require('firebase-admin/firestore');
const crypto = require('crypto'); // Node's global `crypto` is WebCrypto — no randomBytes.
const fs = require('fs');
const path = require('path');

initializeApp();
const db = getFirestore();
// Deliberately NOT named `auth`: that identifier already means "a Salesforce access
// token" throughout this file (querySalesforceAll's param, and the local in the pull).
const fbAuth = getAuth();

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
  // Missing config won't fix itself on retry — mark permanent.
  const err = new Error('Missing private key — set SF_PRIVATE_KEY_FILE or SF_PRIVATE_KEY.');
  err.permanent = true;
  throw err;
}

function assertConfigured() {
  const missing = ['SF_CLIENT_ID', 'SF_USERNAME'].filter((k) => !process.env[k]);
  if (missing.length) {
    // Missing config won't fix itself on retry — mark permanent.
    const err = new Error('Salesforce not configured — missing: ' + missing.join(', '));
    err.permanent = true;
    throw err;
  }
}

// The partner profile doc snapshot for a uid (or null). `snap.exists` doubles
// as the server-side invite gate: no partners/{uid} doc means the account was
// never provisioned and must not reach Salesforce.
async function partnerSnap(uid) {
  if (!uid) return null;
  return db.collection('partners').doc(uid).get();
}

// The partner's Salesforce Account Id (partners/{uid}.salesforceAccountId), or
// null. Ties portal partners to a SF Account for PartnerAccount-scoped sync.
async function partnerAccountId(uid) {
  const snap = await partnerSnap(uid);
  return (snap && snap.exists && snap.get('salesforceAccountId')) || null;
}

// Error carrying the Salesforce HTTP status so callers can tell transient
// failures (retry) from permanent ones (record and stop).
function sfError(message, status) {
  const err = new Error(message);
  err.status = status;
  return err;
}

// Escape a value for inclusion inside a single-quoted SOQL string literal.
// Backslash MUST be escaped before the quote, or an input ending in `\` would
// let the following `'` terminate the literal early (SOQL injection).
function soqlStr(v) {
  return String(v == null ? '' : v).replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

// A Salesforce record Id is exactly 15 or 18 case-sensitive alphanumerics.
// Anything else in a `WHERE Id IN (...)` fails the whole SOQL, so ids are
// validated before they reach a query.
const looksLikeSfId = (v) => /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(v || '');

// Legacy 'DR-YYYY-NNNNNN' external id (the old client-generated scheme). Those
// deals live under that id as the Firestore doc key; everything newer keys on
// the Salesforce record Id. Shared by registerDeal (a client idempotency token
// must not collide with the legacy shape) and the pull's doc-key resolution.
const isLegacyExtId = (v) => /^DR-\d{4}-\d{6}$/.test(v || '');

// Worth retrying: network errors (no status) and 429/5xx. Other 4xx (bad
// field, picklist value) won't fix itself — don't loop on it. Config errors
// are flagged permanent explicitly.
function isTransient(err) {
  if (err && err.permanent) return false;
  const s = err && err.status;
  if (s == null || s === 429 || s >= 500) return true;
  // Salesforce returns 403 REQUEST_LIMIT_EXCEEDED when the org's daily API
  // quota is exhausted — self-heals within ~24h, so retry rather than drop.
  if (s === 403 && /REQUEST_LIMIT_EXCEEDED/i.test((err && err.message) || '')) return true;
  return false;
}

// Best-effort marker write — must never throw, or it would mask the original
// error and derail the transient/permanent decision in the caller.
async function recordSyncError(ref, message) {
  try {
    await ref.update({ salesforceSyncError: message });
  } catch (e) {
    logger.warn(`could not record sync error on ${ref.path}: ${e.message}`);
  }
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
  const url = /^https?:\/\//i.test(v) ? v : `https://${v}`;
  // SF Url fields cap at a fixed 255 chars; prepending the scheme can push a
  // 255-char domain to 263, so clip the final value to avoid a permanent
  // STRING_TOO_LONG on the upsert (input allows domain up to 255).
  return clip(url, 255);
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
  // Customer Salesforce orgs serialized as a JSON array string for
  // RequestedLicenseInfo__c, e.g.
  // [{"name":"o1","connections":5,"executables":200,"daily_batch":"20k"}].
  const orgsJson = JSON.stringify(
    orgs.map((o) => ({
      name: o.name || '',
      connections: Number(o.connections) || 0,
      executables: Number(o.executables) || 0,
      // Drop the " records" suffix: '20k records' -> '20k', '1M records' -> '1M'.
      daily_batch: String(o.batch || '').replace(/\s*records$/i, '').trim(),
    })),
  );
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
    CustomerContactTitle__c: clip(contact.title, 20),
    CustomerContactEmail__c: clip(contact.email, 80),
    // contact.phone is intentionally NOT mapped — the portal collects it into
    // Firestore only (per product decision). Add a mapping here only once the
    // SF org's phone field API name is confirmed; a wrong name fails the upsert.
    // Dedicated fields (all Text(20)) — formerly crammed into RequestedLicenseInfo__c.
    Stage__c: clip(deal.stage, 20),
    CustomerCountry__c: clip(deal.hqCountry, 20),
    industry__c: clip(deal.industry, 20), // API name is lowercase in this org
    CustomerCompanySize__c: clip(deal.companySize, 20),
    CustomerOrgType__c: clip(deal.orgType, 20),
    Track__c: clip(deal.track), // picklist — value must exist (Solution / Referral)
    Status__c: clip(deal.status), // picklist — value must exist (pending/accepted/won/lost)
    // Customer Salesforce orgs as a JSON array string (parseable downstream).
    RequestedLicenseInfo__c: clip(orgsJson, 32768),
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
  if (!res.ok) throw sfError(`Salesforce token request failed: ${res.status} ${await res.text()}`, res.status);
  return res.json();
}

// Create a new record: POST .../sobjects/<Object>/ -> the new record Id.
// Used by registerDeal, where Salesforce assigns the deal id.
async function createSalesforce(sobject) {
  const { access_token, instance_url } = await getAccessToken();
  const url = `${instance_url}/services/data/${SF_API_VERSION}/sobjects/${SF_OBJECT}/`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(sobject),
  });
  if (res.status === 200 || res.status === 201) {
    const data = await res.json(); // { id, success, errors }
    return data.id;
  }
  throw sfError(`Salesforce create failed: ${res.status} ${await res.text()}`, res.status);
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
  throw sfError(`Salesforce upsert failed: ${res.status} ${await res.text()}`, res.status);
}

// retry:true — safe because the upsert is idempotent (external-id PATCH) and
// guarded by deal.salesforceId. Transient SF failures re-fire the event
// instead of silently losing the push.
exports.syncDealToSalesforce = onDocumentCreated(
  { document: 'deals/{dealId}', retry: true },
  async (event) => {
    const snap = event.data;
    if (!snap) return;
    const dealId = event.params.dealId;
    const deal = snap.data() || {};

    // Idempotency guard: never sync the same deal twice.
    if (deal.salesforceId) {
      logger.info(`deal ${dealId} already synced (${deal.salesforceId}) — skipping`);
      return;
    }

    // Server-side invite gate: only deals owned by a provisioned partner reach
    // Salesforce. (Rules enforce this too; this covers pre-rules data and
    // defense in depth.) Not transient — don't retry.
    const owner = await partnerSnap(deal.ownerUid);
    if (!owner || !owner.exists) {
      logger.warn(`deal ${dealId}: owner ${deal.ownerUid || '(none)'} has no partner profile — not syncing`);
      await recordSyncError(snap.ref, 'owner-not-provisioned');
      return;
    }

    try {
      assertConfigured();
      const sobject = mapDealToSObject(deal, dealId);
      // Attribute the deal to the partner's Salesforce Account so the
      // PartnerAccount-scoped reverse mirror can find it.
      const accountId = (owner.exists && owner.get('salesforceAccountId')) || null;
      if (accountId) sobject.PartnerAccount__c = accountId;
      const result = await upsertSalesforce(sobject, dealId);
      await snap.ref.update({
        salesforceId: result.id,
        salesforceObject: SF_OBJECT,
        salesforceSyncedAt: FieldValue.serverTimestamp(),
        salesforceSyncError: FieldValue.delete(),
      });
      logger.info(`Synced deal ${dealId} -> ${SF_OBJECT} ${result.id}`);
    } catch (err) {
      // Full detail stays in the logs; the deal doc is owner-readable, so it
      // only gets an opaque marker. recordSyncError never throws, so the
      // transient/permanent decision below always runs on the ORIGINAL error.
      logger.error(`Salesforce sync failed for deal ${dealId}: ${err.message}`);
      await recordSyncError(snap.ref, 'sync-failed');
      if (isTransient(err)) throw err; // re-fire the event (retry: true)
      // Permanent (4xx/config): retrying would loop for a day — record and stop.
    }
  },
);

/* =========================== REGISTRATION ============================ */

// Legal attestations the wizard forces before submit — persisted as compliance
// evidence on the deal doc.
const AFFIRM_KEYS = [
  'affirmSelfReferral', 'affirmEmployment', 'affirmPipeline', 'affirmConsent', 'affirmTruthful',
];

// Mirror of web/src/app/core/validators.ts — keep in sync. The wizard enforces
// these client-side, but the callable is directly invocable, so re-enforce here.
const isValidEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(v == null ? '' : v).trim());
const PERSONAL_EMAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'yahoo.co.in', 'yahoo.ca', 'yahoo.fr', 'yahoo.de', 'ymail.com', 'rocketmail.com',
  'hotmail.com', 'hotmail.co.uk', 'hotmail.fr', 'hotmail.de',
  'outlook.com', 'outlook.co.uk', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com',
  'protonmail.com', 'proton.me', 'pm.me',
  'gmx.com', 'gmx.net', 'gmx.de',
  'mail.com', 'mail.ru',
  'zoho.com',
  'yandex.com', 'yandex.ru',
  'qq.com', '163.com', '126.com', 'sina.com', 'sohu.com',
  'naver.com', 'daum.net',
  'hey.com',
  'fastmail.com', 'tutanota.com', 'tutamail.com',
  'inbox.com', 'rediffmail.com',
]);
function isPersonalEmail(v) {
  if (!v) return false;
  const str = String(v);
  const at = str.lastIndexOf('@');
  if (at < 0) return false;
  return PERSONAL_EMAIL_DOMAINS.has(str.slice(at + 1).trim().toLowerCase());
}

// Full server-side validation of a sanitized deal — mirrors the wizard's
// REQUIRED fields (deal-registration.component.ts) so a direct callable invoke
// can't bypass the required contact/email/attestation checks.
function assertDealValid(deal) {
  if (!deal.customer) throw new HttpsError('invalid-argument', 'Customer company name is required.');
  if (!deal.domain) throw new HttpsError('invalid-argument', 'Customer website/domain is required.');
  const c = deal.contact || {};
  if (!c.firstName || !c.lastName || !c.title) {
    throw new HttpsError('invalid-argument', 'Contact first name, last name, and title are required.');
  }
  if (!c.email || !isValidEmail(c.email)) {
    throw new HttpsError('invalid-argument', 'A valid work email is required.');
  }
  if (isPersonalEmail(c.email)) {
    throw new HttpsError('invalid-argument', 'Please use a work email address, not a personal one.');
  }
  const missing = AFFIRM_KEYS.filter((k) => deal.affirmations[k] !== true);
  if (missing.length) {
    throw new HttpsError('invalid-argument', 'All required attestations must be confirmed before registering.');
  }
}

// Server-side deal-registration rate limit — mirrors the client SubmissionLimiter
// (5 per 24h) which is bypassable (localStorage). Per-uid rolling window in
// submitLimits/{uid} (Admin-SDK only; default-deny rules keep it client-opaque),
// enforced transactionally so a scripted burst can't pollute Salesforce or burn
// the org's daily API quota.
const MAX_DEALS_PER_WINDOW = 5;
const SUBMIT_WINDOW_MS = 24 * 60 * 60 * 1000;
async function assertUnderSubmitLimit(uid) {
  const ref = db.collection('submitLimits').doc(uid);
  const now = Date.now();
  const cutoff = now - SUBMIT_WINDOW_MS;
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const prev = (snap.exists && Array.isArray(snap.get('ts')) ? snap.get('ts') : []).filter(
      (t) => typeof t === 'number' && t >= cutoff,
    );
    if (prev.length >= MAX_DEALS_PER_WINDOW) {
      throw new HttpsError(
        'resource-exhausted',
        'Daily deal-registration limit reached. Please try again later or contact your partner manager.',
      );
    }
    prev.push(now);
    tx.set(ref, { ts: prev }, { merge: true });
  });
}

// Whitelist-copy the client-submitted deal fields. Client input is untrusted:
// only known fields reach Firestore, with basic type coercion and length caps.
// Portal-only fields (products, successPlan, orgs, engagement, phone, …) live
// on the doc but are not sent to Salesforce.
function sanitizeDealInput(input) {
  const str = (v, max) => clip(v, max) || '';
  const contact = input.contact && typeof input.contact === 'object' ? input.contact : {};
  const orgs = Array.isArray(input.orgs)
    ? input.orgs.slice(0, 50).map((o) => ({
        name: str(o && o.name, 200),
        connections: Number(o && o.connections) || 0,
        executables: Number(o && o.executables) || 0,
        batch: str(o && o.batch, 50),
      }))
    : [];
  const products = Array.isArray(input.products)
    ? input.products.slice(0, 20).map((p) => str(p, 100)).filter(Boolean)
    : [];
  // Legal attestations — stored on the mirror doc for compliance evidence
  // (portal-only; not sent to Salesforce). Coerce each to a strict boolean.
  const affIn = input.affirmations && typeof input.affirmations === 'object' ? input.affirmations : {};
  const affirmations = {};
  for (const k of AFFIRM_KEYS) affirmations[k] = affIn[k] === true;
  return {
    customer: str(input.customer, 200),
    domain: str(input.domain, 255),
    // Amount is NOT client-supplied: the wizard never collects it, and the deal
    // amount (Amount__c) that drives tier/commission is set later in Salesforce
    // and mirrored back by the pull. Forcing 0 blocks a direct callable invoke
    // from pre-seeding an arbitrary (or negative) commission-driving amount.
    arr: 0,
    stage: str(input.stage, 50),
    status: 'pending',
    track: str(input.track, 50),
    products,
    contact: {
      firstName: str(contact.firstName, 100),
      lastName: str(contact.lastName, 100),
      name: str(contact.name, 200),
      title: str(contact.title, 100),
      email: str(contact.email, 200),
      phone: str(contact.phone, 50),
    },
    hqCountry: str(input.hqCountry, 100),
    industry: str(input.industry, 100),
    companySize: str(input.companySize, 50),
    orgType: str(input.orgType, 50),
    successPlan: str(input.successPlan, 5000),
    orgs,
    engagement: str(input.engagement, 5000),
    origin: str(input.origin, 200),
    affirmations,
  };
}

// Callable: register a deal, Salesforce-first. The record is created in
// Salesforce (the source of truth) and its record Id IS the deal id — nothing
// is generated locally, so deals/{id} docs can only ever mirror a real
// Salesforce record. The mirror doc is written here (not by the pull) so the
// partner sees the deal immediately; the onDocumentCreated push trigger skips
// it because salesforceId is already set.
exports.registerDeal = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  // Server-side invite gate — same rule as the push trigger.
  const partner = await partnerSnap(uid);
  if (!partner || !partner.exists) {
    throw new HttpsError(
      'permission-denied',
      "Your account isn't allowed to register deals. Please contact your partner manager.",
    );
  }
  const accountId = partner.get('salesforceAccountId');
  if (!accountId) {
    throw new HttpsError(
      'failed-precondition',
      'No Salesforce account is linked to your profile. Please contact your partner manager.',
    );
  }

  const input = request.data && typeof request.data === 'object' ? request.data : {};
  const deal = sanitizeDealInput(input);
  // Full server-side validation (required contact fields, work-email format,
  // legal attestations) — the wizard enforces these but the callable is directly
  // invocable, so don't trust the client.
  assertDealValid(deal);

  // Idempotency: the client sends a stable token per submission (reused across
  // retries). Stamped into the external-id field, it makes a retried submit
  // (timeout, dropped response, resubmit-after-error) converge on ONE Salesforce
  // record instead of minting duplicates. The token is NOT the deal id — the
  // deal id is still the Salesforce record Id.
  // A valid token must NOT look like a legacy 'DR-YYYY-NNNNNN' external id, or
  // the pull would treat it as a legacy doc key and mirror a duplicate doc.
  const rawToken = input.clientToken;
  const token =
    typeof rawToken === 'string' &&
    /^[A-Za-z0-9._-]{8,64}$/.test(rawToken) &&
    !isLegacyExtId(rawToken)
      ? rawToken
      : null;

  try {
    assertConfigured();
  } catch (e) {
    logger.error(`registerDeal: not configured — ${e.message}`);
    throw new HttpsError('failed-precondition', 'Salesforce sync is not configured.');
  }

  // Server-side rate limit — the client SubmissionLimiter is bypassable. Checked
  // after validation/config so bad input and misconfig don't consume the quota.
  await assertUnderSubmitLimit(uid);

  let sfId;
  try {
    const sobject = mapDealToSObject(deal, '');
    // Attribute the deal to the partner's Account so account-scoped pulls see it.
    sobject.PartnerAccount__c = accountId;
    if (token) {
      // Upsert by the token (external id) so a retried submit converges on ONE
      // record instead of duplicating. Then resolve the REAL record Id: a 204
      // update returns no body (result.id is the token, not an SF id), and a
      // concurrent create can land between attempts — so re-query by the token
      // whenever the upsert didn't hand back a real record Id.
      const result = await upsertSalesforce(sobject, token);
      sfId = looksLikeSfId(result.id) ? result.id : null;
      if (!sfId) {
        const found = await querySalesforceAll(
          `SELECT Id FROM ${SF_OBJECT} WHERE ${SF_EXTERNAL_ID_FIELD} = '${soqlStr(token)}' LIMIT 1`,
        );
        if (!found.length) throw sfError('Upserted record not found by external id', 500);
        sfId = found[0].Id;
      }
    } else {
      sfId = await createSalesforce(sobject);
    }
  } catch (err) {
    // SF error bodies can echo schema details — log them, return a generic
    // message. A permanent 4xx (bad picklist, validation rule) will not fix
    // itself on retry, so don't tell the user to try again.
    logger.error(`registerDeal: Salesforce write failed for ${uid}: ${err.message}`);
    if (isTransient(err)) {
      throw new HttpsError('unavailable', 'Could not register the deal in Salesforce. Please try again in a moment.');
    }
    throw new HttpsError('invalid-argument', 'The deal could not be registered — please review the fields and try again.');
  }

  try {
    await db.collection('deals').doc(sfId).set({
      ...deal,
      id: sfId,
      ownerUid: uid,
      salesforceId: sfId,
      salesforceObject: SF_OBJECT,
      submittedAt: FieldValue.serverTimestamp(),
      salesforceSyncedAt: FieldValue.serverTimestamp(),
    });
  } catch (e) {
    // The Salesforce record (source of truth) already exists; the next pull
    // will mirror it. Do NOT surface an error — a resubmit would duplicate the
    // SF record. The mirror is briefly missing portal-only fields until then.
    logger.error(`registerDeal: mirror write failed for ${sfId} (${uid}): ${e.message} — pull will heal it`);
  }
  logger.info(`registerDeal: registered ${SF_OBJECT} ${sfId} for ${uid} (account ${accountId})`);
  return { id: sfId, status: 'pending' };
});

/* =========================== COMMISSION TIERS ============================ */
// Mirror of web/src/app/core/tiers.ts — keep the ladder in sync. Used to lock in
// a deal's commission rate at settlement (in the pull below) so a partner's
// historical commission can't drift as later deals move the trailing-12-month
// tier window.
const TIERS = [
  { name: 'Registered', min: 0, referral: 0.15, solution: 0.2 },
  { name: 'Silver', min: 250000, referral: 0.18, solution: 0.23 },
  { name: 'Gold', min: 1000000, referral: 0.22, solution: 0.27 },
  { name: 'Platinum', min: 5000000, referral: 0.25, solution: 0.3 },
];

// Highest tier whose floor the trailing ARR has reached.
function tierFor(trailingArr) {
  let current = TIERS[0];
  for (const tier of TIERS) if (trailingArr >= tier.min) current = tier;
  return current;
}

// Solution track earns the higher rate; anything else falls back to referral.
function rateForTrack(tier, track) {
  return /solution/i.test(track || '') ? tier.solution : tier.referral;
}

// 'YYYY-MM-DD' (UTC) for a millis timestamp.
const ymdUtc = (ms) => new Date(ms).toISOString().slice(0, 10);

// Same calendar day one year earlier (UTC) as 'YYYY-MM-DD' — the trailing
// window's exclusive lower bound, matching the dashboard's windowStart().
function oneYearBefore(ymd) {
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() - 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Lock the commission tier/rate on every deal that has settled (closed won AND
 * client-paid date recorded) and isn't locked yet — mutating its docData in
 * place with lockedTier/lockedRate. Once written the lock is never recomputed,
 * so historical commission stays fixed even as later deals move the window.
 *
 * The trailing-ARR basis matches the dashboard exactly: the sum of ARR across
 * all WON deals (paid or not) submitted within the 12 months ending on this
 * deal's submission date, excluding the deal itself.
 *
 * @param states   Per-deal effective post-pull state (built in the pull below).
 * @param docDatas Parallel array of the mirror docs being written this pull.
 */
function lockSettledRates(states, docDatas) {
  const won = states.filter((s) => s.status === 'won' && s.submittedMs != null);
  for (const s of states) {
    if (typeof s.lockedRate === 'number') continue; // already locked — never redo
    const settled = s.status === 'won' && !!s.paidAt && s.submittedMs != null;
    if (!settled) continue;
    const endYmd = ymdUtc(s.submittedMs);
    const startYmd = oneYearBefore(endYmd);
    const trailingArr = won.reduce((sum, o) => {
      if (o.id === s.id) return sum;
      const oYmd = ymdUtc(o.submittedMs);
      return oYmd > startYmd && oYmd <= endYmd ? sum + o.arr : sum;
    }, 0);
    const tier = tierFor(trailingArr);
    docDatas[s.i].lockedTier = tier.name;
    docDatas[s.i].lockedRate = rateForTrack(tier, s.track);
  }
}

/* ============================ REVERSE SYNC ============================ */
/* Pull Salesforce-side edits (status, amount, …) back onto the deal docs.
 * Triggered by the dashboard on load; throttled per user so a rapid refresh
 * doesn't hammer Salesforce. The forward sync is onCreate only, so writing
 * these updates never re-triggers it (no loop). */

const PULL_THROTTLE_MS = 5 * 60 * 1000; // once per 5 minutes per user
const FORCE_MIN_INTERVAL_MS = 60 * 1000; // hard floor even for forced refreshes
const DEAL_STATUSES = ['pending', 'accepted', 'won', 'lost'];
const SF_PULL_FIELDS = [
  'Id', SF_EXTERNAL_ID_FIELD, 'Status__c', 'Amount__c', 'Track__c', 'Stage__c',
  'CustomerCompanyName__c', 'CustomerWebsite__c',
  'CustomerContactFirstName__c', 'CustomerContactLastName__c',
  'CustomerContactTitle__c', 'CustomerContactEmail__c',
  'CustomerCountry__c', 'industry__c', 'CustomerCompanySize__c', 'CustomerOrgType__c',
  'CreatedDate', 'LastModifiedDate',
];

const stripProto = (u) => String(u || '').replace(/^https?:\/\//i, '').replace(/\/+$/, '');

// SF record -> a deal document (Salesforce is the source of truth). Used with
// set({merge:true}) so it CREATES the deal if missing and updates it otherwise,
// without clobbering portal-only fields it doesn't carry. `docId` is the
// resolved Firestore key — our external id when present, else the SF record Id
// (for deals created directly in Salesforce that don't carry a SourceSystemID).
function mapSObjectToDealDoc(r, uid, docId) {
  const doc = {
    id: docId || r[SF_EXTERNAL_ID_FIELD] || r.Id,
    ownerUid: uid,
    salesforceId: r.Id,
    salesforceLastModified: r.LastModifiedDate || null,
    salesforceSyncedFromAt: FieldValue.serverTimestamp(),
  };
  const status = String(r.Status__c || '').toLowerCase();
  if (DEAL_STATUSES.includes(status)) doc.status = status;
  if (r.Amount__c != null) doc.arr = Number(r.Amount__c);
  if (r.Track__c) doc.track = r.Track__c;
  if (r.Stage__c) doc.stage = r.Stage__c;
  if (r.CustomerCompanyName__c) doc.customer = r.CustomerCompanyName__c;
  if (r.CustomerWebsite__c) doc.domain = stripProto(r.CustomerWebsite__c);
  if (r.CustomerCountry__c) doc.hqCountry = r.CustomerCountry__c;
  if (r.industry__c) doc.industry = r.industry__c;
  if (r.CustomerCompanySize__c) doc.companySize = r.CustomerCompanySize__c;
  if (r.CustomerOrgType__c) doc.orgType = r.CustomerOrgType__c;

  const contact = {};
  if (r.CustomerContactFirstName__c) contact.firstName = r.CustomerContactFirstName__c;
  if (r.CustomerContactLastName__c) contact.lastName = r.CustomerContactLastName__c;
  if (r.CustomerContactFirstName__c || r.CustomerContactLastName__c) {
    contact.name = [r.CustomerContactFirstName__c, r.CustomerContactLastName__c].filter(Boolean).join(' ');
  }
  if (r.CustomerContactTitle__c) contact.title = r.CustomerContactTitle__c;
  if (r.CustomerContactEmail__c) contact.email = r.CustomerContactEmail__c;
  if (Object.keys(contact).length) doc.contact = contact;

  // submittedAt drives the dashboard's ordered query — seed it from SF CreatedDate
  // so deals created in Salesforce still show up after the mirror.
  if (r.CreatedDate) doc.submittedAt = Timestamp.fromDate(new Date(r.CreatedDate));
  return doc;
}

// Run a SOQL query and follow nextRecordsUrl until done — the REST endpoint
// caps a page at 2000 records, and dropping the tail would silently omit deals.
// Pass `auth` ({ access_token, instance_url }) to reuse a token across many
// queries in one request; omit it for a one-off query.
async function querySalesforceAll(soql, auth) {
  const { access_token, instance_url } = auth || (await getAccessToken());
  let url = `${instance_url}/services/data/${SF_API_VERSION}/query?q=${encodeURIComponent(soql)}`;
  const records = [];
  for (;;) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${access_token}` } });
    if (!res.ok) throw sfError(`Salesforce query failed: ${res.status} ${await res.text()}`, res.status);
    const data = await res.json();
    records.push(...(data.records || []));
    if (data.done || !data.nextRecordsUrl) break;
    url = `${instance_url}${data.nextRecordsUrl}`;
  }
  return records;
}

// Callable: mirror this partner's Salesforce deals into Firestore (Salesforce is
// the source of truth). Scoped by PartnerAccount__c = the partner's SF Account;
// upsert-creates deals that exist in Salesforce but not yet locally. Throttled to
// once per PULL_THROTTLE_MS per user — the dashboard calls it on load.
exports.refreshFromSalesforce = onCall(async (request) => {
  const uid = request.auth && request.auth.uid;
  if (!uid) throw new HttpsError('unauthenticated', 'Sign in required.');

  // An explicit "Refresh from Salesforce" click bypasses the auto-throttle; the
  // automatic on-load pull does not (force omitted). force is client-supplied,
  // so it only shortens the window — a server-side floor still applies (a
  // scripted force-loop must not be able to burn the SF API limits).
  const force = !!(request.data && request.data.force);

  // Throttle on the last SUCCESSFUL pull for this user.
  const metaRef = db.collection('syncMeta').doc(uid);
  const meta = await metaRef.get();
  const lastPull = meta.exists && meta.get('lastPullAt') ? meta.get('lastPullAt').toMillis() : 0;
  const since = Date.now() - lastPull;
  const minGap = force ? FORCE_MIN_INTERVAL_MS : PULL_THROTTLE_MS;
  if (since < minGap) {
    return { skipped: true, reason: 'throttled', nextInMs: minGap - since };
  }

  try {
    assertConfigured();
  } catch (e) {
    // Config state is an internal detail — don't enumerate missing env vars
    // to the client.
    logger.error(`refreshFromSalesforce: not configured — ${e.message}`);
    throw new HttpsError('failed-precondition', 'Salesforce sync is not configured.');
  }

  const accountId = await partnerAccountId(uid);
  if (!accountId) {
    await metaRef.set({ lastPullAt: FieldValue.serverTimestamp() }, { merge: true });
    return { updated: 0, count: 0, reason: 'no-account' };
  }

  let updated = 0;
  let removed = 0;
  try {
    // One OAuth token for the whole pull (main query + every deletion-confirm
    // chunk) — a fresh JWT grant per query would multiply token-endpoint traffic.
    const auth = await getAccessToken();
    // Mirror every deal linked to this partner's SF Account. Deals created
    // directly in Salesforce may not carry our external id (SourceSystemID) yet,
    // so we DON'T require it here — those key on the SF record Id below.
    const soql =
      `SELECT ${SF_PULL_FIELDS.join(', ')} FROM ${SF_OBJECT} ` +
      `WHERE PartnerAccount__c = '${soqlStr(accountId)}'`;
    const records = await querySalesforceAll(soql, auth);
    // Key each mirror doc by the SF record Id. The only exception is a legacy
    // 'DR-YYYY-NNNNNN' external id — those docs already live under that id, so
    // keep them there. Portal deals now carry an idempotency-token external id,
    // which must NOT become the doc key (that would duplicate the
    // record-Id-keyed doc registerDeal wrote).
    const entries = records
      .map((r) => ({ r, docId: isLegacyExtId(r[SF_EXTERNAL_ID_FIELD]) ? r[SF_EXTERNAL_ID_FIELD] : r.Id }))
      .filter((e) => e.docId);
    const refs = entries.map((e) => db.collection('deals').doc(e.docId));
    const existing = refs.length ? await db.getAll(...refs) : [];

    // Pass 1: build every mirror doc, and capture each deal's effective
    // post-pull state (status/arr/track/paid/submitted) for tier locking.
    const docDatas = [];
    const states = [];
    for (let i = 0; i < entries.length; i++) {
      const snap = existing[i];
      const isExisting = !!(snap && snap.exists);
      const docData = mapSObjectToDealDoc(entries[i].r, uid, entries[i].docId);
      if (isExisting) {
        // The mirror only refreshes Salesforce-owned fields on existing deals —
        // never reassigns ownership or the original submission time.
        delete docData.ownerUid;
        delete docData.submittedAt;
      }
      // Effective post-merge value of a field: the pull's value wins, else the
      // existing doc's. submittedAt is Salesforce-seeded only on first create;
      // paidAt is a portal-only field the pull never touches.
      const submittedAt = isExisting ? snap.get('submittedAt') : docData.submittedAt;
      states.push({
        i,
        id: entries[i].docId,
        status: docData.status != null ? docData.status : isExisting ? snap.get('status') : undefined,
        arr: Number(docData.arr != null ? docData.arr : isExisting ? snap.get('arr') : 0) || 0,
        track: docData.track != null ? docData.track : isExisting ? snap.get('track') : '',
        paidAt: isExisting ? snap.get('paidAt') : null,
        lockedRate: isExisting ? snap.get('lockedRate') : undefined,
        submittedMs:
          submittedAt && typeof submittedAt.toMillis === 'function' ? submittedAt.toMillis() : null,
      });
      docDatas.push(docData);
    }
    // Freeze the tier/rate on any newly-settled deal (won + client-paid).
    lockSettledRates(states, docDatas);

    // Commit in chunks (a Firestore batch holds at most 500 writes).
    let batch = db.batch();
    let inBatch = 0;
    for (let i = 0; i < docDatas.length; i++) {
      batch.set(refs[i], docDatas[i], { merge: true });
      if (++inBatch === 400) {
        await batch.commit();
        batch = db.batch();
        inBatch = 0;
      }
    }
    // Deletion propagation: Salesforce is the source of truth, so any deal this
    // partner owns that the account query no longer returns is treated as gone
    // and its local mirror removed — matched by doc id or salesforceId. No
    // re-confirmation query and no salesforceId requirement: whatever the
    // account query returns IS the mirror.
    const present = new Set();
    for (const e of entries) {
      present.add(e.docId);
      if (e.r.Id) present.add(e.r.Id);
    }
    const mine = await db.collection('deals').where('ownerUid', '==', uid).get();
    const toDelete = mine.docs.filter(
      (snap) => !present.has(snap.id) && !present.has(snap.get('salesforceId')),
    );
    for (const snap of toDelete) {
      batch.delete(snap.ref);
      removed++;
      if (++inBatch === 400) {
        await batch.commit();
        batch = db.batch();
        inBatch = 0;
      }
    }
    if (inBatch) await batch.commit();
    updated = entries.length;
  } catch (err) {
    // Salesforce error bodies can echo SOQL/schema details — keep them in the
    // logs, return a generic message to the browser.
    logger.error(`refreshFromSalesforce failed for ${uid}: ${err.message}`);
    throw new HttpsError('unavailable', 'Salesforce sync failed. Please try again later.');
  }

  await metaRef.set({ lastPullAt: FieldValue.serverTimestamp() }, { merge: true });
  logger.info(
    `refreshFromSalesforce: mirrored ${updated} deal(s), removed ${removed} for ${uid} (account ${accountId})`,
  );
  return { updated, count: updated, removed };
});

/* ===================== PARTNER PROVISIONING (SALESFORCE PULL) ===================== */
/* Provision a Partner Portal login for the primary contact of each partner Account.
 *
 * Trigger: an Account whose partner-type field (SF_PARTNER_TYPE_FIELD) is non-empty.
 *          The login goes to the contact named by the Account's primary-contact
 *          lookup (SF_PRIMARY_CONTACT_FIELD) — an explicit, single-valued
 *          designation. Chosen over "oldest contact wins": a lookup cannot pick two
 *          people, and nobody is mailed a set-password link by accident of contact
 *          creation order. An account marked partner with the lookup still empty is
 *          WARNED about every tick, never silently ignored — the partner just not
 *          getting in with nobody knowing why is the failure mode that wastes the
 *          most time.
 *
 * One login per Account is still the invariant (enforced below via
 * accountHolderUid): deal docs are single-owner and refreshFromSalesforce scopes
 * by account, so a second uid on the same account would see a permanently empty
 * dashboard.
 *
 * (This sync was Lead-driven until 2026-07-15: it keyed on converted Leads carrying
 * a partner-type field. The org never grew that Lead field — marking the Account is
 * where the team actually works — so the source of truth moved to the Account.)
 *
 * 2026-07-17: the DELIVERY changed from a scheduled pull to a Salesforce push
 * (sfProvisionPartner below) — the Integration-license API user cannot read
 * Account/Contact, so Apex now sends the account+contact payload with each
 * request and no SOQL against Account happens here at all. Every invariant
 * above is unchanged; the guards live in provisionOneAccount().
 */

// off < dryrun < live. The effective mode is the MINIMUM of the env var and the
// syncConfig/partnerSync doc, so either one alone can stop the sync but both must
// agree to let it write. Unknown env value => off.
const SYNC_MODES = ['off', 'dryrun', 'live'];
const SF_PARTNER_SYNC_MODE = process.env.SF_PARTNER_SYNC_MODE || 'off';
// The Account field whose non-empty value both MARKS a partner account and carries
// the partner's track. Env-configurable so an API-name change doesn't need a code change.
const SF_PARTNER_TYPE_FIELD = process.env.SF_PARTNER_TYPE_FIELD || 'PartnerType__c';
// The Account Lookup(Contact) naming the one contact who gets the portal login.
// Must be a custom lookup (…__c) — the __c→__r rewrite below derives the SOQL
// relationship name from it, which only holds for custom fields.
const SF_PRIMARY_CONTACT_FIELD = process.env.SF_PRIMARY_CONTACT_FIELD || 'Primary_Contact__c';
const SF_PRIMARY_CONTACT_REL = SF_PRIMARY_CONTACT_FIELD.replace(/__c$/, '__r');

// Read a field off a REST query record, tolerating API-name CASE drift.
// SOQL is case-insensitive, but the response keys carry the org's CANONICAL casing —
// and a bare record[name] is a case-sensitive JS read. Both custom fields above are
// created BY HAND in SF Setup, where a label of "Primary contact" auto-fills the API
// name `Primary_contact__c`; that one lowercase letter would make every read undefined
// while the query still succeeded, and the sync would report "lookup is empty" for
// accounts whose lookup is plainly set — sending the admin to fix the wrong thing.
function sfField(record, name) {
  if (record[name] !== undefined) return record[name];
  const lower = name.toLowerCase();
  const key = Object.keys(record).find((k) => k.toLowerCase() === lower);
  return key === undefined ? undefined : record[key];
}

const MAX_PARTNER_ACCOUNTS = 2000; // more than this => refuse the whole run (bulk edit?)
const MAX_CREATES_PER_RUN = 5; // caps new Auth accounts AND invite emails per tick
const MAX_PROVISIONS_PER_DAY = 20; // rolling 24h circuit breaker — trips the kill switch
const MAX_INVITE_ATTEMPTS = 5;
const PROVISION_DEADLINE_MS = 240 * 1000; // soft stop, 60s under timeoutSeconds, so the summary always logs
const SYNC_CONFIG_PATH = 'syncConfig/partnerSync';
const PROVISIONED_BY = 'partner-sync';

// Public Firebase Web API key (safe to commit) — only used to trigger Firebase's
// built-in set-password email. MIRRORS scripts/bootstrap.js — keep in sync.
// (scripts/ is never uploaded to Cloud Functions, so it cannot be require()d.)
const WEB_API_KEY = 'AIzaSyDEOfMuiM7-TIyYkb28fG0T9v-YThC_Bls';

// Shared mailboxes: anyone with inbox access could claim the set-password link and
// take over the partner's pipeline. Warned about, not blocked — see the note in the
// handler on why this sync warns instead of quarantining.
const ROLE_ADDRESS_LOCALPARTS = new Set([
  'info', 'sales', 'support', 'admin', 'billing', 'contact', 'hello', 'office',
  'team', 'accounts', 'noreply', 'no-reply', 'help', 'enquiries', 'partners',
]);
const isRoleAddress = (email) =>
  ROLE_ADDRESS_LOCALPARTS.has(String(email || '').split('@')[0].toLowerCase());

// MIRRORS scripts/bootstrap.js — keep in sync.
const genPw = () =>
  crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 11) + 'A9!';

// Ask Firebase to send its built-in "set your password" email (no SMTP needed).
// MIRRORS scripts/bootstrap.js — keep in sync.
// LOAD-BEARING: Firebase only delivers PASSWORD_RESET mail to an account that HAS a
// password. A passwordless account gets NO email and NO error — which is why
// createUser below always passes genPw().
async function sendPasswordSetupEmail(addr) {
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${WEB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: addr }),
  });
  if (!res.ok) throw new Error(`sendOobCode failed: ${res.status} ${await res.text()}`);
}

// A SOQL identifier (field API name). soqlStr() escapes string LITERALS and is the
// wrong tool for an identifier interpolated bare into the query — validate instead.
const looksLikeSfField = (v) => /^[A-Za-z][A-Za-z0-9_]{0,38}(__c)?$/.test(v || '');

// The uid already holding this SF Account, or null. Single-field equality => Firestore
// indexes it automatically, no firestore.indexes.json entry needed.
async function accountHolderUid(accountId) {
  const q = await db.collection('partners').where('salesforceAccountId', '==', accountId).limit(1).get();
  return q.empty ? null : q.docs[0].id;
}

// The runtime service account lacking Firebase Auth access, as thrown by ANY Admin Auth
// call (getUserByEmail included — it runs before createUser, so it is the one that
// actually surfaces a missing grant first).
const isAuthPermissionError = (e) =>
  (e && e.code === 'auth/insufficient-permission') ||
  /insufficient permission|PERMISSION_DENIED|caller does not have permission/i.test((e && e.message) || '');

// A profile this sync created, that never got its invite out, and still has attempts left.
const needsInviteRetry = (snap) =>
  snap.get('provisionedBy') === PROVISIONED_BY &&
  !snap.get('inviteSentAt') &&
  (snap.get('inviteAttempts') || 0) < MAX_INVITE_ATTEMPTS;

// ---- Gate: mode + circuit breaker. ----
// Shared preamble of every provisioning attempt. Returns { ok:true, mode, cfgRef,
// recent } to proceed, or { ok:false, reason: 'invalid-mode'|'config-unreadable'|
// 'off'|'daily-cap' }. A silent no-op is the worst outcome here, so off/dryrun
// announce themselves on every attempt rather than returning quietly.
async function loadProvisionGate() {
  // ---- Gate 1: mode. Both the env var and the config doc must say 'live'. ----
  if (!SYNC_MODES.includes(SF_PARTNER_SYNC_MODE)) {
    logger.error(
      `provisionPartner: SF_PARTNER_SYNC_MODE='${SF_PARTNER_SYNC_MODE}' is not one of ` +
        `${SYNC_MODES.join('|')} — treating as off`,
    );
    return { ok: false, reason: 'invalid-mode' };
  }
  const cfgRef = db.doc(SYNC_CONFIG_PATH);
  let cfgSnap;
  try {
    cfgSnap = await cfgRef.get();
  } catch (e) {
    logger.error(`provisionPartner: could not read ${SYNC_CONFIG_PATH} — ${e.message}`);
    return { ok: false, reason: 'config-unreadable' };
  }
  // An absent doc must not block a deliberate env=live; an explicit doc can only
  // ever narrow it.
  const cfgMode = cfgSnap.exists ? cfgSnap.get('mode') || 'live' : 'live';
  if (!SYNC_MODES.includes(cfgMode)) {
    logger.error(`provisionPartner: ${SYNC_CONFIG_PATH}.mode='${cfgMode}' is invalid — treating as off`);
    return { ok: false, reason: 'invalid-mode' };
  }
  const mode = SYNC_MODES[Math.min(SYNC_MODES.indexOf(SF_PARTNER_SYNC_MODE), SYNC_MODES.indexOf(cfgMode))];
  if (mode === 'off') {
    logger.warn(`provisionPartner: disabled (env=${SF_PARTNER_SYNC_MODE}, config=${cfgMode})`);
    return { ok: false, reason: 'off' };
  }
  if (mode === 'dryrun') logger.warn('provisionPartner: DRY RUN — no accounts, no emails, no writes');

  // ---- Gate 2: circuit breaker. A runaway must brick itself, not wait for a human. ----
  const dayAgo = Date.now() - 24 * 60 * 60 * 1000;
  const recent = (cfgSnap.exists && Array.isArray(cfgSnap.get('recent')) ? cfgSnap.get('recent') : []).filter(
    (t) => typeof t === 'number' && t >= dayAgo,
  );
  if (recent.length >= MAX_PROVISIONS_PER_DAY) {
    logger.error(
      `provisionPartner: ${recent.length} provisions in 24h >= cap ${MAX_PROVISIONS_PER_DAY} — ` +
        `HALTED. To resume, investigate first, then set ${SYNC_CONFIG_PATH}.mode back to 'live'.`,
    );
    // The window MUST be cleared here, not just the mode. Gate 1 (mode) is re-read on
    // every attempt, so leaving >= 20 timestamps in `recent` would re-trip this breaker
    // the moment an admin set mode back to 'live' — silently reverting their fix and
    // making the recovery instruction above a lie. The count that tripped it is
    // preserved as haltedCount for forensics.
    await cfgRef
      .set(
        {
          mode: 'off',
          recent: [],
          haltedReason: 'daily-cap',
          haltedCount: recent.length,
          haltedAt: FieldValue.serverTimestamp(),
        },
        { merge: true },
      )
      .catch((e) => logger.error(`could not write the halt flag: ${e.message}`));
    return { ok: false, reason: 'daily-cap' };
  }
  return { ok: true, mode, cfgRef, recent };
}

// ---- The guarded provisioning body for ONE partner Account. ----
// Extracted from the scheduled pull (deleted 2026-07-17 — the Integration-license
// API user cannot read Account/Contact, so Salesforce now PUSHES the account via
// sfProvisionPartner below). Every guard predates the extraction and is
// load-bearing; see the inline notes.
//
// `acct` keeps the exact shape the old Account SOQL returned ({ Id, Name,
// [SF_PARTNER_TYPE_FIELD], [SF_PRIMARY_CONTACT_FIELD], [SF_PRIMARY_CONTACT_REL]:
// { FirstName, LastName, Email } }) so the sfField reads below are unchanged.
// `ctx` = { mode, cfgRef, recent, claimedEmails, creates } from loadProvisionGate()
// (claimedEmails spans a multi-account run; creates counts invites this run).
// Returns an outcome string; throws only on unexpected errors (the caller
// classifies them with isAuthPermissionError).
async function provisionOneAccount(acct, ctx) {
  const { mode, cfgRef, recent, claimedEmails } = ctx;
  const accountId = acct.Id;
  const contactId = sfField(acct, SF_PRIMARY_CONTACT_FIELD);
  // Parent relationships come back NESTED and are null (not {}) when unset.
  const contact = sfField(acct, SF_PRIMARY_CONTACT_REL) || {};
  // The Contact is the live partner record, so its email is the login.
  const email = clip(contact.Email, 200);

  // ---- Shape guards: drop and log, never throw. ----
  if (!looksLikeSfId(accountId)) {
    // Load-bearing: this id becomes salesforceAccountId, which arms the
    // destructive deletion sweep in refreshFromSalesforce.
    logger.warn(`provisionPartner: account ${acct.Id} has a malformed id — skipped`);
    return 'skipped-malformed-id';
  }
  if (!contactId) {
    // Marked partner but nobody designated. Warned on every attempt on purpose.
    logger.warn(
      `provisionPartner: account ${accountId} (${clip(acct.Name, 80)}) is marked partner but ` +
        `${SF_PRIMARY_CONTACT_FIELD} is empty — nobody to provision; skipped`,
    );
    return 'skipped-no-contact';
  }
  if (!email || !isValidEmail(email)) {
    // The lookup being set says nothing about the contact's email.
    logger.warn(`provisionPartner: primary contact ${contactId} (account ${accountId}) has no usable email — skipped`);
    return 'skipped-bad-email';
  }
  // Warned, not blocked. A silent skip is the failure mode that wastes the most
  // time (the partner just never gets in and nobody knows why), and the dry-run
  // stage exists precisely so these are reviewed before any mail goes out.
  if (isPersonalEmail(email)) {
    logger.warn(`provisionPartner: ${email} (contact ${contactId}) is a personal-email domain`);
  }
  if (isRoleAddress(email)) {
    logger.warn(
      `provisionPartner: ${email} (contact ${contactId}) is a shared alias — anyone with ` +
        'inbox access could claim the set-password link',
    );
  }

  // ---- Never follow a Salesforce email edit. ----
  // Anyone with field-level write on Contact.Email could point it at an address
  // they control; following it would mint a second uid and mail a working
  // set-password link straight into their inbox.
  const byContact = await db.collection('partners').where('salesforceContactId', '==', contactId).limit(1).get();
  if (!byContact.empty) {
    const prev = byContact.docs[0];
    if (String(prev.get('email') || '').toLowerCase() !== email.toLowerCase()) {
      logger.error(
        `provisionPartner: contact ${contactId} email changed ` +
          `${prev.get('email')} -> ${email} — NOT updating auth (takeover risk); admin review required`,
      );
      if (mode === 'live' && !prev.get('emailMismatch')) {
        await prev.ref.set({ emailMismatch: true, emailMismatchAt: FieldValue.serverTimestamp() }, { merge: true });
      }
      return 'mismatch';
    }
  }

  let user = null;
  try {
    user = await fbAuth.getUserByEmail(email);
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
  }

  // ---- The sync-proof revocation. ----
  // Disabling the user in the Firebase console is how a partner is offboarded —
  // the one signal provisioning will never overwrite. (Deleting partners/{uid}
  // instead does lock them out, but lands in adopt-refusal below: no profile is
  // re-created, no invite re-sent, and it warns on every attempt until a human acts.)
  if (user && user.disabled) {
    logger.info(`provisionPartner: ${email} is disabled (revoked) — skipped`);
    return 'revoked';
  }

  const snap = user ? await partnerSnap(user.uid) : null;
  const hadDoc = !!(snap && snap.exists);

  // ---- Admins are untouchable. ----
  // Not merely "never write role": backfilling salesforceAccountId onto an admin
  // would arm the deletion sweep against the admin's uid AND hand the admin's uid
  // the account seat, so the real partner could never be linked.
  if (hadDoc && snap.get('role') === 'admin') {
    logger.warn(`provisionPartner: contact ${contactId} resolves to an admin (${email}) — skipped`);
    return 'skipped-admin';
  }

  // ---- One login per email, within this run. ----
  // The EMAIL — not the account id — is the colliding dimension: one Contact can be
  // the primary on two accounts, and two contacts can share an address. A single-
  // account push carries a fresh set, so this only bites multi-account runs, but a
  // dry run must still count the conflicts a live run would hit.
  if (claimedEmails.has(email.toLowerCase())) {
    logger.warn(
      `provisionPartner: ${email} was already claimed by an earlier account this run — ` +
        `account ${accountId} (contact ${contactId}) skipped`,
    );
    return 'conflict-email-claimed';
  }

  // ---- One uid per SF Account (cross-uid claim). ----
  const holderUid = await accountHolderUid(accountId);
  if (holderUid && (!user || holderUid !== user.uid)) {
    logger.warn(
      `provisionPartner: account ${accountId} already linked to ${holderUid} — ` +
        `contact ${contactId} skipped`,
    );
    return 'conflict-account-held';
  }

  // ---- Decide the intent, then gate on dry run. ----
  let intent;
  if (!user) intent = 'create';
  else if (!hadDoc) intent = 'adopt-refused'; // auth account exists, no profile — see below
  else if (!snap.get('salesforceAccountId')) intent = 'backfill';
  else if (snap.get('salesforceAccountId') !== accountId) {
    // NEVER overwrite a non-empty salesforceAccountId. refreshFromSalesforce
    // HARD-DELETES every deal owned by this uid that the account query doesn't
    // return, so repointing it wipes the partner's entire deal mirror on their
    // next dashboard load. Not to "correct" it, not ever.
    logger.warn(
      `provisionPartner: ${email} is bound to account ${snap.get('salesforceAccountId')} but ` +
        `contact ${contactId} maps to ${accountId} — skipped`,
    );
    return 'conflict-account-mismatch';
  } else intent = needsInviteRetry(snap) ? 'invite-retry' : 'noop';

  if (intent === 'noop') return 'noop'; // steady state: zero writes

  // ---- Only ever adopt an auth account this provisioning created. ----
  // An auth account with no profile is NOT a blank slate to claim. The question that
  // matters is "does this uid carry credentials an attacker controls?", and no
  // property of the account answers it:
  //  - emailVerified does not: the Email/Password provider is enabled, so anyone can
  //    self-register any address via Identity Toolkit accounts:signUp with the public
  //    web API key. Firebase's default one-account-per-email then AUTO-LINKS the real
  //    partner's later Google sign-in onto the squatter's existing uid and flips
  //    emailVerified to true — leaving the squatter's password in place.
  //  - a federated provider does not either: microsoftProvider() (web auth.service.ts)
  //    sets no `tenant`, so it accepts tokens from ANY Azure AD tenant, and a tenant
  //    admin can set a user's `mail` to anything with no domain proof. That mints an
  //    emailVerified=true account for an address the attacker never controlled.
  // Adopting either would hand out role:'partner' plus a real partner's
  // salesforceAccountId. So: refuse, and let a human decide.
  // The escape hatch already exists and is the SAME one used today —
  // `node scripts/bootstrap.js --email <addr> --role partner` writes partners/{uid},
  // which makes the next push see hadDoc=true and take the backfill path.
  if (intent === 'adopt-refused') {
    logger.warn(
      `provisionPartner: ${email} already has an auth account (uid ${user.uid}) that provisioning ` +
        'did not create — refusing to adopt it. If this is the real partner (they signed in with Google/' +
        'Microsoft first, or a provision crashed), run: node scripts/bootstrap.js --email ' +
        `${email} --role partner — then the next push for this account will link it. If it is NOT, ` +
        'delete the auth account.',
    );
    return 'adopt-refused';
  }

  // ---- Never bind a uid that already owns deals to an unproven account. ----
  // Binding salesforceAccountId arms refreshFromSalesforce's hard-delete sweep: it
  // deletes every deal with ownerUid==uid that `WHERE PartnerAccount__c = '<id>'`
  // does not return. We cannot prove from here that this partner's existing deals
  // belong to THIS account, and the odds are stacked against it — the push trigger
  // only sets PartnerAccount__c when the owner already had a salesforceAccountId, so
  // deals registered while unbound carry PartnerAccount__c=NULL in Salesforce and the
  // scoped query returns NOTHING for them. Binding would then delete ALL of them, not
  // some. A partner with no deals has nothing to lose, so backfill stays automatic
  // there — which is the case that matters, since a hand-bootstrapped partner cannot
  // register a deal until salesforceAccountId exists.
  if (intent === 'backfill') {
    const owned = await db.collection('deals').where('ownerUid', '==', user.uid).limit(1).get();
    if (!owned.empty) {
      logger.warn(
        `provisionPartner: ${email} (uid ${user.uid}) already owns deals but has no ` +
          `salesforceAccountId — refusing to auto-link it to ${accountId}. An admin must confirm the ` +
          "account is right and set it by hand; an automatic guess would delete this partner's deals.",
      );
      return 'orphan-deals';
    }
  }

  // The caps gate on the WORK (does this account mail an invite?), not on the intent
  // label — gating on `intent === 'create'` alone would leave 'invite-retry' free to
  // mail an unbounded number of set-password links per run, which is the exact
  // runaway both caps exist to contain. Kept deliberately identical to the invite
  // condition below; if one changes, the other must.
  const willInvite = !hadDoc || intent === 'invite-retry';
  // The 24h window is re-checked HERE, not only in loadProvisionGate():
  // chargeProvision() grows `recent` as a run goes, and a gate-only check would let
  // a run that started at 19/20 still provision a full MAX_CREATES_PER_RUN batch —
  // pushing the real ceiling to cap+4 while the log claims 20.
  if (willInvite && (ctx.creates >= MAX_CREATES_PER_RUN || recent.length >= MAX_PROVISIONS_PER_DAY)) {
    return 'deferred-budget';
  }
  if (mode !== 'live') {
    logger.info(`provisionPartner: [dryrun] would ${intent} ${email} (contact ${contactId}, account ${accountId})`);
    if (willInvite) ctx.creates++;
    claimedEmails.add(email.toLowerCase()); // so a dry run reports the conflicts a live run would
    return `dryrun-would-${intent}`;
  }

  const name = [contact.FirstName, contact.LastName].filter(Boolean).join(' ');
  const company = clip(acct.Name, 200);
  // The partner-type value doubles as the portal's commission track. rateForTrack
  // matches /solution/i and falls back to referral, so an unrecognised free-text
  // value degrades to the lower rate rather than throwing.
  const track = clip(sfField(acct, SF_PARTNER_TYPE_FIELD), 50);

  // Charge this provision to the 24h breaker. Called as early as the work becomes
  // real (right after createUser, before the profile write) so a crash mid-provision
  // still burns the budget — the breaker must bound ATTEMPTS, not just successes.
  let charged = false;
  const chargeProvision = async () => {
    if (charged) return;
    charged = true;
    ctx.creates++;
    // Rewrite the pruned window rather than arrayUnion-ing onto it: read-side
    // filtering alone would let this array grow without bound forever. Safe as a
    // read-modify-write only because every caller of this function serializes
    // (the endpoint below runs maxInstances:1 + concurrency:1).
    recent.push(Date.now());
    await cfgRef.set({ recent }, { merge: true });
  };

  if (!user) {
    try {
      user = await fbAuth.createUser({
        email,
        password: genPw(), // NOT optional — see sendPasswordSetupEmail
        displayName: name || undefined,
        emailVerified: true, // provisioned from a Salesforce contact — the address is trusted
      });
      await chargeProvision();
    } catch (e) {
      if (e.code === 'auth/email-already-exists') {
        // scripts/bootstrap.js (or a human in the console) created the account between
        // our getUserByEmail and here. Don't adopt it inline: `hadDoc` was resolved
        // against a user that didn't exist yet, so the create branch below would write
        // role:'partner' over whatever profile the other writer is mid-way through
        // making. Bail and let the next push see a settled world.
        logger.warn(`provisionPartner: ${email} was created concurrently — deferring to the next push`);
        return 'deferred-concurrent-create';
      }
      throw e; // classified by the caller
    }
  } else if (willInvite) {
    // A pre-existing Auth user still consumes the budget: the expensive, irreversible
    // part is the profile write + the email, not the createUser call.
    await chargeProvision();
  }
  claimedEmails.add(email.toLowerCase());
  const ref = db.collection('partners').doc(user.uid);

  if (!hadDoc) {
    // role is written ONLY here. bootstrap.js writes {role, name, email} with
    // merge:true; if this sync wrote role:'partner' unconditionally and an admin's
    // email also appeared on a partner contact, the next push would DEMOTE THAT
    // ADMIN and isAdmin() would lock them out of their own console — silently, and
    // again after every manual fix.
    await ref.set(
      {
        role: 'partner',
        name,
        email,
        salesforceAccountId: accountId,
        salesforceContactId: contactId,
        ...(company ? { company } : {}),
        ...(track ? { track } : {}),
        provisionedBy: PROVISIONED_BY,
        inviteAttempts: 1, // increment-before-send: a crash loop still burns attempts
        createdAt: FieldValue.serverTimestamp(),
      },
      { merge: true },
    );
  } else {
    // Strict whitelist. role/name/email/company/createdAt/provisionedBy are never
    // touched on update.
    const patch = { salesforceAccountId: accountId };
    if (!snap.get('salesforceContactId')) patch.salesforceContactId = contactId;
    if (intent === 'invite-retry') patch.inviteAttempts = (snap.get('inviteAttempts') || 0) + 1;
    await ref.set(patch, { merge: true });
  }

  // ---- Invite: best-effort, never fatal. ----
  // `!hadDoc` (rather than bootstrap.js's `created && selfService`) closes the crash
  // gap where createUser lands but the profile write dies: the next push would
  // otherwise see an existing user and provision them silently, un-notified forever.
  // A bootstrap-provisioned partner has hadDoc=true => no second email.
  if (!hadDoc || intent === 'invite-retry') {
    let sent = false;
    try {
      await sendPasswordSetupEmail(email);
      sent = true;
    } catch (e) {
      logger.warn(
        `provisionPartner: could not send the setup email to ${email} — ${e.message}; ` +
          'they can use "Forgot password?" on the login page',
      );
    }
    // The marker write is deliberately NOT inside the try above. Folded together,
    // a failure of this write would log "could not send" for mail that DID go out
    // (a false statement) AND leave inviteSentAt unset — so the next push takes
    // the invite-retry path and mails the partner a SECOND set-password link.
    if (sent) {
      try {
        await ref.set({ inviteSentAt: FieldValue.serverTimestamp() }, { merge: true });
        logger.info(`provisionPartner: provisioned ${email} (account ${accountId}) and sent a set-password email`);
      } catch (e) {
        logger.error(
          `provisionPartner: set-password email WAS sent to ${email} but recording inviteSentAt failed — ` +
            `${e.message}; a later push for this account would send a duplicate invite`,
        );
      }
    }
  }

  return intent === 'create' ? 'created' : intent === 'backfill' ? 'backfilled' : 'invite-retried';
}

/* ============= PARTNER PROVISIONING — PUSH FROM SALESFORCE ============== */
/* Called by an Apex callout when an Account is marked partner (PartnerType__c
 * and Primary_Contact__c both set). Auth: X-Portal-Secret header must equal
 * SF_PUSH_SECRET (server-to-server; no CORS needed). Payload:
 *   { accountId, accountName, partnerType,
 *     contact: { id, firstName, lastName, email } }
 * Responses: 200 {outcome} for every settled answer — including business
 * refusals like adopt-refused — so the Apex side LOGS them instead of blindly
 * retrying; 400 bad payload, 401 bad secret, 405 not POST, 429 breaker halted,
 * 500 unexpected (safe to retry: provisioning is idempotent per account). */
exports.sfProvisionPartner = onRequest(
  {
    // Same serialization contract the deleted scheduler carried: the `recent`
    // breaker window is a non-transactional read-modify-write on
    // syncConfig/partnerSync, safe only when at most one request runs at a time.
    // maxInstances caps INSTANCES; concurrency:1 is what serializes requests
    // within one — both are needed.
    maxInstances: 1,
    concurrency: 1,
    timeoutSeconds: 60,
  },
  async (req, res) => {
    if (req.method !== 'POST') {
      res.status(405).json({ error: 'method-not-allowed' });
      return;
    }

    // ---- Secret gate. An unset/short secret means the endpoint is disabled; ----
    // never reveal WHICH check failed.
    // Compared as fixed-length SHA-256 digests, NOT as raw buffers behind a
    // string-length check: timingSafeEqual throws RangeError on unequal BYTE
    // lengths, and JS string length is UTF-16 code units. Node decodes header
    // values as latin1, so one byte >= 0x80 is 1 char but 2 UTF-8 bytes — a
    // header that passed a `got.length === secret.length` check could still
    // throw, and that throw is outside the try below (500, and a length oracle).
    // Digests are always 32 bytes, so this can neither throw nor leak length.
    const secret = process.env.SF_PUSH_SECRET || '';
    const got = String(req.get('X-Portal-Secret') || '');
    const sha256 = (v) => crypto.createHash('sha256').update(v, 'utf8').digest();
    const authorized = secret.length >= 32 && crypto.timingSafeEqual(sha256(got), sha256(secret));
    if (!authorized) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }

    // ---- Payload shape. Email validity is re-checked by the shared body. ----
    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const contactIn = body.contact && typeof body.contact === 'object' ? body.contact : {};
    const accountId = String(body.accountId || '').trim();
    const contactId = String(contactIn.id || '').trim();
    const partnerType = String(body.partnerType || '').trim();
    if (!looksLikeSfId(accountId) || !looksLikeSfId(contactId) || !partnerType) {
      res.status(400).json({ error: 'bad-payload' });
      return;
    }

    const gate = await loadProvisionGate();
    if (!gate.ok) {
      if (gate.reason === 'daily-cap') {
        res.status(429).json({ outcome: 'halted-daily-cap' });
      } else if (gate.reason === 'config-unreadable') {
        res.status(500).json({ error: 'internal' });
      } else {
        // off / invalid-mode: a deliberate admin state, not a transient failure —
        // 200 so the Apex side records it instead of retrying.
        res.status(200).json({ outcome: 'off' });
      }
      return;
    }

    // Rebuild the record in the exact shape the old Account SOQL returned, so the
    // shared body's sfField reads work unchanged.
    const acct = {
      Id: accountId,
      Name: String(body.accountName || ''),
      [SF_PARTNER_TYPE_FIELD]: partnerType,
      [SF_PRIMARY_CONTACT_FIELD]: contactId,
      [SF_PRIMARY_CONTACT_REL]: {
        FirstName: contactIn.firstName != null ? String(contactIn.firstName) : undefined,
        LastName: contactIn.lastName != null ? String(contactIn.lastName) : undefined,
        Email: contactIn.email != null ? String(contactIn.email) : undefined,
      },
    };

    try {
      const outcome = await provisionOneAccount(acct, {
        mode: gate.mode,
        cfgRef: gate.cfgRef,
        recent: gate.recent,
        claimedEmails: new Set(),
        creates: 0,
      });
      logger.info(`sfProvisionPartner: ${outcome} — account ${accountId} (contact ${contactId}, mode=${gate.mode})`);
      res.status(200).json({ outcome });
    } catch (e) {
      if (isAuthPermissionError(e)) {
        // The most likely first-deploy failure: provisioning is the only code in the
        // project that calls the Admin Auth API, and this project's org policy strips
        // default service-account grants — roles/firebaseauth.admin is granted by
        // hand or not at all.
        logger.error(
          `sfProvisionPartner: DENIED by Firebase Auth — ${e.message}. The Cloud Functions runtime ` +
            'service account is missing roles/firebaseauth.admin; NO partner can be provisioned until ' +
            'that grant exists.',
        );
      } else {
        logger.error(`sfProvisionPartner: account ${accountId} failed — ${e.message}`);
      }
      // Details stay in the logs; the body is generic on purpose (same rule as
      // registerDeal: SF-visible errors must not echo internal state).
      res.status(500).json({ error: 'internal' });
    }
  },
);

