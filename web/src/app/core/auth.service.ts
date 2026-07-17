import { Injectable, inject, signal } from '@angular/core';
import {
  Auth,
  User,
  UserCredential,
  GoogleAuthProvider,
  OAuthProvider,
  EmailAuthProvider,
  signInWithEmailAndPassword,
  signInWithPopup,
  sendPasswordResetEmail,
  verifyPasswordResetCode,
  confirmPasswordReset,
  linkWithPopup,
  linkWithCredential,
  reauthenticateWithPopup,
  reauthenticateWithCredential,
  reload,
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
    case 'auth/popup-closed-by-user':
    case 'auth/cancelled-popup-request':
      return 'Sign-in was cancelled.';
    case 'auth/popup-blocked':
      return 'Your browser blocked the sign-in popup. Allow popups for this site and try again.';
    case 'auth/account-exists-with-different-credential':
      return 'An account already exists with this email using a different sign-in method.';
    case 'auth/credential-already-in-use':
    case 'auth/email-already-in-use':
      return 'This Google account (or email) is already connected to another portal account.';
    case 'auth/provider-already-linked':
      return 'That sign-in method is already connected to this account.';
    case 'auth/requires-recent-login':
      return 'For your security, please re-authenticate, then try again.';
    case 'auth/weak-password':
      return 'Choose a stronger password (at least 6 characters).';
    case 'auth/user-mismatch':
      return 'That account doesn’t match the one you’re signed in to.';
    case 'auth/operation-not-allowed':
      return 'This sign-in method isn’t enabled. Turn it on in Firebase Console → Authentication → Sign-in method.';
    case 'auth/unauthorized-domain':
      return 'This site isn’t an authorized sign-in domain. Add it in Firebase Console → Authentication → Settings → Authorized domains.';
    case 'auth/configuration-not-found':
      return 'Authentication isn’t fully set up for this project yet (check Firebase Console → Authentication).';
    case 'auth/internal-error':
      return 'The sign-in service hit an internal error. Please try again in a moment.';
    case 'auth/network-request-failed':
      return 'Network error. Check your connection and try again.';
    default:
      return 'Sign-in failed. Check your credentials and try again.';
  }
}

// Like friendlyAuthError, but returns an Error that PRESERVES the original
// Firebase error code (on `.code`), so callers can branch on specific cases —
// notably 'auth/requires-recent-login', which triggers the re-auth UI.
function authError(err: unknown): Error {
  const e = new Error(friendlyAuthError(err)) as Error & { code?: string };
  e.code = (err as { code?: string })?.code;
  return e;
}

// Microsoft (Azure AD) sign-in. Firebase identifies the provider by this id; the
// same OAuthProvider drives sign-in, account linking and re-authentication.
const MICROSOFT_PROVIDER_ID = 'microsoft.com';
function microsoftProvider(): OAuthProvider {
  const provider = new OAuthProvider(MICROSOFT_PROVIDER_ID);
  // Always let the user choose the account (helps people who have both a
  // work/school and a personal Microsoft account).
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private auth = inject(Auth);
  private db = inject(Firestore);

  // Cached partners/{uid} doc + admin flag for the current session.
  private partnerCache: Partner | null = null;
  private adminCache = false;
  // True when the LAST partner-profile read threw (network/offline) rather
  // than resolving "no doc". Guards must not treat that as unprovisioned and
  // sign the user out.
  private partnerLoadError = false;

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
        this.partnerLoadError = false;
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

  // The last loadPartner() attempt failed to READ (as opposed to the profile
  // genuinely not existing).
  partnerLoadFailed(): boolean {
    return this.partnerLoadError;
  }

  // Load + cache partners/{uid}; also resolves the admin flag. A read failure
  // (network/offline) keeps the previous cache and rethrows — it must never be
  // mistaken for "not provisioned".
  async loadPartner(uid: string): Promise<Partner | null> {
    let snap;
    try {
      snap = await getDoc(doc(this.db, 'partners', uid));
    } catch (err) {
      console.warn('[AuthService] loadPartner failed:', (err as Error)?.message);
      this.partnerLoadError = true;
      throw new Error('Could not load your partner profile. Check your connection and try again.');
    }
    this.partnerLoadError = false;
    const data = snap.exists() ? (snap.data() as Partner) : null;
    this.partnerCache = data;
    this.adminCache = !!(data && data.role === 'admin');
    this.partner.set(data);
    return data;
  }

  // Sign in via Firebase Auth (email/password), then enforce provisioning.
  async signIn(email: string, password: string): Promise<LoginResult> {
    let cred: UserCredential;
    try {
      cred = await signInWithEmailAndPassword(this.auth, email, password);
    } catch (err) {
      // Log the raw Firebase code so failures are diagnosable (the UI only
      // shows the friendly text).
      console.error('[auth] sign-in failed:', (err as { code?: string })?.code, err);
      throw new Error(friendlyAuthError(err));
    }
    return this.finishSignIn(cred);
  }

  // Sign in with Google (popup), then enforce provisioning. The portal is
  // invite-only, so a Google account with no admin-created partners/{uid}
  // profile is signed back out and rejected (see finishSignIn).
  async signInWithGoogle(): Promise<LoginResult> {
    let cred: UserCredential;
    try {
      cred = await signInWithPopup(this.auth, new GoogleAuthProvider());
    } catch (err) {
      // Log the raw Firebase code so failures are diagnosable (the UI only
      // shows the friendly text).
      console.error('[auth] sign-in failed:', (err as { code?: string })?.code, err);
      throw new Error(friendlyAuthError(err));
    }
    return this.finishSignIn(cred);
  }

  // Sign in with Microsoft (Azure AD, popup), then enforce provisioning. Same
  // invite-only gate as Google — an account with no admin-created partners/{uid}
  // profile is signed back out and rejected (see finishSignIn).
  async signInWithMicrosoft(): Promise<LoginResult> {
    let cred: UserCredential;
    try {
      cred = await signInWithPopup(this.auth, microsoftProvider());
    } catch (err) {
      // Log the raw Firebase code so failures are diagnosable (the UI only
      // shows the friendly text).
      console.error('[auth] sign-in failed:', (err as { code?: string })?.code, err);
      throw new Error(friendlyAuthError(err));
    }
    return this.finishSignIn(cred);
  }

  // Send Firebase's built-in password-reset email. Doubles as a "set your
  // password" email for an account that has none yet (clicking the link adds a
  // password credential). Safe for any address — Firebase doesn't reveal whether
  // the account exists.
  async sendPasswordReset(email: string): Promise<void> {
    try {
      await sendPasswordResetEmail(this.auth, email);
    } catch (err) {
      throw new Error(friendlyAuthError(err));
    }
  }

  // Verify a password-reset code (oobCode from the emailed link). Resolves with
  // the account's email when the code is valid; rejects with a friendly message
  // when it's invalid or expired. Backs the custom /auth/action reset page.
  async verifyResetCode(code: string): Promise<string> {
    try {
      return await verifyPasswordResetCode(this.auth, code);
    } catch (err) {
      throw authError(err);
    }
  }

  // Complete a password reset — sets the new password for the account the code
  // belongs to. Does NOT sign the user in as a side effect.
  async confirmReset(code: string, newPassword: string): Promise<void> {
    try {
      await confirmPasswordReset(this.auth, code, newPassword);
    } catch (err) {
      throw authError(err);
    }
  }

  // Shared post-sign-in step: load the partners/{uid} profile and gate on it.
  // No profile -> the account was never provisioned by an admin: sign out and
  // reject so it can't reach any portal page. The portal allows no self-signup,
  // regardless of sign-in method (firestore.rules enforces the same gate
  // server-side via isPartner()).
  private async finishSignIn(cred: UserCredential): Promise<LoginResult> {
    let partner: Partner | null;
    try {
      partner = await this.loadPartner(cred.user.uid);
    } catch {
      // Transient read failure — NOT "unprovisioned". Don't keep a session we
      // can't verify, but tell the user the truth so they just retry.
      await this.signOut();
      throw new Error('Could not load your partner profile. Check your connection and try again.');
    }
    if (!partner) {
      await this.signOut();
      throw new Error(
        "This account isn't set up for the Partner Portal yet. Please contact your partner manager.",
      );
    }
    return {
      partner: {
        name: partner.name || cred.user.displayName || '',
        track: partner.track || '',
      },
    };
  }

  async signOut(): Promise<void> {
    await fbSignOut(this.auth);
    this.partnerCache = null;
    this.adminCache = false;
    this.partnerLoadError = false;
    this.partner.set(null);
  }

  // Resolve once the first auth state is known. When signed in, the partner
  // doc is loaded + cached before resolving — guards/pages need it synchronously.
  // A profile READ failure resolves anyway (partnerLoadFailed() is set); guards
  // handle it without signing the user out.
  // The cached profile is reused on subsequent calls: guards run this on EVERY
  // navigation, and refetching partners/{uid} each time would block every route
  // change on a Firestore round trip. The cache is cleared on sign-out and a
  // failed load leaves it empty, so a retry still hits the network.
  authReady(): Promise<User | null> {
    return new Promise((resolve) => {
      const unsub = onAuthStateChanged(this.auth, async (u) => {
        unsub();
        if (u && !this.partnerCache) await this.loadPartner(u.uid).catch(() => null);
        resolve(u);
      });
    });
  }

  /* ---- Account linking: let ONE user keep BOTH password and Google ---- */
  /* All of these operate on this.auth.currentUser, so the UID never changes —
   * the partners/{uid} profile and the invite-only gate stay valid. */

  // Which sign-in methods are linked to the current account (+ its email).
  linkedProviders(): { google: boolean; microsoft: boolean; password: boolean; email: string | null } {
    const pd = this.auth.currentUser?.providerData ?? [];
    return {
      google: pd.some((p) => p.providerId === GoogleAuthProvider.PROVIDER_ID),
      microsoft: pd.some((p) => p.providerId === MICROSOFT_PROVIDER_ID),
      password: pd.some((p) => p.providerId === EmailAuthProvider.PROVIDER_ID),
      email: this.auth.currentUser?.email ?? null,
    };
  }

  // Reload the Firebase user so providerData/email reflect the latest links.
  async refreshUser(): Promise<void> {
    const user = this.auth.currentUser;
    if (user) await reload(user);
    this.user.set(this.auth.currentUser);
  }

  // Link Google to the signed-in account. Call directly from a click — the
  // popup needs a user gesture.
  async linkGoogle(): Promise<void> {
    const user = this.auth.currentUser;
    if (!user) throw new Error('Please sign in first, then connect Google.');
    if (user.providerData.some((p) => p.providerId === GoogleAuthProvider.PROVIDER_ID)) {
      throw new Error('Google is already connected to this account.');
    }
    try {
      await linkWithPopup(user, new GoogleAuthProvider());
    } catch (err) {
      throw authError(err);
    }
    await this.refreshUser();
  }

  // Link Microsoft to the signed-in account. Call directly from a click — the
  // popup needs a user gesture.
  async linkMicrosoft(): Promise<void> {
    const user = this.auth.currentUser;
    if (!user) throw new Error('Please sign in first, then connect Microsoft.');
    if (user.providerData.some((p) => p.providerId === MICROSOFT_PROVIDER_ID)) {
      throw new Error('Microsoft is already connected to this account.');
    }
    try {
      await linkWithPopup(user, microsoftProvider());
    } catch (err) {
      throw authError(err);
    }
    await this.refreshUser();
  }

  // Add an email/password credential to a Google-only account, reusing the
  // account's existing email so no new email is collected.
  async addPassword(password: string): Promise<void> {
    const user = this.auth.currentUser;
    if (!user) throw new Error('Please sign in first.');
    if (user.providerData.some((p) => p.providerId === EmailAuthProvider.PROVIDER_ID)) {
      throw new Error('A password is already set on this account.');
    }
    const email = user.email;
    if (!email) throw new Error('This account has no email to attach a password to.');
    if (password.length < 6) throw new Error('Choose a password with at least 6 characters.');
    try {
      await linkWithCredential(user, EmailAuthProvider.credential(email, password));
    } catch (err) {
      throw authError(err);
    }
    await this.refreshUser();
  }

  // Re-authenticate with Google (remedy for 'auth/requires-recent-login').
  async reauthGoogle(): Promise<void> {
    const user = this.auth.currentUser;
    if (!user) throw new Error('Please sign in first.');
    try {
      await reauthenticateWithPopup(user, new GoogleAuthProvider());
    } catch (err) {
      throw authError(err);
    }
  }

  // Re-authenticate with Microsoft (remedy for 'auth/requires-recent-login').
  async reauthMicrosoft(): Promise<void> {
    const user = this.auth.currentUser;
    if (!user) throw new Error('Please sign in first.');
    try {
      await reauthenticateWithPopup(user, microsoftProvider());
    } catch (err) {
      throw authError(err);
    }
  }

  // Re-authenticate with the current password (remedy for requires-recent-login).
  async reauthPassword(password: string): Promise<void> {
    const user = this.auth.currentUser;
    if (!user || !user.email) throw new Error('Please sign in first.');
    try {
      await reauthenticateWithCredential(user, EmailAuthProvider.credential(user.email, password));
    } catch (err) {
      throw authError(err);
    }
  }
}
