import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

// Central auth guards — mirror the original <body data-auth="..."> logic.
// They wait for the first auth state (and partner doc) to resolve before
// deciding, so Firestore-backed pages always have the user + profile ready.

// guest: login page. If already signed in, bounce to the dashboard.
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = await auth.authReady();
  if (user) {
    router.navigateByUrl('/dashboard');
    return false;
  }
  return true;
};

// required: any authenticated partner page. Unauthenticated -> login.
export const requiredGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = await auth.authReady();
  if (!user) {
    router.navigateByUrl('/login');
    return false;
  }
  return true;
};

// admin: admin-only page. Unauthenticated -> login; non-admin -> dashboard.
export const adminGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = await auth.authReady();
  if (!user) {
    router.navigateByUrl('/login');
    return false;
  }
  if (!auth.isAdmin()) {
    router.navigateByUrl('/dashboard');
    return false;
  }
  return true;
};
