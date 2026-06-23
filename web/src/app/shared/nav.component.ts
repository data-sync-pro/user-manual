import { Component, ElementRef, HostListener, Input, inject, signal } from '@angular/core';
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
export class NavComponent {
  @Input() active: 'dashboard' | 'register' | 'admin' | null = null;

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
    this.auth
      .signOut()
      .then(() => this.router.navigateByUrl('/login'))
      .catch(() => this.router.navigateByUrl('/login'));
  }
}
