# Partner Portal — Salesforce schema

SFDX source for the Salesforce metadata the Partner Portal integration
(`functions/index.js`) depends on. Generated from the code's field usage so a
sandbox switch is a one-command deploy instead of hand-rebuilding in Setup.

## What's here

- **`DealRegistration__c`** — the object deals are upserted into.
  External Id / upsert key: **`PartnerPortalDealID__c`** (`SF_EXTERNAL_ID_FIELD`).
- **Account** custom fields — `PartnerType__c` (marks a partner + carries the
  track) and `Primary_Contact__c` (Lookup(Contact): who gets the portal login).
- **`Partner_Portal_Integration`** permission set — `DealRegistration__c` object +
  field access. **Compatible with the Salesforce Integration license.** Assign to the
  JWT integration user after deploy. This is all the deal push/pull path needs.
- **`Partner_Portal_Partner_Sync`** permission set — Account/Contact READ for the
  partner-provisioning query (`syncPartnersFromSalesforce`). **Standard CRM objects
  are NOT allowed on a Salesforce Integration license** — assigning it to an
  Integration-license user fails with `The user license doesn't allow the permission:
  Read Account`. Assign only to a **Salesforce Platform or full Salesforce** license
  user. If partner provisioning runs under the same JWT user, that user must hold a
  Platform/full license (Integration license → deal sync only).

## Deploy to a sandbox (admin required — the API-only integration user cannot deploy metadata)

```sh
# 1. Log the admin into the target sandbox (opens a browser)
sf org login web --alias partner --instance-url https://test.salesforce.com

# 2. Deploy the schema
sf project deploy start --source-dir force-app --target-org partner

# 3. Grant the integration user DealRegistration access (deal sync)
sf org assign permset --name Partner_Portal_Integration \
  --on-behalf-of "integration@datasyncpro.io.partner" --target-org partner

# 4. (Only if partner provisioning is needed AND the user has a Platform/full license)
sf org assign permset --name Partner_Portal_Partner_Sync \
  --on-behalf-of "<platform-or-full-license-user>" --target-org partner
```

## Field-type choices (inferred from code — flip before deploy if wrong)

| Field | Chosen type | Why / alternative |
| --- | --- | --- |
| `Amount__c` | Currency(16,2) | ARR is money; use Number(16,2) if the org has no currency |
| `CustomerContactEmail__c` | Email | code clips to 80 = Email field length; use Text(80) to avoid upsert failures on malformed input |
| `PartnerType__c` / `Track__c` | Picklist(Solution, Referral) | values feed the commission track; use Text if partner types are free-form |

Picklist values are load-bearing (a value the code sends that isn't in the
picklist fails the upsert permanently):
- `Track__c`: `Solution`, `Referral`
- `Status__c`: `pending`, `accepted`, `won`, `lost`

---

## Outbound partner provisioning (`PartnerPortalProvisioner`)

One Apex class. It is wired in as a **Data Sync Pro Action Result Processor** — put the class name
on the Executable's configuration and DSP calls it after each Action:

```apex
global with sharing class PartnerPortalProvisioner
        implements pushtopics.ActionResultProcessor, Queueable, Database.AllowsCallouts
```

`process()` keeps the rows where `success == true` and `skipped != true`, takes `targetId`, filters
to Account Ids (`001` prefix), and enqueues the push as a Queueable — `process()` runs inside the
Action's transaction, which holds uncommitted DML, and Apex refuses a callout there. It can also be
driven directly: `PartnerPortalProvisioner.enqueue(accountIds);`

The Account query drops anything with no `PartnerType__c` or no `Primary_Contact__c` — a blank
`partnerType` is a 400 server-side, and without a primary contact there is no address to provision.
Skipped silently.

`pushtopics.ActionResult` members (probed from the installed package; the manual page does not list
them): `action`, `errors`, `requestData`, `skipped`, `sourceId`, `success`, `targetId` — and
`targetId` is declared `Object`, not `Id`, hence the `String.valueOf` + prefix check.

### The credential — one password field, nothing else

`Partner_Portal_Provisioning` is a **legacy (Password-protocol) Named Credential**, chosen over the
newer External Credential stack on purpose: no principal, no permission set, no per-user access
grant — any Apex in the org can use it, and the secret is the plain **Password** field on the Named
Credential's own Setup page. (The External Credential version also hit a platform bug: a
metadata-deployed principal has no credential container, and the Setup UI's Edit can only PATCH —
"Use the POST method to create them" — so the secret could not be typed in at all without a
Connect-API call.)

```
Named Credential  Partner_Portal_Provisioning   (legacy, protocol=Password)
  ├─ URL:      https://us-central1-partnerportal-b1d25.cloudfunctions.net   (bare host, no path)
  ├─ Username: portal          (arbitrary, unused by the endpoint)
  ├─ Password: <SF_PUSH_SECRET>   ← the one thing typed by hand in Setup
  ├─ Generate Authorization Header: OFF   (no Basic-auth header; the secret must not leak there)
  └─ Allow Merge Fields in HTTP Header: ON
```

Apex sends the secret itself, via a merge field the platform substitutes at send time — the value
never appears in code, metadata, or debug logs:

```apex
req.setEndpoint('callout:Partner_Portal_Provisioning/sfProvisionPartner');
req.setHeader('X-Portal-Secret', '{!$Credential.Password}');
```

**The committed metadata carries a placeholder password** (`REPLACE_IN_SETUP_WITH_SF_PUSH_SECRET`) —
the Password protocol refuses to deploy without one. Consequence: **every deploy of the
namedCredentials folder resets the org's password back to the placeholder** and every push 401s
until an admin re-enters the real value. Same after every sandbox refresh.

### Reading the debug log

The class logs `<accountId> -> <status> <body>` and keeps no state. **Branch on the body, not the
status code** if you ever build on this: `off` — provisioning administratively disabled, or the
endpoint's 24-hour circuit breaker tripped — arrives as a perfectly healthy HTTP 200. Treating
`200` as success records a dead integration as working, indefinitely.

Settled outcomes (nothing more to do): `created`, `backfilled`, `invite-retried`, `noop`, and the
three `dryrun-would-*` twins. Everything else needs a human:

| What you see | What it means |
| --- | --- |
| `401` | The Named Credential Password is still the deploy placeholder, or drifted from `SF_PUSH_SECRET` in `functions/.env`, or **Allow Merge Fields in HTTP Header** is off (the merge field went out literally). |
| `400` | Malformed payload — usually a 15-character Id or a blank `partnerType`. |
| `404` (Google-styled) | The Named Credential URL has a path on it; it must be the bare host. |
| `outcome = off` / `halted-daily-cap` | Server-side halt. Fix Firestore `syncConfig/partnerSync`; retrying changes nothing. |
| `outcome = adopt-refused` | An Auth account exists that provisioning did not create. Only `scripts/bootstrap.js` resolves it. |

The Queueable has no try/catch around the send: a `CalloutException` fails the job visibly in
Setup → Apex Jobs (`AsyncApexJob.ExtendedStatus`) instead of vanishing into a log nobody reads.
There is no retry — re-run the push manually after fixing the cause.

### Deploy

```sh
cd salesforce
sf project deploy start -o partner --source-dir force-app
```

`-o partner` on every command: this repo has no default target org. No permission set is needed for
the push. There is no test class; a sandbox deploy defaults to `NoTestRun`, but a production deploy
needs 75% coverage on `PartnerPortalProvisioner` — write one alongside the DSP wiring before
promoting.

### POST-DEPLOY MANUAL STEP — the deploy is NOT complete without it

1. Setup → **Named Credentials** → **Partner Portal Provisioning** → **Edit**.
2. **Password** ← the value of `SF_PUSH_SECRET` in `functions/.env`. Save.
3. Verify: `sf apex run -o partner --file scripts/apex/provisionSmokeTest.apex`
   — expect `200` + `{"outcome":"dryrun-would-create"}`. With the placeholder still in place it
   returns `401` + `{"error":"unauthorized"}`, which also proves the wiring end to end.

Redo this **after every deploy that touches the namedCredentials folder and after every sandbox
refresh** — both reset the password to the placeholder.

### Going live (still dryrun today)

The endpoint runs with `SF_PARTNER_SYNC_MODE=dryrun`, so every success today is
`dryrun-would-create` and **nobody is actually provisioned**. The Apex looks perfectly healthy the
whole time. To flip:

1. `functions/.env` → `SF_PARTNER_SYNC_MODE=live`, then **redeploy**
   (`firebase deploy --only functions:sfProvisionPartner`) — `.env` is bundled at deploy time, so
   editing it alone changes nothing.
2. Confirm Firestore `syncConfig/partnerSync` does not veto: absent, or `mode: 'live'` with
   `haltedReason`/`haltedCount`/`haltedAt` cleared. The effective mode is the *lower* of the two.
3. Confirm the Cloud Functions runtime service account holds `roles/firebaseauth.admin` — this
   project's org policy strips default grants, and without it the first live call returns 500.

### Things your trigger has to decide

The class pushes what the Account says; it does not decide policy. Left to the caller:

- **When to fire.** Which DSP Executable carries this processor, and what its Action does.
- **Stamping the Account.** `PartnerType__c` and `Primary_Contact__c` must already be set when
  `process()` runs, or the Account is silently skipped by the query. Whatever writes them has to
  happen in the same Action, or an earlier one.
- **Mapping `Lead.PartnerType__c` (free Text) onto `Account.PartnerType__c` (restricted picklist
  `Solution`/`Referral`).** The portal's own `rateForTrack()` matches `/solution/i` and otherwise
  falls back to referral, so an unmapped value silently becomes the lower-paying track.
- **Never repointing an existing `Primary_Contact__c`.** That field IS the portal login identity;
  overwriting it hands one partner's Firebase account and deal mirror to a different person.
- **Retries and error handling.** The push is fire-and-forget and returns nothing; every outcome,
  good or bad, exists only in the debug log. Nothing retries a failed push.
- **Whether `targetId` is really the Account.** It holds whatever record the Action produced. The
  `001` prefix check means a non-Account Id is skipped rather than pushed, so a mis-wired Executable
  fails silently instead of loudly — check the log if nothing arrives.
