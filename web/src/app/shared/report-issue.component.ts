import { Component, HostListener, inject, signal } from '@angular/core';
import { PortalApiService } from '../core/portal-api.service';

// "Report an issue" entry point + modal. Drop <app-report-issue> anywhere
// (e.g. the footer): it renders a link-styled trigger and owns its own modal.
// On submit it writes a reports/{ER-2026-NNNN} doc, auto-tagging the reporter,
// the page they were on, and their user agent.
@Component({
  selector: 'app-report-issue',
  standalone: true,
  template: `
    <button type="button" class="rep-trigger" (click)="openModal()">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M8 1.5l6.5 11.5H1.5L8 1.5z" stroke="currentColor" stroke-width="1.3"
          stroke-linejoin="round" />
        <path d="M8 6.4v3.1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
        <circle cx="8" cy="11.3" r=".75" fill="currentColor" />
      </svg>
      Report an issue
    </button>

    @if (open()) {
      <div class="reg-modal">
        <div class="reg-modal-backdrop" (click)="close()"></div>
        <div class="reg-modal-dialog rep-dialog" role="dialog" aria-modal="true"
          aria-label="Report an issue">
          <button type="button" class="reg-modal-close" (click)="close()" aria-label="Close">&times;</button>

          @if (done()) {
            <div class="rep-done">
              <div class="rep-done-mark" aria-hidden="true">✓</div>
              <h2 class="rep-title">Thanks — your report was sent</h2>
              <p class="rep-sub">Reference <strong>{{ refId() }}</strong>. We'll look into it.</p>
              <button type="button" class="rep-btn rep-btn-primary" (click)="close()">Close</button>
            </div>
          } @else {
            <form class="rep-form" (submit)="submit($event)">
              <h2 class="rep-title">Report an issue</h2>
              <p class="rep-sub">Found wrong data or something not working? Tell us what happened.</p>

              <label class="rep-field">
                <span class="rep-label">What kind of issue?</span>
                <select class="rep-input" [value]="category()"
                  (change)="category.set($any($event.target).value)">
                  @for (c of categories; track c) {
                    <option [value]="c">{{ c }}</option>
                  }
                </select>
              </label>

              <label class="rep-field">
                <span class="rep-label">Describe the problem</span>
                <textarea class="rep-input rep-textarea" rows="5"
                  placeholder="What you expected vs. what happened, and where you saw it…"
                  [value]="message()"
                  (input)="message.set($any($event.target).value)"></textarea>
              </label>

              <p class="rep-context">Page: <span>{{ page || '—' }}</span></p>

              @if (error()) {
                <p class="rep-error" role="alert">{{ error() }}</p>
              }

              <div class="rep-actions">
                <button type="button" class="rep-btn" (click)="close()">Cancel</button>
                <button type="submit" class="rep-btn rep-btn-primary"
                  [disabled]="submitting() || !message().trim()">
                  {{ submitting() ? 'Sending…' : 'Send report' }}
                </button>
              </div>
            </form>
          }
        </div>
      </div>
    }
  `,
})
export class ReportIssueComponent {
  private api = inject(PortalApiService);

  readonly categories = ['Wrong data', 'Page not working', 'Display / UI issue', 'Other'];

  readonly open = signal(false);
  readonly submitting = signal(false);
  readonly done = signal(false);
  readonly error = signal('');
  readonly refId = signal('');
  readonly category = signal(this.categories[0]);
  readonly message = signal('');
  page = '';

  openModal(): void {
    // Capture where the user was when they hit "report".
    this.page = typeof window !== 'undefined' ? window.location.pathname + window.location.hash : '';
    this.error.set('');
    this.done.set(false);
    this.open.set(true);
    document.body.classList.add('reg-open');
  }

  close(): void {
    const wasDone = this.done();
    this.open.set(false);
    this.submitting.set(false);
    document.body.classList.remove('reg-open');
    // Clear the form only after a successful send, so a cancel keeps the draft.
    if (wasDone) {
      this.message.set('');
      this.category.set(this.categories[0]);
      this.done.set(false);
    }
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.open()) this.close();
  }

  async submit(e: Event): Promise<void> {
    e.preventDefault();
    const message = this.message().trim();
    if (!message || this.submitting()) return;

    this.submitting.set(true);
    this.error.set('');
    try {
      const { id } = await this.api.submitReport({
        category: this.category(),
        message,
        page: this.page,
      });
      this.refId.set(id);
      this.done.set(true);
    } catch (err) {
      this.error.set((err as Error)?.message || 'Could not send the report. Please try again.');
    } finally {
      this.submitting.set(false);
    }
  }
}
