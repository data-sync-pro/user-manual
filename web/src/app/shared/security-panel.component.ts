import { Component, OnInit, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { AuthService } from '../core/auth.service';

// Account-security panel: lets the signed-in user keep BOTH sign-in methods on
// the same account — connect Google to a password account, or set a password on
// a Google account. Linking always targets the current user, so the UID (and
// the partners/{uid} profile + invite-only gate) never changes. Rendered on
// both the partner dashboard and the admin console.
@Component({
  selector: 'app-security-panel',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './security-panel.component.html',
})
export class SecurityPanelComponent implements OnInit {
  private auth = inject(AuthService);

  // Which methods are currently linked (+ the account email).
  readonly lp = signal(this.auth.linkedProviders());
  // How many sign-in methods are active — drives the "multiple methods" note.
  readonly activeCount = computed(() => {
    const p = this.lp();
    return (p.google ? 1 : 0) + (p.microsoft ? 1 : 0) + (p.password ? 1 : 0);
  });
  // Which async op is in flight (disables buttons, swaps labels).
  readonly busy = signal<null | 'google' | 'microsoft' | 'password' | 'reauth'>(null);
  readonly msg = signal<string | null>(null);
  readonly msgErr = signal(false);
  readonly showPwForm = signal(false);
  // Set when an action returned requires-recent-login; reveals the reauth UI.
  readonly needReauth = signal(false);

  // The action to replay after a successful re-authentication.
  private pendingAction: 'google' | 'microsoft' | 'password' | null = null;

  pw = '';
  reauthPw = '';

  async ngOnInit(): Promise<void> {
    // Pull the freshest providerData before reading the badges.
    try {
      await this.auth.refreshUser();
    } catch {
      /* ignore — fall back to the cached user */
    }
    this.refresh();
  }

  private refresh(): void {
    this.lp.set(this.auth.linkedProviders());
  }

  // Connect Google to the current (password) account. Called straight from the
  // click so the popup keeps its user gesture.
  connectGoogle(): void {
    this.pendingAction = 'google';
    this.run('google', () => this.auth.linkGoogle(), 'Google connected — you can now sign in with Google too.');
  }

  // Connect Microsoft to the current account. Called straight from the click so
  // the popup keeps its user gesture.
  connectMicrosoft(): void {
    this.pendingAction = 'microsoft';
    this.run('microsoft', () => this.auth.linkMicrosoft(),
      'Microsoft connected — you can now sign in with Microsoft too.');
  }

  // Submit the "set a password" form for a Google-only account.
  submitPassword(): void {
    if (this.pw.length < 6) {
      this.msg.set('Choose a password with at least 6 characters.');
      this.msgErr.set(true);
      return;
    }
    this.pendingAction = 'password';
    this.run('password', () => this.auth.addPassword(this.pw),
      'Password set — you can now sign in with email + password too.');
  }

  // Shared runner for the two link actions: manages busy/msg state and the
  // requires-recent-login branch (reveal the reauth UI instead of erroring).
  private run(kind: 'google' | 'microsoft' | 'password', action: () => Promise<void>, okMsg: string): void {
    this.busy.set(kind);
    this.msg.set(null);
    this.msgErr.set(false);
    action()
      .then(() => {
        this.msg.set(okMsg);
        this.msgErr.set(false);
        this.needReauth.set(false);
        this.pendingAction = null;
        this.showPwForm.set(false);
        this.pw = '';
      })
      .catch((e: Error & { code?: string }) => {
        if (e?.code === 'auth/requires-recent-login') {
          // Stale session — keep pendingAction and prompt for re-auth.
          this.needReauth.set(true);
        } else {
          this.msg.set(e?.message || 'Something went wrong. Please try again.');
          this.msgErr.set(true);
        }
      })
      .finally(() => {
        this.busy.set(null);
        this.refresh();
      });
  }

  // Re-authenticate (remedy for requires-recent-login), then replay the action.
  confirmReauthGoogle(): void {
    this.busy.set('reauth');
    this.msg.set(null);
    this.auth.reauthGoogle()
      .then(() => this.afterReauth())
      .catch((e: Error) => this.reauthFailed(e));
  }

  confirmReauthMicrosoft(): void {
    this.busy.set('reauth');
    this.msg.set(null);
    this.auth.reauthMicrosoft()
      .then(() => this.afterReauth())
      .catch((e: Error) => this.reauthFailed(e));
  }

  confirmReauthPassword(): void {
    this.busy.set('reauth');
    this.msg.set(null);
    this.auth.reauthPassword(this.reauthPw)
      .then(() => { this.reauthPw = ''; this.afterReauth(); })
      .catch((e: Error) => this.reauthFailed(e));
  }

  private afterReauth(): void {
    this.needReauth.set(false);
    this.busy.set(null);
    if (this.pendingAction === 'password') {
      // addPassword uses linkWithCredential (no popup) — safe to replay directly.
      this.submitPassword();
    } else if (this.pendingAction === 'google' || this.pendingAction === 'microsoft') {
      // Replaying linkWithPopup from this promise continuation would open a popup
      // OUTSIDE a user gesture (blocked by Safari, intermittently by Chromium).
      // The session is recent now, so just ask the user to click again — the
      // Connect button is still shown (the provider is still unlinked).
      const label = this.pendingAction === 'google' ? 'Connect Google' : 'Connect Microsoft';
      this.msg.set(`Verified — click “${label}” again to finish.`);
      this.msgErr.set(false);
    }
  }

  private reauthFailed(e: Error): void {
    this.msg.set(e?.message || 'Re-authentication failed. Please try again.');
    this.msgErr.set(true);
    this.busy.set(null);
  }
}
