import { Component, OnInit, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PortalApiService } from '../../core/portal-api.service';
import { fmtMoney } from '../../core/format';
import { Deal, DealStatus } from '../../core/models';
import { NavComponent } from '../../shared/nav.component';
import { FooterComponent } from '../../shared/footer.component';

const STATUS_BADGE: Record<DealStatus, { cls: string; label: string }> = {
  pending: { cls: 'tag', label: 'Pending' },
  accepted: { cls: 'tag good', label: 'Accepted' },
  won: { cls: 'tag good', label: 'Closed won' },
  lost: { cls: 'tag signal', label: 'Lost' },
};
const STATUSES: DealStatus[] = ['pending', 'accepted', 'won', 'lost'];

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [RouterLink, NavComponent, FooterComponent],
  templateUrl: './admin.component.html',
})
export class AdminComponent implements OnInit {
  private api = inject(PortalApiService);

  readonly deals = signal<Deal[]>([]);
  readonly loading = signal(true);
  readonly statusText = signal('Loading deals…');
  readonly updating = signal<Set<string>>(new Set());

  readonly statuses = STATUSES;
  readonly fmtMoney = fmtMoney;

  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  badge(status: DealStatus) {
    return STATUS_BADGE[status] || STATUS_BADGE.pending;
  }
  label(status: DealStatus): string {
    return (STATUS_BADGE[status] || { label: status }).label;
  }

  ngOnInit(): void {
    this.api
      .getAllDeals()
      .then((deals) => {
        this.deals.set(Array.isArray(deals) ? deals : []);
        this.loading.set(false);
        this.setCountText();
      })
      .catch((err: Error) => {
        this.loading.set(false);
        this.statusText.set('Failed to load deals: ' + (err?.message || 'error'));
      });
  }

  private setCountText(): void {
    const n = this.deals().length;
    this.statusText.set(n + ' deal' + (n === 1 ? '' : 's') + ' across all partners.');
  }

  private toast(msg: string): void {
    this.statusText.set(msg);
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => this.setCountText(), 2600);
  }

  isUpdating(id: string): boolean {
    return this.updating().has(id);
  }

  onStatusChange(deal: Deal, next: DealStatus): void {
    const prev = deal.status;
    if (next === prev) return;

    const upd = new Set(this.updating());
    upd.add(deal.id);
    this.updating.set(upd);

    this.api
      .updateDealStatus(deal.id, next)
      .then(() => {
        this.deals.update((list) =>
          list.map((d) => (d.id === deal.id ? { ...d, status: next } : d)),
        );
        this.clearUpdating(deal.id);
        this.toast(deal.id + ' → ' + this.label(next));
      })
      .catch((err: Error) => {
        // Revert the visible selection by re-rendering with the old status.
        this.deals.update((list) =>
          list.map((d) => (d.id === deal.id ? { ...d, status: prev } : d)),
        );
        this.clearUpdating(deal.id);
        this.toast('Update failed: ' + (err?.message || 'error'));
      });
  }

  // Record the date the client paid — drives the partner's commission schedule.
  onPaidDateChange(deal: Deal, ymd: string): void {
    const prev = deal.paidDate;
    if (ymd === prev) return;

    const upd = new Set(this.updating());
    upd.add(deal.id);
    this.updating.set(upd);

    this.api
      .setDealPaidDate(deal.id, ymd)
      .then(() => {
        this.deals.update((list) =>
          list.map((d) => (d.id === deal.id ? { ...d, paidDate: ymd } : d)),
        );
        this.clearUpdating(deal.id);
        this.toast(deal.id + (ymd ? ' · client paid ' + ymd : ' · payment date cleared'));
      })
      .catch((err: Error) => {
        this.deals.update((list) =>
          list.map((d) => (d.id === deal.id ? { ...d, paidDate: prev } : d)),
        );
        this.clearUpdating(deal.id);
        this.toast('Update failed: ' + (err?.message || 'error'));
      });
  }

  private clearUpdating(id: string): void {
    const upd = new Set(this.updating());
    upd.delete(id);
    this.updating.set(upd);
  }
}
