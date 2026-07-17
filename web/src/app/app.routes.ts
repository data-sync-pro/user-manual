import { Routes } from '@angular/router';
import { guestGuard, requiredGuard, dashboardGuard, adminGuard } from './core/guards';

export const routes: Routes = [
  { path: '', pathMatch: 'full', redirectTo: 'login' },
  {
    path: 'login',
    canActivate: [guestGuard],
    loadComponent: () =>
      import('./pages/login/login.component').then((m) => m.LoginComponent),
  },
  {
    // Firebase email-action handler target (password reset). Public + no guard:
    // the user arrives here signed-out, holding a one-time code from the email.
    path: 'auth/action',
    loadComponent: () =>
      import('./pages/reset-password/reset-password.component').then((m) => m.ResetPasswordComponent),
  },
  {
    path: 'dashboard',
    canActivate: [dashboardGuard],
    loadComponent: () =>
      import('./pages/dashboard/dashboard.component').then((m) => m.DashboardComponent),
  },
  {
    path: 'deal-registration',
    canActivate: [requiredGuard],
    loadComponent: () =>
      import('./pages/deal-registration/deal-registration.component').then(
        (m) => m.DealRegistrationComponent,
      ),
  },
  {
    path: 'admin',
    canActivate: [adminGuard],
    loadComponent: () =>
      import('./pages/admin/admin.component').then((m) => m.AdminComponent),
  },
  {
    path: 'account',
    canActivate: [requiredGuard],
    loadComponent: () =>
      import('./pages/account/account.component').then((m) => m.AccountComponent),
  },
  { path: '**', redirectTo: 'login' },
];
