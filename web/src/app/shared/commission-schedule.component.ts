import { Component, Input, signal } from '@angular/core';
import { CommissionPayout } from '../core/models';
import { COMMISSION_INSTALLMENTS } from '../core/commission';
import { fmtMoney, formatArrShort } from '../core/format';

type Tab = 'plan' | 'paid';

// Vertical timeline of quarterly commission payouts, split into two tabs:
// "Plan to pay" (the next payout + everything scheduled after) and "Paid"
// (already-disbursed quarters). Each row is one quarterly payout date with its
// total and a per-deal breakdown (customer · installment n/4 · amount).
@Component({
  selector: 'app-commission-schedule',
  standalone: true,
  template: `
    @if (data.length === 0) {
      <p class="cs-empty">No commission scheduled yet.</p>
    } @else {
      <div class="cs-tabs" role="tablist" aria-label="Commission schedule">
        <button
          type="button"
          class="cs-tab"
          role="tab"
          [class.active]="tab() === 'plan'"
          [attr.aria-selected]="tab() === 'plan'"
          (click)="setTab('plan')"
        >
          Scheduled <span class="cs-tab-c">{{ planTotalLabel() }}</span>
        </button>
        <button
          type="button"
          class="cs-tab"
          role="tab"
          [class.active]="tab() === 'paid'"
          [attr.aria-selected]="tab() === 'paid'"
          (click)="setTab('paid')"
        >
          Paid <span class="cs-tab-c">{{ paidTotalLabel() }}</span>
        </button>
      </div>

      @if (shown().length === 0) {
        <p class="cs-empty">
          {{ tab() === 'paid' ? 'No commission paid yet.' : 'No upcoming commission.' }}
        </p>
      } @else {
        <ol class="cs-timeline">
          @for (p of shown(); track p.date) {
            <li class="cs-row" [attr.data-status]="p.status">
              <span class="cs-dot" aria-hidden="true"></span>
              <div class="cs-main">
                <!-- Quarter header toggles the per-deal breakdown open/closed -->
                <button
                  type="button"
                  class="cs-head"
                  [class.open]="isOpen(p)"
                  [attr.aria-expanded]="isOpen(p)"
                  (click)="toggle(p)"
                >
                  <div class="cs-meta">
                    <span class="cs-quarter">{{ p.quarter }}</span>
                    <span class="cs-date">{{ p.dateLabel }}</span>
                  </div>
                  <div class="cs-amt">
                    <span class="cs-money">{{ money(p.amount) }}</span>
                    <span class="cs-tag">{{ labelFor(p) }}</span>
                  </div>
                  <svg class="cs-chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6"
                      stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
                <!-- Per-deal breakdown: customer · installment n of 4 · amount -->
                @if (isOpen(p)) {
                  <ul class="cs-items">
                    @for (it of p.items; track it.dealId) {
                      <li class="cs-item">
                        <span class="cs-item-name" [attr.title]="it.customer">{{ it.customer }}</span>
                        <span class="cs-item-inst">{{ it.installment }}/{{ installments }}</span>
                        <span class="cs-item-amt">{{ money(it.amount) }}</span>
                      </li>
                    }
                  </ul>
                }
              </div>
            </li>
          }
        </ol>
      }
    }
  `,
})
export class CommissionScheduleComponent {
  // Open the "next" payout by default; collapse the rest.
  @Input() set data(value: CommissionPayout[]) {
    this._data = Array.isArray(value) ? value : [];
    const next = this._data.find((p) => p.status === 'next');
    this.open.set(new Set(next ? [next.date] : []));
  }
  get data(): CommissionPayout[] {
    return this._data;
  }
  private _data: CommissionPayout[] = [];

  readonly money = fmtMoney;
  readonly installments = COMMISSION_INSTALLMENTS;
  readonly tab = signal<Tab>('plan');
  // Date keys of the quarters whose per-deal breakdown is expanded.
  readonly open = signal<Set<string>>(new Set());

  setTab(t: Tab): void {
    this.tab.set(t);
  }

  isOpen(p: CommissionPayout): boolean {
    return this.open().has(p.date);
  }

  toggle(p: CommissionPayout): void {
    const next = new Set(this.open());
    if (next.has(p.date)) {
      next.delete(p.date);
    } else {
      next.add(p.date);
    }
    this.open.set(next);
  }

  // Already-disbursed quarters vs. everything still to be paid (next + later).
  private get paidList(): CommissionPayout[] {
    return this.data.filter((p) => p.status === 'paid');
  }
  private get planList(): CommissionPayout[] {
    return this.data.filter((p) => p.status !== 'paid');
  }

  shown(): CommissionPayout[] {
    return this.tab() === 'paid' ? this.paidList : this.planList;
  }

  planTotalLabel(): string {
    return formatArrShort(this.sum(this.planList));
  }
  paidTotalLabel(): string {
    return formatArrShort(this.sum(this.paidList));
  }
  private sum(list: CommissionPayout[]): number {
    return list.reduce((s, p) => s + p.amount, 0);
  }

  labelFor(p: CommissionPayout): string {
    return p.status === 'paid' ? 'Paid' : p.status === 'next' ? 'Next payout' : 'Scheduled';
  }
}
