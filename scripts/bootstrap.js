/**
 * Provision a Partner Portal user (admin or partner) in the LIVE project.
 *
 * Creates/updates the Firebase Auth account AND its partners/{uid} profile in
 * one step, and — by default — AUTO-SENDS Firebase's built-in "set your password"
 * email so the user picks their own password and signs in. No plaintext password
 * to pass around, no SMTP to set up.
 *
 * IMPORTANT: Firebase only emails password-reset / set-password links to accounts
 * that HAVE a password (a Google-only or passwordless account gets NO email). So a
 * brand-new self-service account is created WITH a throwaway password it never
 * sees — the emailed link lets them set their own. The same email also works if
 * they instead "Sign in with Google" (Google links to this email, same UID).
 *
 *  - default (no --password): account gets a throwaway password + an auto-sent
 *    "set your password" email. User sets their own / or uses Google.
 *  - --password / --gen-password: set a password you'll share yourself; no email.
 *  - --no-email: don't auto-send (email-only account; you handle access).
 *
 * Setup (one time):
 *   Firebase Console -> Project settings (gear) -> Service accounts ->
 *   "Generate new private key". Save it as scripts/serviceAccountKey.json
 *   (gitignored), OR set GOOGLE_APPLICATION_CREDENTIALS to its path.
 *
 * Examples:
 *   # Partner, self-service (auto-sends a set-password email):
 *   node scripts/bootstrap.js --email jane@acme.com --name "Jane" --role partner
 *   # Admin with a password you choose (nothing emailed):
 *   node scripts/bootstrap.js --email you@co.com --name "You" --role admin --password "Secret123"
 *
 * Needs Node 18+ (global fetch). Safe + re-runnable; never deletes anything.
 */
const admin = require('firebase-admin');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// Public Firebase Web API key (safe to commit) — only used to trigger Firebase's
// built-in set-password email via the Identity Toolkit REST API.
const WEB_API_KEY = 'AIzaSyDEOfMuiM7-TIyYkb28fG0T9v-YThC_Bls';

// ---- tiny --flag parser (a flag with no value won't swallow the next flag) ----
function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  const v = i !== -1 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : fallback;
}
const hasFlag = (name) => process.argv.includes(`--${name}`);
const genPw = () => crypto.randomBytes(9).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 11) + 'A9!';

const email = arg('email');
const name = arg('name', '');
const role = arg('role', 'partner'); // 'admin' | 'partner'
const noEmail = hasFlag('no-email');
const seedAnnouncement = hasFlag('announce');

// A password the ADMIN will share themselves (--password or --gen-password).
let sharePw = arg('password');
if (!sharePw && hasFlag('gen-password')) sharePw = genPw();
if (sharePw && sharePw.length < 6) {
  console.error('Password must be at least 6 characters.');
  process.exit(1);
}

// Self-service = no shared password and emails allowed: the user sets their own
// password via an emailed link.
const selfService = !sharePw && !noEmail;

if (!email) {
  console.error(
    'Usage: node scripts/bootstrap.js --email <email> [--name "Name"] [--role admin|partner]\n' +
      '       [--password <pw> | --gen-password] [--no-email] [--announce]',
  );
  process.exit(1);
}

// ---- credentials: scripts/serviceAccountKey.json or GOOGLE_APPLICATION_CREDENTIALS ----
const keyPath = path.resolve(__dirname, 'serviceAccountKey.json');
if (fs.existsSync(keyPath)) {
  admin.initializeApp({ credential: admin.credential.cert(require(keyPath)) });
} else if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
  admin.initializeApp(); // picks up Application Default Credentials from the env var
} else {
  console.error(
    'No credentials found. Download a service account key (Firebase Console -> Project ' +
      'settings -> Service accounts -> Generate new private key) and save it as ' +
      'scripts/serviceAccountKey.json, or set GOOGLE_APPLICATION_CREDENTIALS to its path.',
  );
  process.exit(1);
}

const auth = admin.auth();
const db = admin.firestore();

// Find the account by email; create it if missing. Returns { user, created }.
async function resolveUser() {
  try {
    const existing = await auth.getUserByEmail(email);
    if (sharePw) {
      // Set/replace the password so email+password sign-in works (kept alongside
      // Google if present — same UID).
      await auth.updateUser(existing.uid, {
        password: sharePw,
        displayName: name || existing.displayName || undefined,
      });
      console.log(`✓ existing account ${email}: password set`);
    } else {
      console.log(`• account ${email} already exists; sign-in methods unchanged`);
    }
    return { user: existing, created: false };
  } catch (e) {
    if (e.code !== 'auth/user-not-found') throw e;
    // New account. Give it a password — a shared one, or a throwaway for
    // self-service — so the set-password email can actually deliver. --no-email
    // with no password leaves an email-only account (Google-only; no email sent).
    const initialPw = sharePw || (selfService ? genPw() : undefined);
    const created = await auth.createUser({
      email,
      ...(initialPw ? { password: initialPw } : {}),
      displayName: name || undefined,
      emailVerified: true, // admin-provisioned, so treat the email as trusted
    });
    console.log(`✓ created account ${email}${initialPw ? ' (with a password)' : ' (email-only)'}`);
    return { user: created, created: true };
  }
}

// Ask Firebase to send its built-in "set your password" email (no SMTP needed).
// Only delivers for an account that HAS a password — hence the throwaway above.
async function sendPasswordSetupEmail(addr) {
  if (typeof fetch !== 'function') throw new Error('global fetch unavailable — run on Node 18+');
  const res = await fetch(`https://identitytoolkit.googleapis.com/v1/accounts:sendOobCode?key=${WEB_API_KEY}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requestType: 'PASSWORD_RESET', email: addr }),
  });
  if (!res.ok) throw new Error(`sendOobCode failed: ${res.status} ${await res.text()}`);
}

async function main() {
  const { user, created } = await resolveUser();

  // The partners/{uid} profile — required for the invite-only gate to admit them.
  await db
    .collection('partners')
    .doc(user.uid)
    .set({ role, name: name || user.displayName || '', email }, { merge: true });
  console.log(`✓ partners/${user.uid} -> role: ${role}`);

  if (seedAnnouncement) {
    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    await db.collection('announcements').doc('welcome').set(
      {
        date: today,
        title: 'Welcome to the Partner Portal',
        body: 'Register deals, track your pipeline, and manage your partnership here.',
      },
      { merge: true },
    );
    console.log('✓ announcements/welcome seeded');
  }

  // Auto-send the "set your password" email for a brand-new self-service account
  // (it now has a password, so the link actually delivers).
  if (created && selfService) {
    try {
      await sendPasswordSetupEmail(email);
      console.log(`✓ sent a "set your password" email to ${email} (they click it, set a password, then sign in)`);
    } catch (e) {
      console.warn(`! couldn't auto-send the setup email: ${e.message}`);
      console.warn('  They can use "Forgot password?" on the login page instead, or sign in with Google.');
    }
  }

  if (sharePw) {
    console.log(`\n>>> Password for ${email}:  ${sharePw}`);
    console.log('    Share it securely; they sign in with email + password right away.');
  }
  console.log('\nDone. (deals / reports / syncMeta auto-create on first use.)');
  process.exit(0);
}

main().catch((e) => {
  console.error('Failed:', e.message);
  process.exit(1);
});
