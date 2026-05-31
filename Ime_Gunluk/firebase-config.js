import { initializeApp } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";
import { initializeAppCheck, ReCaptchaV3Provider } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-app-check.js";

const firebaseConfig = {
  apiKey: "AIzaSyCKK4tHmPTK7POmfkjL4MSoyml92HcbZiU",
  authDomain: "gunluk-fdff6.firebaseapp.com",
  projectId: "gunluk-fdff6",
  storageBucket: "gunluk-fdff6.firebasestorage.app",
  messagingSenderId: "895749922668",
  appId: "1:895749922668:web:d78a1ffbb5437c0d8f1d49",
  measurementId: "G-DEQPN57ZX2"
};

const app = initializeApp(firebaseConfig);

function resolveAppCheckSiteKey() {
  if (typeof window === "undefined") return "";
  const fromWindow = String(window.__APP_CHECK_SITE_KEY || "").trim();
  if (fromWindow) return fromWindow;
  const fromMeta = String(document.querySelector('meta[name="firebase-app-check-site-key"]')?.content || "").trim();
  if (fromMeta) return fromMeta;
  const fromStorage = String(localStorage.getItem("firebase_app_check_site_key") || "").trim();
  return fromStorage;
}

function maybeEnableAppCheckDebugToken() {
  if (typeof window === "undefined") return;
  const isLocal = ["localhost", "127.0.0.1"].includes(window.location.hostname);
  if (!isLocal) return;
  if (localStorage.getItem("firebase_app_check_debug") !== "1") return;
  // Dev-only: enable debug token on local environments.
  self.FIREBASE_APPCHECK_DEBUG_TOKEN = true;
}

let appCheck = null;
try {
  maybeEnableAppCheckDebugToken();
  const siteKey = resolveAppCheckSiteKey();
  if (siteKey) {
    appCheck = initializeAppCheck(app, {
      provider: new ReCaptchaV3Provider(siteKey),
      isTokenAutoRefreshEnabled: true
    });
    console.info("[AppCheck] active");
  } else {
    console.warn("[AppCheck] site key missing. Set window.__APP_CHECK_SITE_KEY or meta[name='firebase-app-check-site-key'].");
  }
} catch (e) {
  console.warn("[AppCheck] init failed:", e);
}

export const db = getFirestore(app);
export const auth = getAuth(app);
export { app, appCheck };
export const appCheckEnabled = !!appCheck;

