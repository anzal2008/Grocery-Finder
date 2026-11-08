/* LO-auth.js — Grocery Finder sign-in + online storage (LO = Louis, Firebase version)
   - Sign up / log in with email + password, or with Google
   - Saves each user's account data in Firestore (collection LOusers, one doc per user)
   - Firebase files are bundled in LO-vendor/, so nothing loads from other sites
   Exposes window.LOAuth for LO-account.js. */
import { initializeApp } from './LO-vendor/LO-firebase-app.js';
import {
  getAuth, connectAuthEmulator, onAuthStateChanged, setPersistence, browserLocalPersistence,
  createUserWithEmailAndPassword, signInWithEmailAndPassword, signInWithPopup,
  GoogleAuthProvider, updateProfile, sendPasswordResetEmail, signOut as fbSignOut
} from './LO-vendor/LO-firebase-auth.js';
import {
  getFirestore, connectFirestoreEmulator, doc, getDoc, setDoc
} from './LO-vendor/LO-firebase-firestore.js';

var cfg = window.LO_FIREBASE_CONFIG;
var configured = !!(cfg && cfg.apiKey && cfg.projectId);
var auth = null, db = null;
var listeners = [];
var current = null;
var resolveReady;
var ready = new Promise(function (r) { resolveReady = r; });

function toUser(u) {
  return u ? { sub: u.uid, name: u.displayName || (u.email || '').split('@')[0] || 'friend', email: u.email || '' } : null;
}

// Plain-English versions of Firebase's error codes
function nice(e) {
  var code = (e && e.code) || '';
  var map = {
    'auth/invalid-email': 'That email address doesn\'t look right.',
    'auth/missing-password': 'Type a password.',
    'auth/weak-password': 'Password must be at least 6 characters.',
    'auth/email-already-in-use': 'There\'s already an account with that email. Use Log in instead.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/wrong-password': 'Wrong email or password.',
    'auth/user-not-found': 'No account with that email. Use Sign up instead.',
    'auth/too-many-requests': 'Too many tries. Wait a minute and try again.',
    'auth/popup-closed-by-user': 'The Google window was closed before finishing.',
    'auth/cancelled-popup-request': 'The Google window was closed before finishing.',
    'auth/popup-blocked': 'Your browser blocked the Google window. Allow pop-ups for this site and try again.',
    'auth/unauthorized-domain': 'This website isn\'t on Firebase\'s list of allowed sites yet (Authentication → Settings → Authorized domains).',
    'auth/operation-not-allowed': 'This sign-in method is turned off in Firebase (Authentication → Sign-in method).',
    'auth/network-request-failed': 'No internet connection.',
    'permission-denied': 'The online database refused access. Check the Firestore rules.'
  };
  return map[code] || (e && e.message) || String(e);
}

if (configured) {
  var app = initializeApp(cfg);
  auth = getAuth(app);
  db = getFirestore(app);
  if (window.LO_EMULATOR) {   // only used for local testing
    connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
    connectFirestoreEmulator(db, '127.0.0.1', 8080);
  }
  setPersistence(auth, browserLocalPersistence).catch(function () {});
  var first = true;
  onAuthStateChanged(auth, function (u) {
    current = toUser(u);
    if (first) { first = false; resolveReady(current); }
    listeners.forEach(function (cb) { try { cb(current); } catch (e) { console.warn(e); } });
  });
} else {
  resolveReady(null);
}

function need() {
  if (!configured) throw new Error('Sign-in isn\'t set up yet: the Firebase config is missing from LO-firebase-config.js.');
}
async function wrap(p) {
  try { return await p; } catch (e) { throw new Error(nice(e)); }
}

window.LOAuth = {
  configured: configured,
  ready: ready,
  user: function () { return current; },
  onChange: function (cb) { listeners.push(cb); },

  signUp: async function (email, password, name) {
    need();
    var cred = await wrap(createUserWithEmailAndPassword(auth, email.trim(), password));
    if (name && name.trim()) {
      await wrap(updateProfile(cred.user, { displayName: name.trim() }));
      current = toUser(cred.user);
      listeners.forEach(function (cb) { cb(current); });
    }
    return current;
  },
  logIn: async function (email, password) {
    need();
    await wrap(signInWithEmailAndPassword(auth, email.trim(), password));
    return current;
  },
  google: async function () {
    need();
    await wrap(signInWithPopup(auth, new GoogleAuthProvider()));
    return current;
  },
  resetPassword: async function (email) {
    need();
    await wrap(sendPasswordResetEmail(auth, email.trim()));
  },
  signOut: async function () {
    if (auth) await wrap(fbSignOut(auth));
  },

  // ---- online storage: one document per user ----
  loadData: async function () {
    if (!configured || !auth.currentUser) return null;
    var snap = await wrap(getDoc(doc(db, 'LOusers', auth.currentUser.uid)));
    if (!snap.exists()) return null;
    var d = snap.data();
    return { blob: d.blob ? JSON.parse(d.blob) : null, updatedAt: d.updatedAt || 0 };
  },
  saveData: async function (obj) {
    if (!configured || !auth.currentUser) return false;
    await wrap(setDoc(doc(db, 'LOusers', auth.currentUser.uid), {
      blob: JSON.stringify(obj),
      updatedAt: obj.updatedAt || Date.now(),
      email: auth.currentUser.email || ''
    }));
    return true;
  }
};
window.dispatchEvent(new Event('lo-auth-loaded'));
