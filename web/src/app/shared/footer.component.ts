import { Component, Input, inject } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { AuthService } from '../core/auth.service';
import { ReportIssueComponent } from './report-issue.component';

// Shared footer with the three layouts the original site used:
//   'login' — slim, no sign-out link
//   'dash'  — slim, with an inline sign-out link
//   'full'  — full brand + link-column grid (admin, deal registration)
@Component({
  selector: 'app-footer',
  standalone: true,
  imports: [RouterLink, ReportIssueComponent],
  templateUrl: './footer.component.html',
})
export class FooterComponent {
  @Input() variant: 'login' | 'dash' | 'full' = 'full';

  private auth = inject(AuthService);
  private router = inject(Router);

  signOut(e: Event): void {
    e.preventDefault();
    this.auth
      .signOut()
      .then(() => this.router.navigateByUrl('/login'))
      .catch(() => this.router.navigateByUrl('/login'));
  }
}
