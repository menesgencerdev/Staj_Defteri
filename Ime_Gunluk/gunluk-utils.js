export const escapeHTML = (str = "") => String(str).replace(/[&<>'"]/g, (t) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  "'": "&#39;",
  '"': "&quot;"
}[t]));

export const sanitizeFileName = (name) => String(name || "Rapor")
  .replace(/[\\/:*?"<>|]/g, "_")
  .replace(/\s+/g, "_")
  .trim();

export const sanitizeExternalUrl = (url) => {
  const raw = String(url || "").trim();
  if (!raw) return "";
  try {
    const u = new URL(raw, window.location.origin);
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch {
    // invalid URL
  }
  return "";
};

export const startOfDay = (d) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

export const daysDiff = (a, b) => Math.floor((startOfDay(a) - startOfDay(b)) / 86400000);

export const toYmd = (d) => {
  const x = new Date(d);
  const y = x.getFullYear();
  const m = String(x.getMonth() + 1).padStart(2, "0");
  const day = String(x.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};

function notifyCore(message, type = "info", timeoutMs = 3800) {
  if (typeof window !== "undefined" && typeof window.notify === "function") {
    window.notify(String(message || ""), type, timeoutMs);
    return;
  }
  if (typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert(String(message || ""));
  }
}

export const notifyInfo = (message, timeoutMs) => notifyCore(message, "info", timeoutMs);
export const notifySuccess = (message, timeoutMs) => notifyCore(message, "success", timeoutMs);
export const notifyWarn = (message, timeoutMs) => notifyCore(message, "warn", timeoutMs);
export const notifyError = (message, timeoutMs) => notifyCore(message, "error", timeoutMs);
