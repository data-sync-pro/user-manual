/*
 * Credential smoke test for the Partner Portal provisioning endpoint.
 *
 *   sf apex run -o partner --file scripts/apex/provisionSmokeTest.apex
 *
 * Contains no secret: X-Portal-Secret is the {!$Credential.Password} merge field, resolved by the
 * Named Credential at send time. Safe to re-run: the endpoint is in SF_PARTNER_SYNC_MODE=dryrun and
 * writes nothing, and the fake Ids below belong to no real record.
 *
 * How to read the result:
 *   200 + {"outcome":"dryrun-would-create"}  -> everything works end to end. Done.
 *   200 + {"outcome":"off"}                  -> sync is administratively disabled, or the daily
 *                                               circuit breaker tripped (Firestore syncConfig/partnerSync).
 *   401 + {"error":"unauthorized"}           -> the Password on the Named Credential is still the
 *                                               deploy placeholder, or drifted from SF_PUSH_SECRET
 *                                               in functions/.env, or "Allow Merge Fields in HTTP
 *                                               Header" is off (the merge field went out literally).
 *   404 from Google                          -> the Named Credential endpoint has a path on it. It
 *                                               must be the bare host; Apex supplies /sfProvisionPartner.
 */
HttpRequest req = new HttpRequest();
req.setEndpoint('callout:Partner_Portal_Provisioning/sfProvisionPartner');
req.setMethod('POST');
// Mandatory: without it firebase-functions does not JSON-parse the body and every field reads
// undefined, producing a 400 bad-payload that looks like an Apex bug.
req.setHeader('Content-Type', 'application/json');
req.setHeader('X-Portal-Secret', '{!$Credential.Password}');
req.setTimeout(120000);
req.setBody(JSON.serialize(new Map<String, Object>{
    'accountId'   => '001000000000000AAA',
    'accountName' => 'Credential Smoke Test',
    'partnerType' => 'Referral',
    'contact'     => new Map<String, Object>{
        'id'        => '003000000000000AAA',
        'firstName' => 'Cred',
        'lastName'  => 'Test',
        'email'     => 'credtest@example.invalid'
    }
}));

HttpResponse res = new Http().send(req);
System.debug(LoggingLevel.ERROR, 'STATUS: ' + res.getStatusCode());
System.debug(LoggingLevel.ERROR, 'BODY:   ' + res.getBody());
