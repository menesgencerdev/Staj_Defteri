import "./toast.js";
import { auth } from "./firebase-config.js?v=20260404appcheck";
import {
    onAuthStateChanged,
    signInWithEmailAndPassword,
    setPersistence,
    browserLocalPersistence,
    browserSessionPersistence,
    sendPasswordResetEmail
} from "https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js";

onAuthStateChanged(auth, (user) => {
    const boot = document.getElementById("login-boot-loading");
    const loginView = document.getElementById("login-view");
    if (user) {
        window.location.href = "panel.html";
        return;
    }
    if (boot) boot.remove();
    if (loginView) loginView.style.display = "block";
});

function bindLoginEnterSubmit() {
    const view = document.getElementById("login-view");
    if (!view || view.dataset.enterBound === "1") return;
    view.dataset.enterBound = "1";
    view.addEventListener("keydown", (e) => {
        if (e.key !== "Enter") return;
        const targetId = e.target?.id || "";
        if (targetId === "remember-me") return;
        if (targetId === "login-email" || targetId === "login-password") {
            e.preventDefault();
            window.handleLogin();
        }
    });
}

window.handleLogin = async () => {
    const email = document.getElementById("login-email")?.value.toLowerCase().trim();
    const password = document.getElementById("login-password")?.value;
    const rememberMe = !!document.getElementById("remember-me")?.checked;

    if (!email || !password) return alert("Lutfen tum alanlari doldurun!");

    try {
        await setPersistence(auth, rememberMe ? browserLocalPersistence : browserSessionPersistence);
        await signInWithEmailAndPassword(auth, email, password);
        window.location.href = "panel.html";
    } catch (e) {
        alert("Giris basarisiz! Bilgilerinizi kontrol edin.");
        console.error(e);
    }
};

window.handleForgotPassword = async () => {
    const email = document.getElementById("login-email")?.value.toLowerCase().trim();
    if (!email) return alert("Sifre sifirlama icin once e-posta adresinizi yazin.");

    try {
        await sendPasswordResetEmail(auth, email);
        alert("Sifre sifirlama baglantisi e-posta adresinize gonderildi.");
    } catch (e) {
        alert("Sifre sifirlama baglantisi gonderilemedi. E-posta adresini kontrol edin.");
        console.error(e);
    }
};

if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindLoginEnterSubmit, { once: true });
} else {
    bindLoginEnterSubmit();
}



