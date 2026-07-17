import { Component, ElementRef, HostListener, Input, OnDestroy, inject, signal } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';

// Shared top nav (portal pages): sticky .scrolled, mobile hamburger
// (.menu-open), and the admin link shown only for admins. The `active` input
// highlights the current section.
@Component({
  selector: 'app-nav',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './nav.component.html',
})
export class NavComponent implements OnDestroy {
  @Input() active: 'dashboard' | 'register' | 'admin' | 'account' | null = null;

  private auth = inject(AuthService);
  private router = inject(Router);
  private host = inject(ElementRef<HTMLElement>);

  readonly scrolled = signal(false);
  readonly menuOpen = signal(false);

  get isAdmin(): boolean {
    return this.auth.isAdmin();
  }

  constructor() {
    this.scrolled.set(typeof window !== 'undefined' && window.scrollY > 8);
  }

  @HostListener('window:scroll')
  onScroll(): void {
    this.scrolled.set(window.scrollY > 8);
  }

  @HostListener('window:resize')
  onResize(): void {
    if (window.innerWidth > 980 && this.menuOpen()) this.setMenu(false);
  }

  @HostListener('document:keydown.escape')
  onEsc(): void {
    if (this.menuOpen()) this.setMenu(false);
  }

  @HostListener('document:click', ['$event'])
  onDocClick(e: MouseEvent): void {
    const el = this.host.nativeElement as HTMLElement;
    if (this.menuOpen() && !el.contains(e.target as Node)) this.setMenu(false);
  }

  toggleMenu(): void {
    this.setMenu(!this.menuOpen());
  }

  closeMenu(): void {
    this.setMenu(false);
  }

  private setMenu(open: boolean): void {
    this.menuOpen.set(open);
    document.body.style.overflow = open ? 'hidden' : '';
  }

  signOut(e: Event): void {
    e.preventDefault();
    // Signing out from the open mobile menu navigates away with the menu still
    // "open" — unlock body scrolling before leaving.
    this.closeMenu();
    this.auth
      .signOut()
      .then(() => this.router.navigateByUrl('/login'))
      .catch(() => this.router.navigateByUrl('/login'));
  }

  // Safety net: never leave body { overflow: hidden } behind when the nav is
  // destroyed mid-navigation (SPA route change, no page reload to reset it).
  ngOnDestroy(): void {
    document.body.style.overflow = '';
  }
}
