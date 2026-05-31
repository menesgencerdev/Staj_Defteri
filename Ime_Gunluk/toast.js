const TOAST_STACK_ID = "toast-stack";

function ensureToastStack() {
  let stack = document.getElementById(TOAST_STACK_ID);
  if (!stack) {
    stack = document.createElement("div");
    stack.id = TOAST_STACK_ID;
    stack.className = "toast-stack";
    document.body.appendChild(stack);
  }
  return stack;
}

function normalizeType(type = "info") {
  const t = String(type || "info").toLowerCase();
  if (t === "success" || t === "warn" || t === "error" || t === "info") return t;
  return "info";
}

function detectTypeFromMessage(message = "") {
  const m = String(message || "").toLowerCase();
  if (
    m.includes("hata") ||
    m.includes("basarisiz") ||
    m.includes("olustu") ||
    m.includes("redded") ||
    m.includes("gecersiz")
  ) return "error";
  if (
    m.includes("uyari") ||
    m.includes("eksik") ||
    m.includes("bekle") ||
    m.includes("dikkat")
  ) return "warn";
  if (
    m.includes("basar") ||
    m.includes("kaydedildi") ||
    m.includes("yuklendi") ||
    m.includes("onay")
  ) return "success";
  return "info";
}

export function notify(message, type = "info", timeoutMs = 3800) {
  const stack = ensureToastStack();
  const toast = document.createElement("div");
  const tone = type === "info" ? detectTypeFromMessage(message) : normalizeType(type);
  const iconMap = { success: "OK", warn: "!", error: "X", info: "i" };
  toast.className = `toast toast-${tone}`;
  toast.setAttribute("role", "status");
  toast.innerHTML = `
    <div class="toast-icon" aria-hidden="true">${iconMap[tone] || "i"}</div>
    <div class="toast-message"></div>
    <button type="button" class="toast-close" aria-label="Kapat">x</button>
    <div class="toast-progress"></div>
  `;
  toast.querySelector(".toast-message").textContent = String(message || "");
  toast.querySelector(".toast-close")?.addEventListener("click", () => {
    toast.classList.add("toast-hide");
    setTimeout(() => toast.remove(), 180);
  });

  stack.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add("toast-show"));

  const ttl = Math.max(1200, Number(timeoutMs) || 3800);
  const progress = toast.querySelector(".toast-progress");
  if (progress) progress.style.animationDuration = `${ttl}ms`;
  setTimeout(() => {
    toast.classList.add("toast-hide");
    setTimeout(() => toast.remove(), 180);
  }, ttl);
}

if (!window.__toastAlertInstalled) {
  window.__toastAlertInstalled = true;
  const nativeAlert = window.alert?.bind(window);
  window.alert = (message) => {
    try {
      notify(message, "info");
    } catch {
      if (nativeAlert) nativeAlert(message);
    }
  };
}

window.notify = notify;
