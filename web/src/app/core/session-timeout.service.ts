import { DOCUMENT } from '@angular/common';
import { Injectable, NgZone, effect, inject } from '@angular/core';
import { Router } from '@angular/router';
import { AuthService } from './auth.service';

// Idle auto sign-out. While a user is signed in, any lull longer than IDLE_MS
// with no pointer/keyboard/touch activity signs them out and sends them to
// /login?reason=timeout. This complements the session-scoped persistence set in
// app.config.ts: persistence covers "closed the browser", this covers "walked
// away with the tab still open". Purely client-side — a determined holder of a
// live token isn't stopped by this, but a walk-away on a shared machine is.
@Injectable({ providedIn: 'root' })
export class SessionTimeoutService {
  private auth = inject(AuthService);
  private router = inject(Router);
  private zone = inject(NgZone);
  private doc = inject(DOCUMENT);

  // Sign out after this much inactivity.
  private readonly IDLE_MS = 30 * 60 * 1000;
  // Coalesce high-frequency events (mousemove/scroll) — reset at most this often.
  private readonly RESET_THROTTLE_MS = 1000;
  // Events that prove the user is still around.
  private readonly ACTIVITY_EVENTS = [
    'mousemove',
    'mousedown',
    'keydown',
    'scroll',
    'touchstart',
    'click',
  ] as const;

  private timer: ReturnType<typeof setTimeout> | null = null;
  private lastReset = 0;
  private armed = false;
  private readonly onActivity = (): void => this.reset();

  constructor() {
    // Arm while signed in, disarm on sign-out. Reads the reactive user signal so
    // it tracks login/logout without a manual subscription.
    effect(() => {
      if (this.auth.user()) this.arm();
      else this.disarm();
    });
  }

  private arm(): void {
    if (this.armed) return;
    this.armed = true;
    // Listen outside Angular so a moving mouse doesn't trigger change detection.
    this.zone.runOutsideAngular(() => {
      for (const ev of this.ACTIVITY_EVENTS) {
        this.doc.addEventListener(ev, this.onActivity, { passive: true });
      }
    });
    this.lastReset = 0;
    // Force the first countdown even if the page just loaded (performance.now()
    // may still be < RESET_THROTTLE_MS when a persisted session restores).
    this.reset(true);
  }

  private disarm(): void {
    if (!this.armed) return;
    this.armed = false;
    for (const ev of this.ACTIVITY_EVENTS) {
      this.doc.removeEventListener(ev, this.onActivity);
    }
    this.clear();
  }

  // Restart the idle countdown. Throttled so we're not clearing/setting a timer
  // on every mousemove; pass force to bypass the throttle (used when arming).
  private reset(force = false): void {
    const now = this.nowMs();
    if (!force && now - this.lastReset < this.RESET_THROTTLE_MS) return;
    this.lastReset = now;
    this.clear();
    this.zone.runOutsideAngular(() => {
      this.timer = setTimeout(() => this.zone.run(() => this.expire()), this.IDLE_MS);
    });
  }

  private clear(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private expire(): void {
    if (!this.auth.user()) return;
    this.disarm();
    this.auth
      .signOut()
      .catch(() => {
        /* sign-out is best-effort — route to login regardless */
      })
      .finally(() => {
        this.router.navigate(['/login'], { queryParams: { reason: 'timeout' } });
      });
  }

  // performance.now() when available (monotonic, immune to clock changes),
  // falling back to Date-based timing in exotic environments.
  private nowMs(): number {
    const perf = this.doc.defaultView?.performance;
    return perf ? perf.now() : new Date().getTime();
  }
}
