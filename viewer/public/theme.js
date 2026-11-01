// Runs before the page paints, so a saved dark theme doesn't flash white.
try {
  const { appearance } = JSON.parse(localStorage.getItem("agent-browser-settings")) ?? {};
  if (appearance === "light" || appearance === "dark") document.documentElement.dataset.theme = appearance;
} catch { /* optional */ }
