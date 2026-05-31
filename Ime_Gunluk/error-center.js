export function reportAppError({ code, error, notifyError, fallbackMessage, timeoutMs = 5200 }) {
  const safeCode = String(code || "ERR_UNKNOWN").trim() || "ERR_UNKNOWN";
  const detail = String(error?.message || error || "").trim();
  const message = `${fallbackMessage || "Islem sirasinda bir hata olustu."} [${safeCode}]`;
  console.error(`[${safeCode}]`, error);
  if (typeof notifyError === "function") {
    notifyError(detail ? `${message}\n${detail}` : message, timeoutMs);
  }
}
