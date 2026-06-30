import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from './auth.service';

// Central auth guards — mirror the original <body data-auth="..."> logic.
// They wait for the first auth state (and partner doc) to resolve before
// deciding, so Firestore-backed pages always have the user + profile ready.

// The home page for a signed-in user: admins land on the admin console (which
// IS their dashboard); partners land on their own dashboard.
const homeFor = (auth: AuthService): string => (auth.isAdmin() ? '/admin' : '/dashboard');

// Invite-only gate: an authenticated user must have an admin-provisioned
// partners/{uid} profile. authReady() has already loaded it, so this just reads
// the cache. If absent, sign the user out — this blocks accounts that were
// never provisioned (e.g. an arbitrary Google sign-in) and breaks the
// guest -> home redirect loop, since after sign-out the guest guard lets them
// reach the login page.
const isProvisioned = async (auth: AuthService): Promise<boolean> => {
  if (auth.currentPartner()) return true;
  await auth.signOut();
  return false;
};

// guest: login page. If already signed in AND provisioned, bounce to the role's
// home. A signed-in-but-unprovisioned user is signed out and left on login.
export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = await auth.authReady();
  if (user && (await isProvisioned(auth))) {
    router.navigateByUrl(homeFor(auth));
    return false;
  }
  return true;
};

// required: any authenticated partner page. Unauthenticated or unprovisioned -> login.
export const requiredGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = await auth.authReady();
  if (!user || !(await isProvisioned(auth))) {
    router.navigateByUrl('/login');
    return false;
  }
  return true;
};

// dashboard: authenticated + provisioned. An admin's dashboard IS the admin
// console, so send admins to /admin — UNLESS they're viewing a specific
// partner's dashboard (/dashboard?as=<uid>), which the admin view mode supports.
export const dashboardGuard: CanActivateFn = async (route) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = await auth.authReady();
  if (!user || !(await isProvisioned(auth))) {
    router.navigateByUrl('/login');
    return false;
  }
  if (auth.isAdmin() && !route.queryParamMap.get('as')) {
    router.navigateByUrl('/admin');
    return false;
  }
  return true;
};

// admin: admin-only page. Unauthenticated/unprovisioned -> login; non-admin -> dashboard.
export const adminGuard: CanActivateFn = async () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  const user = await auth.authReady();
  if (!user || !(await isProvisioned(auth))) {
    router.navigateByUrl('/login');
    return false;
  }
  if (!auth.isAdmin()) {
    router.navigateByUrl('/dashboard');
    return false;
  }
  return true;
};
