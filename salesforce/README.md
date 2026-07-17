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
