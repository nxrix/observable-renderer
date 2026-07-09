import { render, split } from "./renderer.js";

const dedent = (text) => {
  const lines = text.replace(/^\r?\n/, "").split(/\r?\n/);
  const nonBlank = lines.filter(line => line.trim());
  if (!nonBlank.length) return "";
  const indent = Math.min(
    ...nonBlank.map(line => line.match(/^[ \t]*/)[0].length)
  );
  return lines
    .map(line => line.trim() ? line.slice(indent) : "")
    .join("\n");
}

const run = async () => {
  const cells = [];
  for (const script of document.querySelectorAll("script")) {
    const type = (script.type || "").trim().toLowerCase();
    if (!(/^o[a-z0-9]+$/.test(type) || type === "application/vnd.observable.javascript" || type === "text/markdown")) continue;
    const kind = type.startsWith("o") ? type.slice(1) : type;
    const show = !script.hasAttribute("hidden");
    const pinned = script.hasAttribute("pinned");
    const v = dedent(script.textContent);
    if (kind === "js"|| kind === "application/vnd.observable.javascript") {
      for (const value of split(v)) cells.push({ value, type: "js", show, pinned });
    } else {
      cells.push({ value: v, type: kind.replace("text/markdown","md"), show, pinned });
    }
    script.remove();
  }
  const container = document.querySelector("main") || document.body;
  if (cells.length) return render(cells, container);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => run());
} else {
  run();
}
