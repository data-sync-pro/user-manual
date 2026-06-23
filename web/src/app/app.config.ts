import { ApplicationConfig, provideZoneChangeDetection } from '@angular/core';
import { provideRouter, withInMemoryScrolling } from '@angular/router';
import { initializeApp, provideFirebaseApp } from '@angular/fire/app';
import {
  getAuth,
  provideAuth,
  connectAuthEmulator,
} from '@angular/fire/auth';
import {
  getFirestore,
  provideFirestore,
  connectFirestoreEmulator,
} from '@angular/fire/firestore';

import { routes } from './app.routes';
import { environment } from '../environments/environment';

// Connect to the local emulator suite when running on localhost (parity with
// the original firebase-config.js behavior).
const useEmulator = () =>
  typeof location !== 'undefined' &&
  (location.hostname === 'localhost' || location.hostname === '127.0.0.1');

export const appConfig: ApplicationConfig = {
  providers: [
    provideZoneChangeDetection({ eventCoalescing: true }),
    provideRouter(routes, withInMemoryScrolling({ scrollPositionRestoration: 'top' })),
    provideFirebaseApp(() => initializeApp(environment.firebase)),
    provideAuth(() => {
      const auth = getAuth();
      if (useEmulator()) {
        connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
      }
      return auth;
    }),
    provideFirestore(() => {
      const db = getFirestore();
      if (useEmulator()) {
        connectFirestoreEmulator(db, '127.0.0.1', 8080);
      }
      return db;
    }),
  ],
};
