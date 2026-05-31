const INDEPENDENT_CLASS_KEYS = new Set([
  "bagimsiz",
  "bagimsiz ogrenci",
  "bagimsiz ogrenciler"
]);

const PERSONAL_CLASS_KEYS = new Set(["kisisel", "bireysel gunlukler"]);

function normalizeClassNameKeyRaw(value) {
  return String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\u0131/g, "i")
    .replace(/\u0130/g, "I")
    .toLocaleLowerCase("tr-TR")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function normalizeClassNameDisplay(value) {
  let s = String(value || "")
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^[^\p{L}\p{N}]+/gu, "").replace(/[^\p{L}\p{N}]+$/gu, "");
  const key = normalizeClassNameKeyRaw(s);
  if (INDEPENDENT_CLASS_KEYS.has(key)) return "Bagimsiz Ogrenciler";
  return s || "Bagimsiz Ogrenciler";
}

export function normalizeClassNameKey(value) {
  const key = normalizeClassNameKeyRaw(value);
  if (INDEPENDENT_CLASS_KEYS.has(key)) return "bagimsiz ogrenciler";
  return key || "bagimsiz ogrenciler";
}

export function isPersonalClassName(value) {
  return PERSONAL_CLASS_KEYS.has(normalizeClassNameKey(value));
}
