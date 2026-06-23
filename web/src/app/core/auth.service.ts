import { Injectable, inject, signal } from '@angular/core';
import {
  Auth,
  User,
  signInWithEmailAndPassword,
  signOut as fbSignOut,
  onAuthStateChanged,
} from '@angular/fire/auth';
import { Firestore, doc, getDoc } from '@angular/fire/firestore';
import { LoginResult, Partner } from './models';

// Friendly auth error messages keyed off Firebase error codes.
function friendlyAuthError(err: unknown): string {
  const code = (err as { code?: string })?.code || '';
  switch (code) {
    case 'auth/wrong-password':
    case 'auth/invalid-credential':
    case 'auth/user-not-found':
      return 'Incorrect email or password. Please try again.';
    case 'auth/invalid-email':
      return 'Please enter a valid email address.';
    case 'auth/too-many-requests':
      return 'Too many attempts. Please wait a moment and try again.';
    case 'auth/user-disabled':
      return 'This account has been disabled. Contact your partner manager.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    default:
      return 'Sign-in failed. Check your credentials and try again.';
  }
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private auth = inject(Auth);
  private db = inject(Firestore);

  // Cached partners/{uid} doc + admin flag for the current session.
  private partnerCache: Partner | null = null;
  private adminCache = false;

  // Reactive copies for templates (the cache stays the source of truth for
  // synchronous reads from services/guards).
  readonly user = signal<User | null>(null);
  readonly partner = signal<Partner | null>(null);

  constructor() {
    onAuthStateChanged(this.auth, (u) => {
      this.user.set(u);
      if (!u) {
        this.partnerCache = null;
        this.adminCache = false;
        this.partner.set(null);
      }
    });
  }

  currentUser(): User | null {
    return this.auth.currentUser;
  }

  currentPartner(): Partner | null {
    return this.partnerCache;
  }

  isAdmin(): boolean {
    return this.adminCache;
  }

  // Load + cache partners/{uid}; also resolves the admin flag.
  async loadPartner(uid: string): Promise<Partner | null> {
    try {
      const snap = await getDoc(doc(this.db, 'partners', uid));
      const data = snap.exists() ? (snap.data() as Partner) : null;
      this.partnerCache = data;
      this.adminCache = !!(data && data.role === 'admin');
      this.partner.set(data);
      return data;
    } catch (err) {
      console.warn('[AuthService] loadPartner failed:', (err as Error)?.message);
      this.partnerCache = null;
      this.adminCache = false;
      this.partner.set(null);
      return null;
    }
  }

  // Sign in via Firebase Auth, load partners/{uid}, return an id token +
  // minimal partner summary. Rejects with a friendly message.
  async signIn(email: string, password: string): Promise<LoginResult> {
    try {
      const cred = await signInWithEmailAndPassword(this.auth, email, password);
      const token = await cred.user.getIdToken();
      const partner = (await this.loadPartner(cred.user.uid)) || {};
      return {
        token,
        partner: {
          name: partner.name || cred.user.displayName || '',
          track: partner.track || '',
        },
      };
    } catch (err) {
      throw new Error(friendlyAuthError(err));
    }
  }

  async signOut(): Promise<void> {
    await fbSignOut(this.auth);
    this.partnerCache = null;
    this.adminCache = false;
    this.partner.set(null);
  }

  // Resolve once the first auth state is known. When signed in, the partner
  // doc is loaded + cached before resolving — guards/pages need it synchronously.
  authReady(): Promise<User | null> {
    return new Promise((resolve) => {
      const unsub = onAuthStateChanged(this.auth, async (u) => {
        unsub();
        if (u) await this.loadPartner(u.uid);
        resolve(u);
      });
    });
  }
}
