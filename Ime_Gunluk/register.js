import "./toast.js";
import { auth } from "./firebase-config.js?v=20260404appcheck";
import { createUserWithEmailAndPassword } from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

const CAPTCHA_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const IP_REGISTER_LIMIT_MINUTES = 30;
let currentCaptcha = "";
let isRegistering = false;

async function callBackend(path, options = {}) {
    const token = await auth.currentUser?.getIdToken();
    if (!token) throw new Error("Oturum bulunamadi.");
    const response = await fetch(path, {
        ...options,
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`,
            ...(options.headers || {})
        }
    });
    const rawText = await response.text().catch(() => "");
    let data = {};
    try { data = rawText ? JSON.parse(rawText) : {}; } catch (_) { data = {}; }
    if (!response.ok) throw new Error(data.error || rawText?.slice?.(0, 160) || "Backend istegi basarisiz.");
    return data;
}

function generateCaptcha(length = 6) {
    let result = "";
    for (let i = 0; i < length; i++) {
        const idx = Math.floor(Math.random() * CAPTCHA_CHARS.length);
        result += CAPTCHA_CHARS[idx];
    }
    return result;
}

function refreshCaptcha() {
    currentCaptcha = generateCaptcha(6);
    const codeEl = document.getElementById("captcha-code");
    if (codeEl) codeEl.textContent = currentCaptcha;

    const inputEl = document.getElementById("reg-captcha");
    if (inputEl) inputEl.value = "";
}

function bindCaptchaUI() {
    const refreshBtn = document.getElementById("refresh-captcha");
    if (refreshBtn && !refreshBtn.dataset.bound) {
        refreshBtn.dataset.bound = "1";
        refreshBtn.addEventListener("click", refreshCaptcha);
    }
    refreshCaptcha();
}

function setRegisterBusy(isBusy) {
    const btn = document.getElementById("register-btn");
    if (!btn) return;
    btn.disabled = isBusy;
    btn.style.opacity = isBusy ? "0.75" : "1";
    btn.style.cursor = isBusy ? "not-allowed" : "pointer";
    btn.textContent = isBusy ? "Kaydediliyor..." : "Kaydı Tamamla";
}

function toHumanMinutes(ms) {
    return Math.max(1, Math.ceil(ms / 60000));
}


function enforceLocalRateLimit() {
    const key = "register_local_last_attempt_ms";
    const now = Date.now();
    const last = Number(localStorage.getItem(key) || 0);
    const windowMs = IP_REGISTER_LIMIT_MINUTES * 60 * 1000;
    if (last && now - last < windowMs) {
        const remain = windowMs - (now - last);
        throw new Error(`LOCAL_RATE_LIMIT:${remain}`);
    }
    localStorage.setItem(key, String(now));
}

async function enforceIpRateLimit() {
    // Public Firestore yazimi kapali; backend/App Check tabanli oran siniri gelene kadar guvenli local fren.
    enforceLocalRateLimit();
}

function initRegisterPage() {
    bindCaptchaUI();
    bindRegisterEnterSubmit();
}

function bindRegisterEnterSubmit() {
    const card = document.querySelector(".auth-card");
    if (!card || card.dataset.enterBound === "1") return;
    card.dataset.enterBound = "1";

    card.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const targetId = e.target?.id || "";
        if (!targetId.startsWith("reg-")) return;
        e.preventDefault();
        window.handleRegister();
    });
}

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initRegisterPage, { once: true });
} else {
    initRegisterPage();
}
// Bazi tarayici/geri-donus senaryolarinda ek guvence.
setTimeout(() => {
    const codeEl = document.getElementById("captcha-code");
    if (codeEl && !codeEl.textContent?.trim()) refreshCaptcha();
}, 100);

window.handleRegister = async () => {
    if (isRegistering) return;
    isRegistering = true;
    setRegisterBusy(true);

    const email = document.getElementById("reg-email").value.toLowerCase().trim();
    const password = document.getElementById("reg-password").value;
    const name = document.getElementById("reg-name").value.trim();
    const role = document.getElementById("reg-role").value;
    const captchaInput = document.getElementById("reg-captcha").value.trim().toUpperCase();

    if (!email || !password || !name) {
        alert("Lütfen tüm alanları doldurun!");
        setRegisterBusy(false);
        isRegistering = false;
        refreshCaptcha();
        return;
    }

    if (!captchaInput || captchaInput !== currentCaptcha) {
        alert("Captcha kodu hatalı. Lütfen tekrar deneyin.");
        setRegisterBusy(false);
        isRegistering = false;
        refreshCaptcha();
        return;
    }

    try {
        await enforceIpRateLimit();

        const cred = await createUserWithEmailAndPassword(auth, email, password);

        await callBackend("/api/users/profile", {
            method: "POST",
            body: JSON.stringify({ fullName: name, role })
        });

        alert("Kayıt başarılı! Panele yönlendiriliyorsunuz.");
        window.location.href = "panel.html";
    } catch (e) {
        const msg = String(e?.message || "");
        if (msg.startsWith("IP_RATE_LIMIT:")) {
            const remain = Number(msg.split(":")[1] || 0);
            alert(`Bu IP ile yeni kayıt için ${toHumanMinutes(remain)} dk beklenmeli.`);
        } else if (msg.startsWith("LOCAL_RATE_LIMIT:")) {
            const remain = Number(msg.split(":")[1] || 0);
            alert(`Yeni kayıt için ${toHumanMinutes(remain)} dk beklenmeli.`);
        } else if (msg.includes("auth/email-already-in-use")) {
            alert("Bu e-posta ile zaten bir hesap var.");
        } else {
            alert("Kayıt hatası: " + msg);
        }
    } finally {
        refreshCaptcha();
        setRegisterBusy(false);
        isRegistering = false;
        const captchaEl = document.getElementById("reg-captcha");
        if (captchaEl) captchaEl.focus();
    }
};



