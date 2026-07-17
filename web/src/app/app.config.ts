import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { PreloadAllModules, provideRouter, withInMemoryScrolling, withPreloading } from '@angular/router';
import { initializeApp, provideFirebaseApp } from '@angular/fire/app';
import { browserSessionPersistence, getAuth, provideAuth, setPersistence } from '@angular/fire/auth';
import { getFirestore, provideFirestore } from '@angular/fire/firestore';
import { getFunctions, provideFunctions } from '@angular/fire/functions';

import { routes } from './app.routes';
import { environment } from '../environments/environment';

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(
      routes,
      withInMemoryScrolling({ scrollPositionRestoration: 'top' }),
      // Fetch the lazy page chunks in the background after first render, so the
      // first navigation to each page doesn't stall on a chunk download.
      withPreloading(PreloadAllModules),
    ),
    provideFirebaseApp(() => initializeApp(environment.firebase)),
    provideAuth(() => {
      const auth = getAuth();
      // Session-scoped persistence: the sign-in is dropped when the browser
      // window is closed (backed by sessionStorage), so a walk-away on a shared
      // machine can't be resumed by simply reopening the browser. It survives
      // page reloads within the same tab. Paired with the idle timeout in
      // SessionTimeoutService for defence in depth. setPersistence resolves long
      // before any sign-in, so we don't need to await it here.
      setPersistence(auth, browserSessionPersistence).catch(() => {
        /* sessionStorage unavailable (e.g. hardened privacy mode) — Firebase
           falls back to in-memory persistence, which is even shorter-lived. */
      });
      return auth;
    }),
    provideFirestore(() => getFirestore()),
    provideFunctions(() => getFunctions()),
  ],
};
