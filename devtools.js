// Registers the "Burp" panel inside Chrome DevTools.
chrome.devtools.panels.create(
  "Burp",
  "icons/icon48.png",
  "panel.html",
  () => { /* panel created */ }
);
