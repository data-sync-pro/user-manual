import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { SessionTimeoutService } from './core/session-timeout.service';

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet],
  template: '<router-outlet></router-outlet>',
})
export class AppComponent {
  // Inject the idle-timeout watcher so it's created at app startup; it arms
  // itself whenever a user is signed in (see SessionTimeoutService).
  private readonly sessionTimeout = inject(SessionTimeoutService);
}
