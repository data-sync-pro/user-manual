import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { isValidEmail } from '../../core/validators';
import { FooterComponent } from '../../shared/footer.component';

@Component({
  selector: 'app-login',
  standalone: true,
  imports: [FormsModule, RouterLink, FooterComponent],
  templateUrl: './login.component.html',
})
export class LoginComponent {
  private auth = inject(AuthService);
  private router = inject(Router);
  private route = inject(ActivatedRoute);

  email = '';
  password = '';

  readonly emailError = signal('');
  readonly pwError = signal('');
  readonly formError = signal('');
  readonly submitting = signal(false);
  readonly googleSubmitting = signal(false);
  readonly microsoftSubmitting = signal(false);
  readonly resetSending = signal(false);
  readonly resetMsg = signal('');
  // Shown when the user landed here after an idle auto sign-out.
  readonly notice = signal('');

  private emailRef = viewChild<ElementRef<HTMLInputElement>>('emailInp');
  private pwRef = viewChild<ElementRef<HTMLInputElement>>('pwInp');

  constructor() {
    if (this.route.snapshot.queryParamMap.get('reason') === 'timeout') {
      this.notice.set('You were signed out after 30 minutes of inactivity. Please sign in again.');
    }
  }

  // Submit is enabled only when both fields are filled + the email is valid.
  get formValid(): boolean {
    return isValidEmail(this.email) && !!this.password;
  }

  onEmailBlur(): void {
    const v = this.email.trim();
    if (v && !isValidEmail(v)) this.emailError.set('Please enter a valid email address.');
    else this.emailError.set('');
  }

  onEmailInput(): void {
    if (this.emailError()) this.emailError.set('');
    this.formError.set('');
  }

  onPwInput(): void {
    if (this.pwError()) this.pwError.set('');
    this.formError.set('');
  }

  submit(): void {
    let ok = true;
    const email = this.email.trim();
    const pw = this.password;

    if (!email || !isValidEmail(email)) {
      this.emailError.set(!email ? 'Email is required.' : 'Please enter a valid email address.');
      ok = false;
    } else {
      this.emailError.set('');
    }
    if (!pw) {
      this.pwError.set('Password is required.');
      ok = false;
    } else {
      this.pwError.set('');
    }

    if (!ok) {
      if (this.emailError()) this.emailRef()?.nativeElement.focus();
      else if (this.pwError()) this.pwRef()?.nativeElement.focus();
      return;
    }

    this.submitting.set(true);
    this.auth
      .signIn(email, pw)
      .then(() => this.completeSignIn())
      .catch((err: Error) => {
        this.formError.set(err?.message || 'Sign-in failed. Check your credentials and try again.');
        this.submitting.set(false);
      });
  }

  // Google sign-in (popup). Same invite-only provisioning gate as email/password
  // — AuthService rejects an account that has no partners/{uid} profile.
  signInWithGoogle(): void {
    this.formError.set('');
    this.googleSubmitting.set(true);
    this.auth
      .signInWithGoogle()
      .then(() => this.completeSignIn())
      .catch((err: Error) => {
        this.formError.set(err?.message || 'Google sign-in failed. Please try again.');
        this.googleSubmitting.set(false);
      });
  }

  // Microsoft sign-in (popup). Same invite-only provisioning gate as the others.
  signInWithMicrosoft(): void {
    this.formError.set('');
    this.microsoftSubmitting.set(true);
    this.auth
      .signInWithMicrosoft()
      .then(() => this.completeSignIn())
      .catch((err: Error) => {
        this.formError.set(err?.message || 'Microsoft sign-in failed. Please try again.');
        this.microsoftSubmitting.set(false);
      });
  }

  // Send a password reset / set-password email to the address in the email field.
  forgotPassword(): void {
    const email = this.email.trim();
    if (!email || !isValidEmail(email)) {
      this.emailError.set('Enter your email above first, then click “Forgot password?”.');
      this.emailRef()?.nativeElement.focus();
      return;
    }
    this.formError.set('');
    this.resetMsg.set('');
    this.resetSending.set(true);
    this.auth
      .sendPasswordReset(email)
      .then(() => {
        this.resetMsg.set(`If an account exists for ${email}, a password reset email is on its way.`);
      })
      .catch((err: Error) => {
        this.formError.set(err?.message || 'Could not send the reset email. Please try again.');
      })
      .finally(() => this.resetSending.set(false));
  }

  // Route to the role's home. Auth state is managed entirely by the Firebase
  // SDK and persisted to sessionStorage (session-scoped persistence set in
  // app.config.ts), so the sign-in clears when the browser window is closed.
  private completeSignIn(): void {
    // Admins land on the admin console (their dashboard); partners on theirs.
    this.router.navigateByUrl(this.auth.isAdmin() ? '/admin' : '/dashboard');
  }
}
