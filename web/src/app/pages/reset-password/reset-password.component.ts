import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { FooterComponent } from '../../shared/footer.component';

// The four screens of the reset flow: checking the link, the new-password form,
// the done state, and the invalid/expired state.
type ResetState = 'verifying' | 'form' | 'success' | 'invalid';

// Custom password-reset page. Firebase's reset email is pointed here (Console →
// Authentication → Templates → customize action URL → /auth/action); the link
// arrives with ?mode=resetPassword&oobCode=<code>. We verify the code, show a
// branded new-password form, and confirm the reset — replacing Firebase's
// default hosted page.
@Component({
  selector: 'app-reset-password',
  standalone: true,
  imports: [FormsModule, RouterLink, FooterComponent],
  templateUrl: './reset-password.component.html',
})
export class ResetPasswordComponent {
  private auth = inject(AuthService);
  private route = inject(ActivatedRoute);
  private router = inject(Router);

  readonly state = signal<ResetState>('verifying');
  readonly email = signal('');
  readonly formError = signal('');
  readonly submitting = signal(false);
  readonly invalidMsg = signal('This password reset link is invalid or has expired.');

  pw = '';
  pw2 = '';

  private oobCode = '';

  constructor() {
    const qp = this.route.snapshot.queryParamMap;
    const mode = qp.get('mode');
    this.oobCode = qp.get('oobCode') ?? '';

    // Only password resets are handled here; any other action link (or a
    // missing code) is treated as an invalid link.
    if (mode !== 'resetPassword' || !this.oobCode) {
      this.invalidMsg.set('This password reset link is invalid.');
      this.state.set('invalid');
      return;
    }

    // Validate the code up front so we can show the account email and fail fast
    // on an expired/used link, before asking for a new password.
    this.auth
      .verifyResetCode(this.oobCode)
      .then((email) => {
        this.email.set(email);
        this.state.set('form');
      })
      .catch(() => {
        this.invalidMsg.set(
          'This password reset link is invalid or has expired. Please request a new one from the sign-in page.',
        );
        this.state.set('invalid');
      });
  }

  // Enable submit only with a long-enough password that matches its confirmation.
  get formValid(): boolean {
    return this.pw.length >= 6 && this.pw === this.pw2;
  }

  onInput(): void {
    if (this.formError()) this.formError.set('');
  }

  submit(): void {
    if (this.pw.length < 6) {
      this.formError.set('Choose a password with at least 6 characters.');
      return;
    }
    if (this.pw !== this.pw2) {
      this.formError.set('The two passwords don’t match.');
      return;
    }
    this.submitting.set(true);
    this.auth
      .confirmReset(this.oobCode, this.pw)
      .then(() => this.state.set('success'))
      .catch((e: Error) => {
        this.formError.set(e?.message || 'Could not reset your password. The link may have expired.');
        this.submitting.set(false);
      });
  }

  goToLogin(): void {
    this.router.navigateByUrl('/login');
  }
}
