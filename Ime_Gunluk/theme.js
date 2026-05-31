export function initTheme() {
    const root = document.documentElement;
    const savedTheme = localStorage.getItem("theme");
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;

    root.setAttribute("data-theme", savedTheme || (systemDark ? "dark" : "light"));
    updateThemeButtons();

    const media = window.matchMedia("(prefers-color-scheme: dark)");
    media.addEventListener("change", (e) => {
        const manualTheme = localStorage.getItem("theme");
        if (!manualTheme) {
            root.setAttribute("data-theme", e.matches ? "dark" : "light");
            updateThemeButtons();
        }
    });
}

export function toggleTheme() {
    const root = document.documentElement;
    const current = root.getAttribute("data-theme") || "light";
    const next = current === "dark" ? "light" : "dark";
    root.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
    updateThemeButtons();
}

export function resetThemeToSystem() {
    localStorage.removeItem("theme");
    const systemDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    document.documentElement.setAttribute("data-theme", systemDark ? "dark" : "light");
    updateThemeButtons();
}

export function updateThemeButtons() {
    const current = document.documentElement.getAttribute("data-theme") || "light";
    const buttons = document.querySelectorAll("[data-theme-toggle]");
    buttons.forEach((btn) => {
        const dark = current !== "dark";
        btn.textContent = dark ? "Koyu Mod" : "Acik Mod";
        btn.setAttribute("aria-label", dark ? "Koyu moda gec" : "Acik moda gec");
        btn.title = dark ? "Koyu moda gec" : "Acik moda gec";
    });
}
