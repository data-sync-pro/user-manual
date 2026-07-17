import { Component, computed, inject } from '@angular/core';
import { NavComponent } from '../../shared/nav.component';
import { FooterComponent } from '../../shared/footer.component';
import { SecurityPanelComponent } from '../../shared/security-panel.component';
import { AuthService } from '../../core/auth.service';

// Account settings page: hosts the signed-in user's own sign-in methods
// (the security panel), moved out of the dashboard/admin consoles so account
// management lives on its own page for partners and admins alike. The page also
// surfaces a small identity card (avatar + email + role) so the user can see
// which account they are managing at a glance.
@Component({
  selector: 'app-account',
  standalone: true,
  imports: [NavComponent, FooterComponent, SecurityPanelComponent],
  templateUrl: './account.component.html',
})
export class AccountComponent {
  private auth = inject(AuthService);

  // Signed-in identity — reactive to the auth/partner signals.
  readonly email = computed(() => this.auth.user()?.email ?? null);
  readonly name = computed(() => this.auth.partner()?.name?.trim() || null);
  // A single letter for the avatar chip: prefer the display name, fall back to
  // the email, then a neutral placeholder.
  readonly initial = computed(() => {
    const ch = (this.name() || this.email() || '').trim().charAt(0);
    return ch ? ch.toUpperCase() : '·';
  });

  get isAdmin(): boolean {
    return this.auth.isAdmin();
  }
}
