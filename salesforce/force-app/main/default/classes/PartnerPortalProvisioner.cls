global with sharing class PartnerPortalProvisioner
        implements pushtopics.ActionResultProcessor, Queueable, Database.AllowsCallouts {

    private Set<Id> accountIds;

    global PartnerPortalProvisioner() {}

    private PartnerPortalProvisioner(Set<Id> accountIds) {
        this.accountIds = accountIds;
    }

    global void process(List<pushtopics.ActionResult> actionResults) {
        Integer received = actionResults == null ? 0 : actionResults.size();
        System.debug(LoggingLevel.INFO,
            'PartnerPortalProvisioner.process: received ' + received + ' action result(s)');

        Set<Id> ids = new Set<Id>();
        if (actionResults != null) {
            for (pushtopics.ActionResult r : actionResults) {
                if (r.success != true || r.skipped == true || r.targetId == null) {
                    System.debug(LoggingLevel.WARN,
                        'PartnerPortalProvisioner.process: dropped result (success=' + r.success
                        + ', skipped=' + r.skipped + ', targetId=' + r.targetId + ')');
                    continue;
                }
                String targetId = String.valueOf(r.targetId);
                if (targetId.length() >= 15 && targetId.startsWith('001')) {
                    ids.add((Id) targetId);
                } else {
                    System.debug(LoggingLevel.WARN,
                        'PartnerPortalProvisioner.process: dropped targetId ' + targetId
                        + ' (not an Account id)');
                }
            }
        }

        System.debug(LoggingLevel.INFO,
            'PartnerPortalProvisioner.process: ' + ids.size() + ' account(s) qualify: ' + ids);
        enqueue(ids);
    }

    public static void enqueue(Set<Id> accountIds) {
        if (accountIds == null || accountIds.isEmpty()) {
            System.debug(LoggingLevel.INFO, 'PartnerPortalProvisioner.enqueue: nothing to push');
            return;
        }
        if (Limits.getQueueableJobs() >= Limits.getLimitQueueableJobs()) {
            System.debug(LoggingLevel.ERROR,
                'PartnerPortalProvisioner.enqueue: out of queueable jobs, NOT pushing ' + accountIds);
            return;
        }
        Id jobId = System.enqueueJob(new PartnerPortalProvisioner(accountIds));
        System.debug(LoggingLevel.INFO,
            'PartnerPortalProvisioner.enqueue: job ' + jobId + ' queued for ' + accountIds);
    }

    public void execute(QueueableContext ctx) {
        System.debug(LoggingLevel.INFO,
            'PartnerPortalProvisioner.execute: pushing ' + accountIds.size() + ' account(s)');

        Set<Id> pushed = new Set<Id>();
        for (Account a : [
            SELECT Id, Name, PartnerType__c, Primary_Contact__c,
                   Primary_Contact__r.FirstName, Primary_Contact__r.LastName,
                   Primary_Contact__r.Email
            FROM Account
            WHERE Id IN :accountIds
              AND PartnerType__c != null
              AND Primary_Contact__c != null
        ]) {
            pushed.add(a.Id);

            String payload = JSON.serialize(new Map<String, Object>{
                'accountId'   => String.valueOf(a.Id),
                'accountName' => a.Name,
                'partnerType' => a.PartnerType__c,
                'contact'     => new Map<String, Object>{
                    'id'        => String.valueOf(a.Primary_Contact__c),
                    'firstName' => a.Primary_Contact__r.FirstName,
                    'lastName'  => a.Primary_Contact__r.LastName,
                    'email'     => a.Primary_Contact__r.Email
                }
            });
            System.debug(LoggingLevel.FINE,
                'PartnerPortalProvisioner.execute: ' + a.Id + ' payload ' + payload);

            HttpRequest req = new HttpRequest();
            req.setEndpoint('callout:Partner_Portal_Provisioning/sfProvisionPartner');
            req.setMethod('POST');
            req.setHeader('Content-Type', 'application/json');
            req.setHeader('X-Portal-Secret', '{!$Credential.Password}');
            req.setTimeout(120000);
            req.setBody(payload);

            HttpResponse res = new Http().send(req);
            System.debug(res.getStatusCode() == 200 ? LoggingLevel.INFO : LoggingLevel.ERROR,
                'PartnerPortalProvisioner.execute: ' + a.Id + ' -> '
                + res.getStatusCode() + ' ' + res.getBody());
        }

        for (Id requested : accountIds) {
            if (!pushed.contains(requested)) {
                System.debug(LoggingLevel.WARN,
                    'PartnerPortalProvisioner.execute: ' + requested
                    + ' skipped (missing PartnerType__c or Primary_Contact__c, or not visible)');
            }
        }
    }
}
