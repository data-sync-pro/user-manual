import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { PortalApiService } from '../../core/portal-api.service';
import { fmtMoney } from '../../core/format';
import { Deal, DealStatus, PartnerRow } from '../../core/models';
import { NavComponent } from '../../shared/nav.component';
import { FooterComponent } from '../../shared/footer.component';

const STATUS_BADGE: Record<DealStatus, { cls: string; label: string }> = {
  pending: { cls: 'tag', label: 'Pending' },
  accepted: { cls: 'tag good', label: 'Accepted' },
  won: { cls: 'tag good', label: 'Closed won' },
  lost: { cls: 'tag signal', label: 'Lost' },
};

@Component({
  selector: 'app-admin',
  standalone: true,
  imports: [RouterLink, NavComponent, FooterComponent],
  templateUrl: './admin.component.html',
})
export class AdminComponent implements OnInit {
  private api = inject(PortalApiService);

  readonly deals = signal<Deal[]>([]);
  readonly partners = signal<PartnerRow[]>([]);
  readonly loading = signal(true);
  readonly statusText = signal('Loading deals…');
  readonly updating = signal<Set<string>>(new Set());

  readonly fmtMoney = fmtMoney;

  // Each partner + how many deals they own (derived from the all-deals load).
  readonly partnerRows = computed(() => {
    const counts = new Map<string, number>();
    this.deals().forEach((d) => counts.set(d.ownerUid, (counts.get(d.ownerUid) || 0) + 1));
    return this.partners().map((p) => ({ ...p, dealCount: counts.get(p.uid) || 0 }));
  });

  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  // Owner uid -> the partner's (Salesforce-consistent) company name; falls back
  // to the uid if the partner profile hasn't loaded.
  partnerName(uid: string): string {
    const p = this.partners().find((x) => x.uid === uid);
    return p?.company || p?.name || uid;
  }

  badge(status: DealStatus) {
    return STATUS_BADGE[status] || STATUS_BADGE.pending;
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

    this.api
      .getAllPartners()
      .then((ps) => this.partners.set(Array.isArray(ps) ? ps : []))
      .catch(() => this.partners.set([]));
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

  // Record the date the client paid — drives the partner's commission schedule.
  onPaidDateChange(deal: Deal, ymd: string): void {
    const prev = deal.paidDate;
    if (ymd === prev) return;

    const upd = new Set(this.updating());
    upd.add(deal.id);
    this.updating.set(upd);

    // Optimistic update BEFORE the call so a failure's revert (next -> prev)
    // actually reaches the DOM — reverting a model that never changed is a
    // no-op for Angular and would leave the input showing the failed value.
    this.deals.update((list) =>
      list.map((d) => (d.id === deal.id ? { ...d, paidDate: ymd } : d)),
    );

    this.api
      .setDealPaidDate(deal.id, ymd)
      .then(() => {
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
