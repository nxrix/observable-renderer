import { render, splitCells } from "./renderer.js";

async function run(container = document.body) {
  const cells = [];
  for (const script of document.querySelectorAll("script")) {
    const type = (script.type || "").trim().toLowerCase();
    if (!/^o[a-z0-9]+$/.test(type)) continue;
    const kind = type.slice(1);
    const show = script.getAttribute("show") !== "false";
    const pinned = script.hasAttribute("pinned");
    if (kind === "js") {
      for (const value of splitCells(script.textContent)) cells.push({ value, type: "js", show, pinned });
    } else {
      cells.push({ value: script.textContent.trim(), type: kind, show, pinned });
    }
  }
  if (cells.length) return render(cells, container);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => run());
} else {
  run();
}
