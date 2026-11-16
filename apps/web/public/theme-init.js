// Apply the theme before first paint to avoid a light→dark flash (external file: CSP forbids inline scripts).
(function () {
  var p = localStorage.getItem("ap.theme") || "system";
  var d = p === "dark" || (p === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  if (d) document.documentElement.classList.add("dark");
})();
