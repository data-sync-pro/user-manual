import { Component, ElementRef, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
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

  email = '';
  password = '';

  readonly emailError = signal('');
  readonly pwError = signal('');
  readonly formError = signal('');
  readonly submitting = signal(false);

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
      .then((res) => {
        if (res && res.token) {
          try {
            sessionStorage.setItem('portal.session', JSON.stringify(res));
          } catch {
            /* ignore */
          }
          this.router.navigateByUrl('/dashboard');
        } else {
          throw new Error('No token returned');
        }
      })
      .catch((err: Error) => {
        this.formError.set(err?.message || 'Sign-in failed. Check your credentials and try again.');
        this.submitting.set(false);
      });
  }
}
