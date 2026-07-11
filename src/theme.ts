import { getSettings } from "./data/settings";

const media = window.matchMedia("(prefers-color-scheme: light)");

export function applyTheme(): void {
  const { theme } = getSettings();
  const resolved = theme === "auto" ? (media.matches ? "light" : "dark") : theme;
  document.documentElement.dataset.theme = resolved;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", resolved === "light" ? "#f4f4f6" : "#101014");
}

media.addEventListener("change", () => {
  if (getSettings().theme === "auto") applyTheme();
});
