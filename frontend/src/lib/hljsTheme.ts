import lightTheme from 'highlight.js/styles/github.css?inline';
import darkTheme from 'highlight.js/styles/github-dark.css?inline';

const STYLE_ID = 'hljs-theme';

/** Swap the highlight.js stylesheet to match the app theme. */
export function applyHljsTheme(isDark: boolean): void {
  let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
  if (!style) {
    style = document.createElement('style');
    style.id = STYLE_ID;
    document.head.appendChild(style);
  }
  const css = isDark ? darkTheme : lightTheme;
  if (style.textContent !== css) {
    style.textContent = css;
  }
}
