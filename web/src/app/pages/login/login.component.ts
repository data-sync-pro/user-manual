import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { isValidEmail } from '../../core/validators';
import { LoginResult } from '../../core/models';
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

  email = '';
  password = '';

  readonly emailError = signal('');
  readonly pwError = signal('');
  readonly formError = signal('');
  readonly submitting = signal(false);
  readonly googleSubmitting = signal(false);
  readonly resetSending = signal(false);
  readonly resetMsg = signal('');

  private emailRef = viewChild<ElementRef<HTMLInputElement>>('emailInp');
  private pwRef = viewChild<ElementRef<HTMLInputElement>>('pwInp');

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
      .then((res) => this.completeSignIn(res))
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
      .then((res) => this.completeSignIn(res))
      .catch((err: Error) => {
        this.formError.set(err?.message || 'Google sign-in failed. Please try again.');
        this.googleSubmitting.set(false);
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

  // Persist the session summary and route to the role's home.
  private completeSignIn(res: LoginResult): void {
    if (!res || !res.token) {
      this.formError.set('Sign-in failed. Please try again.');
      this.submitting.set(false);
      this.googleSubmitting.set(false);
      return;
    }
    try {
      sessionStorage.setItem('portal.session', JSON.stringify(res));
    } catch {
      /* ignore */
    }
    // Admins land on the admin console (their dashboard); partners on theirs.
    this.router.navigateByUrl(this.auth.isAdmin() ? '/admin' : '/dashboard');
  }
}
