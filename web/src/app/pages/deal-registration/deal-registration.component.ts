import {
  Component,
  ElementRef,
  EventEmitter,
  Input,
  Output,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { PortalApiService } from '../../core/portal-api.service';
import { isValidEmail, isPersonalEmail } from '../../core/validators';
import { SubmissionLimiter } from '../../core/submission-limiter';
import { NavComponent } from '../../shared/nav.component';
import { FooterComponent } from '../../shared/footer.component';

const TOTAL = 5;
const LABELS = ['Customer', 'Contact', 'Purchase', 'Affirmations', 'Review'];

// Steps 1..MERGED render together in one scrollable panel; the stepper dots for
// them scroll-jump to a sub-section anchor instead of switching panels.
const MERGED = 3;
const STEP_ANCHORS: Record<number, string> = {
  1: 'sec-customer',
  2: 'sec-contact',
  3: 'sec-purchase',
};

// Required field names per wizard step (orgs are validated separately).
const REQUIRED: Record<number, string[]> = {
  1: ['legalEntity', 'domain'],
  2: ['contactFirstName', 'contactLastName', 'contactTitle', 'workEmail'],
  3: [],
  4: ['affirmSelfReferral', 'affirmEmployment', 'affirmPipeline', 'affirmConsent', 'affirmTruthful'],
  5: [],
};

const SUCCESS_PLANS = ['Standard', 'Premium'];
const BATCH_OPTIONS = ['20k records', '1M records', 'Unlimited'];

// One Salesforce org row (mirrors the datasyncpro.io plan-config "Your
// Salesforce orgs" section).
interface OrgRow {
  name: string;
  conn: number;
  exec: number;
  batch: string;
}

@Component({
  selector: 'app-deal-registration',
  standalone: true,
  imports: [FormsModule, RouterLink, NavComponent, FooterComponent],
  templateUrl: './deal-registration.component.html',
  host: { '[class.embed]': 'embed' },
})
export class DealRegistrationComponent {
  @Input() embed = false;
  @Output() submitted = new EventEmitter<string>();

  private api = inject(PortalApiService);
  private host = inject(ElementRef<HTMLElement>);

  // ---- Form model ----
  data: Record<string, string> = {
    legalEntity: '',
    domain: '',
    country: 'United States',
    industry: 'SaaS & Software',
    companySize: '1–50',
    orgType: 'Enterprise Edition',
    contactFirstName: '',
    contactLastName: '',
    contactTitle: '',
    workEmail: '',
    phone: '',
    successPlan: 'Standard',
    track: 'Solution',
  };
  affirms: Record<string, boolean> = {
    affirmSelfReferral: false,
    affirmEmployment: false,
    affirmPipeline: false,
    affirmConsent: false,
    affirmTruthful: false,
  };
  orgs: OrgRow[] = [this.newOrg()];

  readonly successPlans = SUCCESS_PLANS;
  readonly batchOptions = BATCH_OPTIONS;

  // ---- Wizard state ----
  readonly step = signal(1);
  // Steps 1-MERGED share one panel, so they're all reachable from the start.
  readonly maxReached = signal(MERGED);
  readonly invalid = signal<Set<string>>(new Set());
  readonly orgNameInvalid = signal<Set<number>>(new Set());
  readonly emailError = signal('');
  readonly submitting = signal(false);
  readonly showSuccess = signal(false);
  readonly banner = signal('');
  readonly dealId = signal('');

  // Stable idempotency key for the current submission. Generated on the first
  // submit attempt and reused across retries so an ambiguous failure (timeout,
  // dropped response) resubmitting doesn't create a duplicate Salesforce record.
  // Cleared on success so the next deal gets a fresh token.
  private submissionToken: string | null = null;

  readonly total = TOTAL;

  // ---- Derived display ----
  get fillWidth(): string {
    return ((this.step() - 1) / (TOTAL - 1)) * 100 + '%';
  }
  get statusText(): string {
    return 'Step ' + this.step() + ' of ' + TOTAL + ' · ' + LABELS[this.step() - 1];
  }

  isInvalid(name: string): 'true' | null {
    return this.invalid().has(name) ? 'true' : null;
  }
  isOrgInvalid(i: number): 'true' | null {
    return this.orgNameInvalid().has(i) ? 'true' : null;
  }

  // ---- Salesforce orgs ----
  private newOrg(): OrgRow {
    return { name: '', conn: 1, exec: 100, batch: '20k records' };
  }
  addOrg(): void {
    this.orgs = [...this.orgs, this.newOrg()];
  }
  removeOrg(i: number): void {
    if (this.orgs.length <= 1) return;
    this.orgs = this.orgs.filter((_, idx) => idx !== i);
    this.orgNameInvalid.set(new Set()); // indices shift — clear marks
  }
  // Executables are sold in blocks of 100: round any non-multiple up to the
  // next hundred (minimum one block; no upper cap).
  roundExec(i: number): void {
    const org = this.orgs[i];
    if (!org) return;
    const rounded = Math.ceil((Number(org.exec) || 0) / 100) * 100;
    org.exec = Math.max(100, rounded);
  }
  totalConn(): number {
    return this.orgs.reduce((s, o) => s + (Number(o.conn) || 0), 0);
  }
  totalExec(): number {
    return this.orgs.reduce((s, o) => s + (Number(o.exec) || 0), 0);
  }

  // ---- Review helpers ----
  rv(value: string): string {
    return value && String(value).trim() ? value : '—';
  }
  rvOrgs(): string {
    const names = this.orgs.map((o) => o.name.trim()).filter(Boolean);
    const head = names.length
      ? names.join(', ')
      : this.orgs.length + ' org' + (this.orgs.length === 1 ? '' : 's');
    return head + ' · ' + this.totalConn() + ' conn · ' + this.totalExec() + ' exec';
  }

  // ---- Validation ----
  private focusField(name: string): void {
    const el = (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>('[name="' + name + '"]');
    el?.focus();
  }
  private focusOrg(i: number): void {
    const el = (this.host.nativeElement as HTMLElement).querySelector<HTMLElement>('[data-org-name="' + i + '"]');
    el?.focus();
  }

  clearInvalid(e: Event): void {
    const t = e.target as HTMLElement | null;
    if (!t) return;
    const orgIdx = t.getAttribute('data-org-name');
    if (orgIdx != null) {
      if (this.orgNameInvalid().has(+orgIdx)) {
        const s = new Set(this.orgNameInvalid());
        s.delete(+orgIdx);
        this.orgNameInvalid.set(s);
      }
      return;
    }
    const name = t.getAttribute('name');
    if (!name) return;
    if (this.invalid().has(name)) {
      const s = new Set(this.invalid());
      s.delete(name);
      this.invalid.set(s);
    }
    if (name === 'workEmail') this.emailError.set('');
  }

  private validateStep(stepNum: number): boolean {
    const fields = REQUIRED[stepNum] || [];
    const inv = new Set(this.invalid());
    let ok = true;
    let firstBad: string | null = null;

    for (const name of fields) {
      const isAffirm = name.startsWith('affirm');
      const v = isAffirm ? this.affirms[name] : this.data[name];
      let bad = isAffirm ? !v : !String(v ?? '').trim();
      let msg = bad ? 'This field is required.' : '';

      if (!bad && name === 'workEmail') {
        const val = String(v).trim();
        if (!isValidEmail(val)) {
          bad = true;
          msg = 'Enter a valid email address.';
        } else if (isPersonalEmail(val)) {
          bad = true;
          msg = "Use your work email — personal addresses (Gmail, Yahoo…) aren't accepted.";
        }
      }

      if (name === 'workEmail') this.emailError.set(msg);

      if (bad) {
        ok = false;
        inv.add(name);
        if (!firstBad) firstBad = name;
      } else {
        inv.delete(name);
      }
    }
    this.invalid.set(inv);

    // Purchase step: every Salesforce org needs a name.
    let firstBadOrg = -1;
    if (stepNum === 3) {
      const badOrgs = new Set<number>();
      this.orgs.forEach((o, i) => {
        if (!o.name.trim()) badOrgs.add(i);
      });
      this.orgNameInvalid.set(badOrgs);
      if (badOrgs.size) {
        ok = false;
        firstBadOrg = Math.min(...badOrgs);
      }
    }

    if (firstBad) this.focusField(firstBad);
    else if (firstBadOrg >= 0) this.focusOrg(firstBadOrg);
    return ok;
  }

  // ---- Wizard navigation ----
  private show(stepNum: number): void {
    this.step.set(stepNum);
    this.maxReached.set(Math.max(this.maxReached(), stepNum));
    this.scrollToStep(stepNum);
  }
  // Steps 1-MERGED scroll to their sub-section anchor (same panel); later steps
  // just bring the form into view.
  private scrollToStep(stepNum: number): void {
    const host = this.host.nativeElement as HTMLElement;
    const anchor = STEP_ANCHORS[stepNum];
    const el = anchor ? host.querySelector('#' + anchor) : host.querySelector('.dr-form');
    try {
      el?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      /* ignore */
    }
  }
  // Validate every merged sub-step (1-MERGED); surface the first that fails.
  private validateMerged(): boolean {
    for (let s = 1; s <= MERGED; s++) {
      if (!this.validateStep(s)) {
        this.step.set(s); // validateStep already focused the bad field
        return false;
      }
    }
    return true;
  }
  goNext(): void {
    const s = this.step();
    if (s >= TOTAL) return;
    // Steps 1-3 share one screen — validate them all together and jump straight
    // to step 4 (no stepping 1→2→3 within the merged panel).
    if (s <= MERGED) {
      if (this.validateMerged()) this.show(MERGED + 1);
      return;
    }
    if (this.validateStep(s)) this.show(s + 1);
  }

  // Whether the current leg's required fields are filled — drives the Next
  // button's disabled (greyed) state. Steps 1-3 are one screen, so their
  // requirements (Customer + Contact fields + every org named) are checked
  // together; step 4 requires all affirmations checked.
  canAdvance(): boolean {
    const s = this.step();
    if (s <= MERGED) {
      const required = [...REQUIRED[1], ...REQUIRED[2]];
      if (required.some((name) => !String(this.data[name] ?? '').trim())) return false;
      if (this.orgs.some((o) => !o.name.trim())) return false;
      return true;
    }
    if (s === 4) {
      return REQUIRED[4].every((name) => this.affirms[name]);
    }
    return true;
  }
  goBack(): void {
    if (this.step() > 1) this.show(this.step() - 1);
  }
  gotoStep(target: number): void {
    const current = this.step();
    // Free movement within the merged group, or stepping back anywhere.
    if ((target <= MERGED && current <= MERGED) || target < current) {
      this.show(target);
      return;
    }
    if (target > this.maxReached()) return;
    // Crossing forward out of the merged group → validate all merged sub-steps.
    if (current <= MERGED && !this.validateMerged()) return;
    // Then validate any full steps between the merged group and the target.
    for (let s = MERGED + 1; s < target; s++) {
      if (!this.validateStep(s)) {
        this.show(s);
        return;
      }
    }
    this.show(target);
  }

  // ---- Submit ----
  private buildPayload(): Record<string, unknown> {
    this.orgs.forEach((_, i) => this.roundExec(i)); // bill executables per 100 — snap up
    const payload: Record<string, unknown> = {
      legalEntity: this.data['legalEntity'],
      domain: this.data['domain'],
      country: this.data['country'],
      industry: this.data['industry'],
      companySize: this.data['companySize'],
      orgType: this.data['orgType'],
      contactFirstName: this.data['contactFirstName'],
      contactLastName: this.data['contactLastName'],
      contactTitle: this.data['contactTitle'],
      workEmail: this.data['workEmail'],
      phone: this.data['phone'],
      successPlan: this.data['successPlan'],
      track: this.data['track'],
      orgs: this.orgs.map((o) => ({
        name: o.name,
        connections: Number(o.conn) || 0,
        executables: Number(o.exec) || 0,
        batch: o.batch,
      })),
    };
    ['affirmSelfReferral', 'affirmEmployment', 'affirmPipeline', 'affirmConsent', 'affirmTruthful'].forEach(
      (k) => {
        payload[k] = this.affirms[k] ? ['confirmed'] : [];
      },
    );
    return payload;
  }

  submit(): void {
    if (this.submitting()) return; // re-entrancy guard (two clicks in one frame)

    if (SubmissionLimiter.isBlocked()) {
      this.banner.set(
        'Submission limit reached. You’ve already sent ' +
          SubmissionLimiter.MAX +
          ' deals from this browser today — try again ' +
          SubmissionLimiter.resetLabel() +
          '.',
      );
      return;
    }

    // Work-email guard (the email lives on step 2).
    const v = String(this.data['workEmail'] || '').trim();
    if (v && !isValidEmail(v)) {
      this.emailError.set('Please enter a valid email address.');
      this.show(2);
      this.focusField('workEmail');
      return;
    }
    if (v && isPersonalEmail(v)) {
      this.emailError.set(
        "Please use your work email — personal addresses (Gmail, Yahoo, Outlook, etc.) aren't accepted.",
      );
      this.show(2);
      this.focusField('workEmail');
      return;
    }

    for (let s = 1; s <= TOTAL; s++) {
      if (!this.validateStep(s)) {
        this.show(s);
        return;
      }
    }

    const payload = this.buildPayload();
    // Reuse the token if this is a retry after a failed attempt; mint one otherwise.
    if (!this.submissionToken) this.submissionToken = this.newSubmissionToken();
    this.submitting.set(true);
    this.banner.set('');
    this.api
      .submitDeal(payload, this.submissionToken)
      .then((res) => {
        SubmissionLimiter.record();
        this.submissionToken = null; // consumed — next deal gets a fresh token
        this.dealId.set(res.id);
        this.showSuccess.set(true);
        this.submitting.set(false);
        if (this.embed) this.submitted.emit(res.id);
      })
      .catch((err: Error) => {
        // Keep submissionToken so a retry converges on the same SF record.
        this.banner.set(err?.message || 'Submission failed. Please try again.');
        this.submitting.set(false);
      });
  }

  private newSubmissionToken(): string {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
    return 'tok-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
  }
}
