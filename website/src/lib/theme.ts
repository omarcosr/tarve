export type SiteTheme = "light" | "dark";

const KEY = "tarve-theme";
export const THEME_EVENT = "tarve:theme";

/** Runs inline in <head> so the stored choice applies before the first paint. */
export const themeBootScript = `try{var t=localStorage.getItem("${KEY}");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch(e){}`;

export function currentTheme(): SiteTheme {
  const chosen = document.documentElement.dataset.theme;
  if (chosen === "light" || chosen === "dark") return chosen;
  return matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

export function setTheme(theme: SiteTheme): void {
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem(KEY, theme);
  } catch {}
  window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: theme }));
}

/** Calls `listener` when the visitor toggles the theme or the system theme changes. */
export function onThemeChange(listener: (theme: SiteTheme) => void): () => void {
  const media = matchMedia("(prefers-color-scheme: dark)");
  const notify = () => listener(currentTheme());
  window.addEventListener(THEME_EVENT, notify);
  media.addEventListener("change", notify);
  return () => {
    window.removeEventListener(THEME_EVENT, notify);
    media.removeEventListener("change", notify);
  };
}
