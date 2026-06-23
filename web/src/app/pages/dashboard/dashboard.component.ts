import { Component, OnDestroy, OnInit, computed, inject, signal } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { Subscription } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { PortalApiService } from '../../core/portal-api.service';
import { fmtMoney, formatArrShort, splitArrShort } from '../../core/format';
import { Deal, DealStatus, PipelineEntry } from '../../core/models';
import { Tier, tierFor, nextTier, rateFor } from '../../core/tiers';
import { NavComponent } from '../../shared/nav.component';
import { FooterComponent } from '../../shared/footer.component';
import { PipelineChartComponent } from '../../shared/pipeline-chart.component';
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
}

const STATUS_BADGE: Record<DealStatus, Badge> = {
  pending: { cls: 'tag', label: 'Pending' },
  accepted: { cls: 'tag good', label: 'Accepted' },
  won: { cls: 'tag good', label: 'Closed won' },
  lost: { cls: 'tag signal', label: 'Lost' },
};

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [NavComponent, FooterComponent, PipelineChartComponent, DealRegistrationComponent],
  templateUrl: './dashboard.component.html',
})
export class DashboardComponent implements OnInit, OnDestroy {
  private auth = inject(AuthService);
  private api = inject(PortalApiService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  // Header
  readonly dashTitle = signal('Dashboard');
  readonly dashSub = signal('Partner overview');

  // Deals
  readonly allDeals = signal<Deal[]>([]);
  readonly dealsLoading = signal(true);
  readonly activeFilter = signal<Filter>('all');
  readonly search = signal('');

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

  // Tier ladder + the rate that applies to this partner's track.
  readonly tier = computed<Tier>(() => tierFor(this.trailingArr()));
  readonly tierName = computed(() => this.tier().name);
  readonly rateBasis = computed(() =>
    /solution/i.test(this.auth.partner()?.track || '') ? 'Solution' : 'Referral',
  );
  readonly commRate = computed(() => rateFor(this.tier(), this.auth.partner()?.track));
  readonly commRatePct = computed(() => Math.round(this.commRate() * 100) + '%');
  // Headline figure split so the unit (K/M/B) renders smaller + muted.
  readonly trailingArrFig = computed(() => splitArrShort(this.trailingArr()));
  readonly nextTierInfo = computed(() => {
    const n = nextTier(this.tier());
    return n ? { name: n.name, at: formatArrShort(n.min) } : null;
  });

  // Pipeline chart (open + recently won, by stage)
  readonly pipeline = signal<PipelineEntry[]>([]);

  // Register modal
  readonly registerOpen = signal(false);
  private submittedInModal = false;
  private fragSub?: Subscription;

  readonly fmtMoney = fmtMoney;

  badge(status: DealStatus): Badge {
    return STATUS_BADGE[status] || STATUS_BADGE.pending;
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

  // Per-deal commission rate = the tier rate at this deal's point in time.
  dealRate(deal: Deal): number {
    return rateFor(tierFor(this.trailingArrAsOf(deal)), this.auth.partner()?.track);
  }

  // Per-deal commission cell: rolling tier rate + amount; hidden (—) for lost.
  dealComm(d: Deal): DealComm {
    if (d.status === 'lost') return { show: false, amount: '', pct: '—' };
    const rate = this.dealRate(d);
    return {
      show: true,
      amount: fmtMoney(Math.round((Number(d.arr) || 0) * rate)),
      pct: Math.round(rate * 100) + '%',
    };
  }

  ngOnInit(): void {
    this.fillHeader();
    this.fillChart();
    this.fillDeals();

    // Deep link / nav: /dashboard#register opens the modal.
    this.fragSub = this.route.fragment.subscribe((frag) => {
      if (frag === 'register') this.openRegister();
    });
  }

  ngOnDestroy(): void {
    this.fragSub?.unsubscribe();
    document.body.classList.remove('reg-open');
  }

  setFilter(f: Filter): void {
    this.activeFilter.set(f);
  }

  onSearch(value: string): void {
    this.search.set(value);
  }

  private fillHeader(): void {
    const p = this.auth.currentPartner();
    if (!p) return;
    if (p.company || p.name) this.dashTitle.set(p.company || p.name || 'Dashboard');
    const bits: string[] = [];
    if (p.track) bits.push(p.track + ' track');
    if (p.email) bits.push(p.email);
    if (bits.length) this.dashSub.set(bits.join(' · '));
  }

  private fillChart(): void {
    this.api.getPipeline().then((data) => this.pipeline.set(data));
  }

  private fillDeals(): void {
    this.dealsLoading.set(true);
    this.api.getDeals().then((deals) => {
      this.allDeals.set(Array.isArray(deals) ? deals : []);
      this.dealsLoading.set(false);
    });
  }

  // ---- Register modal ----
  openRegister(): void {
    this.submittedInModal = false;
    this.registerOpen.set(true);
    document.body.classList.add('reg-open');
  }

  closeRegister(): void {
    this.registerOpen.set(false);
    document.body.classList.remove('reg-open');
    // Clear the #register fragment so it can reopen later.
    if (this.route.snapshot.fragment === 'register') {
      this.router.navigate(['/dashboard']);
    }
    // Refresh data to show a newly registered deal (commission recomputes reactively).
    if (this.submittedInModal) {
      this.fillChart();
      this.fillDeals();
    }
  }

  onDealSubmitted(): void {
    this.submittedInModal = true;
    // Let the success state show briefly, then close + refresh.
    setTimeout(() => this.closeRegister(), 1500);
  }
}
