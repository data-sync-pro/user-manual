import { Component, HostListener, OnDestroy, OnInit, computed, inject, signal, viewChild } from '@angular/core';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { Functions, httpsCallable } from '@angular/fire/functions';
import { Subscription } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { PortalApiService } from '../../core/portal-api.service';
import { fmtMoney, formatArrShort, splitArrShort } from '../../core/format';
import { Deal, DealStatus, Partner } from '../../core/models';
import { Tier, tierFor, nextTier, rateFor } from '../../core/tiers';
import { buildCommissionSchedule } from '../../core/commission';
import { NavComponent } from '../../shared/nav.component';
import { FooterComponent } from '../../shared/footer.component';
import { CommissionScheduleComponent } from '../../shared/commission-schedule.component';
import { DealRegistrationComponent } from '../deal-registration/deal-registration.component';

type Filter = 'all' | DealStatus;

interface Badge {
  cls: string;
  label: string;
}

// Per-deal commission cell: rolling tier rate + amount; hidden for lost deals.
interface DealComm {
  show: boolean;
  amount: string;
  pct: string;
  // Tier name in effect when this deal settled (e.g. 'Gold'); '' when unsettled.
  tier: string;
}

const STATUS_BADGE: Record<DealStatus, Badge> = {
  pending: { cls: 'tag', label: 'Pending' },
  accepted: { cls: 'tag good', label: 'Accepted' },
  won: { cls: 'tag good', label: 'Closed won' },
  lost: { cls: 'tag signal', label: 'Lost' },
};

// Rows per page in the deals table, and how many numbered buttons the pager
// shows around the current page before collapsing to first/last + ellipsis.
const PAGE_SIZE = 10;
const PAGER_SPAN = 2;

// Status sort rank (matches the filter-tab order: pending → accepted → won → lost).
const STATUS_ORDER: Record<DealStatus, number> = { pending: 0, accepted: 1, won: 2, lost: 3 };

// A sortable deals-table column. `num` right-aligns the header/cells.
interface SortCol {
  key: string;
  label: string;
  num: boolean;
}
const COLUMNS: SortCol[] = [
  { key: 'id', label: 'Deal ID', num: false },
  { key: 'customer', label: 'Customer', num: false },
  { key: 'status', label: 'Status', num: false },
  { key: 'track', label: 'Track', num: false },
  { key: 'arr', label: 'Amount', num: true },
  { key: 'rate', label: 'Tier %', num: true },
  { key: 'commission', label: 'Commission', num: true },
  { key: 'submitted', label: 'Submitted', num: true },
  { key: 'paid', label: 'Client paid', num: true },
];

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [RouterLink, NavComponent, FooterComponent, CommissionScheduleComponent, DealRegistrationComponent],
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent implements OnInit, OnDestroy {
  private auth = inject(AuthService);
  private api = inject(PortalApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);
  private functions = inject(Functions);

  // Header
  readonly dashTitle = signal('Dashboard');

  // Admin "view as partner" mode: set via ?as=<uid> when the viewer is an admin,
  // so the dashboard renders THAT partner's data instead of the viewer's.
  readonly viewUid = signal<string | null>(null);
  readonly viewedPartner = signal<Partner | null>(null);
  readonly isViewing = computed(() => this.viewUid() !== null);

  // Deals
  readonly allDeals = signal<Deal[]>([]);
  readonly dealsLoading = signal(true);
  // Non-empty when the last deals load FAILED — distinct from "no deals", so
  // an outage doesn't render as an innocent empty state.
  readonly dealsError = signal('');
  readonly activeFilter = signal<Filter>('all');
  readonly search = signal('');
  readonly page = signal(1);
  readonly pageSize = PAGE_SIZE;

  // Column sorting: '' key = default order (as returned by the API).
  readonly columns = COLUMNS;
  readonly sortKey = signal('');
  readonly sortDir = signal<'asc' | 'desc'>('asc');

  // Trailing-12-month window cutoff (ISO date, exclusive lower bound).
  private readonly cutoff12mo = (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  })();

  readonly filteredDeals = computed(() => {
    const q = this.search().trim().toLowerCase();
    const f = this.activeFilter();
    return this.allDeals().filter((d) => {
      if (f !== 'all' && d.status !== f) return false;
      if (q) {
        const hay = (d.customer + ' ' + d.domain + ' ' + d.id + ' ' + d.stage).toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  });

  // Filtered set ordered by the active sort column (stable default order when
  // no column is selected).
  readonly sortedDeals = computed(() => {
    const list = this.filteredDeals();
    const key = this.sortKey();
    if (!key) return list;
    const dir = this.sortDir() === 'asc' ? 1 : -1;
    return [...list].sort((a, b) => this.cmpVal(this.sortVal(a, key), this.sortVal(b, key), dir));
  });

  // ---- Pagination (client-side, over the filtered + sorted set) ----
  readonly totalPages = computed(() => Math.max(1, Math.ceil(this.filteredDeals().length / PAGE_SIZE)));
  // page() may go stale when a filter shrinks the result set — clamp on read.
  readonly clampedPage = computed(() => Math.min(Math.max(1, this.page()), this.totalPages()));
  readonly pagedDeals = computed(() => {
    const start = (this.clampedPage() - 1) * PAGE_SIZE;
    return this.sortedDeals().slice(start, start + PAGE_SIZE);
  });
  // "1–10 of 29" summary for the pager footer.
  readonly rangeText = computed(() => {
    const n = this.filteredDeals().length;
    if (n === 0) return '0 of 0';
    const start = (this.clampedPage() - 1) * PAGE_SIZE + 1;
    const end = Math.min(n, this.clampedPage() * PAGE_SIZE);
    return start + '–' + end + ' of ' + n;
  });
  // Windowed page numbers around the current page (first/last added in template).
  readonly pageWindow = computed(() => {
    const total = this.totalPages();
    const cur = this.clampedPage();
    const want = PAGER_SPAN * 2 + 1;
    let start = Math.max(1, cur - PAGER_SPAN);
    let end = Math.min(total, cur + PAGER_SPAN);
    if (end - start + 1 < want) {
      if (start === 1) end = Math.min(total, start + want - 1);
      else if (end === total) start = Math.max(1, end - want + 1);
    }
    const pages: number[] = [];
    for (let i = start; i <= end; i++) pages.push(i);
    return pages;
  });

  readonly counts = computed(() => {
    const c = { all: this.allDeals().length, pending: 0, accepted: 0, won: 0, lost: 0 };
    this.allDeals().forEach((d) => {
      if (c[d.status] != null) c[d.status] += 1;
    });
    return c;
  });

  // Trailing-12-month referred ARR = Closed-won ARR submitted in the last year.
  // This figure sets the partner tier.
  readonly trailingArr = computed(() =>
    this.allDeals()
      .filter((d) => d.status === 'won' && d.submitted >= this.cutoff12mo)
      .reduce((s, d) => s + (Number(d.arr) || 0), 0),
  );

  // Tier ladder used for the header tier summary.
  readonly tier = computed<Tier>(() => tierFor(this.trailingArr()));
  readonly tierName = computed(() => this.tier().name);
  // Headline figure split so the unit (K/M/B) renders smaller + muted.
  readonly trailingArrFig = computed(() => splitArrShort(this.trailingArr()));
  readonly nextTierInfo = computed(() => {
    const n = nextTier(this.tier());
    return n ? { name: n.name, at: formatArrShort(n.min) } : null;
  });

  // Quarterly commission payout schedule — each won deal's commission is paid in
  // 4 installments, one per quarter, the first landing on the quarterly payout
  // date ≥ 30 days after the client paid. Recomputes when deals change.
  readonly schedule = computed(() =>
    buildCommissionSchedule(this.allDeals(), (d) => this.dealRate(d), new Date()),
  );

  // Manual "Refresh from Salesforce" control: in-flight flag + result message.
  readonly syncing = signal(false);
  readonly syncMsg = signal('');
  readonly syncErr = signal(false);

  // Register modal
  readonly registerOpen = signal(false);
  private submittedInModal = false;
  private fragSub?: Subscription;
  // Focus management: where focus was before the modal opened, restored on close.
  private lastFocused: HTMLElement | null = null;
  // The embedded wizard, so we can refuse to close it mid-submit (closing would
  // destroy it and drop the (submitted) callback after the deal is written).
  private regComp = viewChild(DealRegistrationComponent);

  readonly fmtMoney = fmtMoney;

  badge(status: DealStatus): Badge {
    return STATUS_BADGE[status] || STATUS_BADGE.pending;
  }

  // Track pill for a deal: { label, kind } — kind drives the pill color; ''
  // (em-dash) when a legacy deal has no track recorded.
  trackOf(d: Deal): { label: string; kind: string } {
    if (/referral/i.test(d.track)) return { label: 'Referral', kind: 'referral' };
    if (/solution/i.test(d.track)) return { label: 'Solution', kind: 'solution' };
    return { label: '—', kind: '' };
  }

  // 12 months before an ISO date — the rolling window's start.
  private windowStart(dateStr: string): string {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return '';
    d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }

  // Trailing-12mo Closed-won referred ARR as of a deal's date, EXCLUDING the
  // deal itself — the volume already accumulated when this deal was credited.
  // This (rolling) figure sets the deal's tier rate.
  private trailingArrAsOf(deal: Deal): number {
    const end = deal.submitted;
    const start = this.windowStart(end);
    return this.allDeals()
      .filter(
        (e) => e.id !== deal.id && e.status === 'won' && e.submitted > start && e.submitted <= end,
      )
      .reduce((s, e) => s + (Number(e.arr) || 0), 0);
  }

  // The track whose rates apply by default — the viewed partner's in admin view,
  // otherwise the signed-in partner's. Per-deal track still wins over this.
  private effectiveTrack(): string | undefined {
    return (this.isViewing() ? this.viewedPartner()?.track : this.auth.partner()?.track) || undefined;
  }

  // Per-deal commission rate = the tier rate at this deal's point in time, on
  // the deal's own registered track (Solution/Referral), falling back to the
  // partner's default track for legacy deals with no track recorded.
  dealRate(deal: Deal): number {
    // Prefer the rate locked in at settlement (persisted server-side by the
    // pull); fall back to the live rolling tier rate for deals not yet locked.
    if (typeof deal.lockedRate === 'number') return deal.lockedRate;
    const track = deal.track || this.effectiveTrack();
    return rateFor(tierFor(this.trailingArrAsOf(deal)), track);
  }

  // A deal is "settled" — and so earns a real commission at a locked-in tier
  // rate — only once it is closed won AND the client has paid. Until then the
  // figures are just pipeline projection, so the table hides them.
  isSettled(d: Deal): boolean {
    return d.status === 'won' && !!d.paidDate;
  }

  // Per-deal commission cell: rolling tier rate + amount, shown only once the
  // deal is settled; otherwise both Tier % and Commission read "—".
  dealComm(d: Deal): DealComm {
    if (!this.isSettled(d)) return { show: false, amount: '', pct: '—', tier: '' };
    // Prefer the tier/rate locked in when the deal settled (persisted server-side
    // by the pull) so the figure never drifts as later deals move the trailing
    // window; fall back to the live rolling computation for deals settled before
    // locking existed.
    let rate: number;
    let tierName: string;
    if (typeof d.lockedRate === 'number') {
      rate = d.lockedRate;
      tierName = d.lockedTier || tierFor(this.trailingArrAsOf(d)).name;
    } else {
      const tier = tierFor(this.trailingArrAsOf(d));
      rate = rateFor(tier, d.track || this.effectiveTrack());
      tierName = tier.name;
    }
    return {
      show: true,
      amount: fmtMoney(Math.round((Number(d.arr) || 0) * rate)),
      pct: Math.round(rate * 100) + '%',
      tier: tierName,
    };
  }

  ngOnInit(): void {
    // Admin viewing a partner's dashboard: /dashboard?as=<uid>.
    const as = this.route.snapshot.queryParamMap.get('as');
    if (as && this.auth.isAdmin()) {
      this.viewUid.set(as);
      this.api.getPartner(as).then((p) => {
        this.viewedPartner.set(p);
        this.fillHeader();
      });
      this.fillDeals();
      // No Salesforce refresh / registration while viewing as admin.
    } else {
      this.fillHeader();
      this.fillDeals();
      // On login/refresh, pull any Salesforce-side edits back in (server-side
      // throttled to once per 5 min). Reload deals if anything changed.
      this.refreshFromSalesforce();
    }

    // Deep link / nav: /dashboard#register opens the modal (not in view mode).
    this.fragSub = this.route.fragment.subscribe((frag) => {
      if (frag === 'register' && !this.isViewing()) this.openRegister();
    });
  }

  // Calls the refreshFromSalesforce callable; re-loads deals if it pulled changes.
  // Failures (Salesforce down, throttled) are non-fatal — cached deals still show.
  private refreshFromSalesforce(): void {
    const call = httpsCallable<unknown, { updated?: number; removed?: number; skipped?: boolean }>(
      this.functions,
      'refreshFromSalesforce',
    );
    call({})
      .then((res) => {
        if (res.data?.updated || res.data?.removed) this.fillDeals();
      })
      .catch((err: { message?: string }) => {
        console.warn('[dashboard] Salesforce refresh skipped:', err?.message || err);
      });
  }

  // Manual refresh: explicit user action, so it bypasses the server-side 5-min
  // auto-throttle (force:true). Pulls this partner's latest Salesforce deals,
  // reloads the table if anything changed, and surfaces a short result message.
  async syncNow(): Promise<void> {
    if (this.syncing() || this.isViewing()) return;
    this.syncing.set(true);
    this.syncErr.set(false);
    this.syncMsg.set('');
    const call = httpsCallable<
      { force: boolean },
      { updated?: number; count?: number; removed?: number; skipped?: boolean; reason?: string }
    >(this.functions, 'refreshFromSalesforce');
    try {
      const res = await call({ force: true });
      const data = res.data || {};
      if (data.reason === 'no-account') {
        this.syncMsg.set('No Salesforce account is linked to your profile.');
      } else {
        const n = data.updated || 0;
        const r = data.removed || 0;
        if (n > 0 || r > 0) {
          this.fillDeals();
          const parts: string[] = [];
          if (n > 0) parts.push(`updated ${n} deal${n === 1 ? '' : 's'}`);
          if (r > 0) parts.push(`removed ${r} deal${r === 1 ? '' : 's'}`);
          const msg = parts.join(', ') + ' from Salesforce.';
          this.syncMsg.set(msg.charAt(0).toUpperCase() + msg.slice(1));
        } else {
          this.syncMsg.set('Already up to date.');
        }
      }
    } catch (err: unknown) {
      this.syncErr.set(true);
      this.syncMsg.set((err as { message?: string })?.message || 'Salesforce sync failed.');
    } finally {
      this.syncing.set(false);
    }
  }

  ngOnDestroy(): void {
    this.fragSub?.unsubscribe();
    document.body.classList.remove('reg-open');
  }

  setFilter(f: Filter): void {
    this.activeFilter.set(f);
    this.page.set(1); // new filter → back to the first page
  }

  onSearch(value: string): void {
    this.search.set(value);
    this.page.set(1); // new query → back to the first page
  }

  goToPage(p: number): void {
    this.page.set(Math.min(Math.max(1, p), this.totalPages()));
  }

  // ---- Column sorting ----
  // Click cycles a column: asc → desc → back to default (no sort).
  sortBy(key: string): void {
    if (this.sortKey() !== key) {
      this.sortKey.set(key);
      this.sortDir.set('asc');
    } else if (this.sortDir() === 'asc') {
      this.sortDir.set('desc');
    } else {
      this.sortKey.set('');
      this.sortDir.set('asc');
    }
    this.page.set(1); // re-sorted → show the top of the new order
  }

  // Header arrow: faint ↕ when sortable-but-inactive, ▲/▼ when active.
  arrowFor(key: string): string {
    if (this.sortKey() !== key) return '↕';
    return this.sortDir() === 'asc' ? '▲' : '▼';
  }
  ariaSort(key: string): 'ascending' | 'descending' | 'none' {
    if (this.sortKey() !== key) return 'none';
    return this.sortDir() === 'asc' ? 'ascending' : 'descending';
  }

  // Comparable value for a deal on a given column ('' / null sort to the bottom).
  private sortVal(d: Deal, key: string): number | string | null {
    switch (key) {
      case 'id': return d.id;
      case 'customer': return (d.customer || '').toLowerCase();
      case 'status': return STATUS_ORDER[d.status] ?? 99;
      case 'track': return (d.track || '').toLowerCase();
      case 'arr': return Number(d.arr) || 0;
      case 'rate': return this.isSettled(d) ? this.dealRate(d) : null;
      case 'commission': return this.isSettled(d) ? Math.round((Number(d.arr) || 0) * this.dealRate(d)) : null;
      case 'submitted': return d.submitted || '';
      case 'paid': return d.paidDate || '';
      default: return '';
    }
  }

  // Compare two sort values; blanks (null / '') always sort last, regardless of
  // direction, so "—" rows stay at the bottom either way.
  private cmpVal(av: number | string | null, bv: number | string | null, dir: number): number {
    const aBlank = av === null || av === '';
    const bBlank = bv === null || bv === '';
    if (aBlank && bBlank) return 0;
    if (aBlank) return 1;
    if (bBlank) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  }

  private fillHeader(): void {
    const p = this.isViewing() ? this.viewedPartner() : this.auth.currentPartner();
    if (!p) return;
    if (p.company || p.name) this.dashTitle.set(p.company || p.name || 'Dashboard');
  }

  private fillDeals(): void {
    this.dealsLoading.set(true);
    this.dealsError.set('');
    const uid = this.viewUid();
    const load = uid ? this.api.getDealsForUid(uid) : this.api.getDeals();
    load
      .then((deals) => {
        this.allDeals.set(Array.isArray(deals) ? deals : []);
        this.dealsLoading.set(false);
      })
      .catch((err: Error) => {
        console.warn('[dashboard] deals load failed:', err?.message);
        // Keep whatever was already loaded — don't wipe allDeals to [], which
        // would collapse the header tier/ARR, filter counts, and commission
        // schedule to a healthy-looking $0 state on a transient failure.
        this.dealsLoading.set(false);
        this.dealsError.set('Could not load your deals. Please refresh to try again.');
      });
  }

  // ---- Register modal ----
  // aria-modal dialogs must be dismissible from the keyboard.
  @HostListener('document:keydown.escape')
  onEscape(): void {
    if (this.registerOpen()) this.closeRegister();
  }

  openRegister(): void {
    if (this.isViewing()) return; // admins don't register on a partner's behalf
    this.submittedInModal = false;
    this.lastFocused = document.activeElement as HTMLElement | null;
    this.registerOpen.set(true);
    document.body.classList.add('reg-open');
    // Move focus into the dialog once it has rendered.
    setTimeout(() => {
      document.querySelector<HTMLElement>('.reg-modal-close')?.focus();
    });
  }

  closeRegister(): void {
    if (!this.registerOpen()) return; // re-entrancy guard (Esc during the success timeout)
    // Don't tear down the wizard while its submit is in flight — the deal would
    // be written but the (submitted) callback lost, inviting a duplicate.
    if (this.regComp()?.submitting()) return;
    this.registerOpen.set(false);
    document.body.classList.remove('reg-open');
    this.lastFocused?.focus();
    this.lastFocused = null;
    // Clear the #register fragment so it can reopen later.
    if (this.route.snapshot.fragment === 'register') {
      this.router.navigate(['/dashboard']);
    }
    // Refresh data to show a newly registered deal (commission recomputes reactively).
    if (this.submittedInModal) {
      this.fillDeals();
    }
  }

  onDealSubmitted(): void {
    this.submittedInModal = true;
    // Let the success state show briefly, then close + refresh.
    setTimeout(() => this.closeRegister(), 1500);
  }
}
