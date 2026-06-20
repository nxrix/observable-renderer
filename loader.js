import { render } from "./renderer.js";
import { parseCell } from "https://cdn.jsdelivr.net/npm/@observablehq/parser@6.1.0/+esm";

const types = new Set(["ojs"]);

function isComplete(src) {
  try {
    parseCell(src);
    return true;
  } catch (e) {
    return false;
  }
}

function resync(s) {
  let i = s.indexOf("\n");
  if (i === -1) return s.length;
  while (i < s.length) {
    const head = s.slice(0, i);
    if (head.trim() && isComplete(head)) return i;
    const next = s.indexOf("\n", i + 1);
    if (next === -1) return s.length;
    i = next;
  }
  return s.length;
}

function splitCells(source) {
  const cells = [];
  let s = source;
  while (s.trim()) {
    try {
      parseCell(s);
      cells.push(s.trim());
      break;
    } catch (e) {
      if (e.pos != null && e.pos > 0 && isComplete(s.slice(0, e.pos))) {
        cells.push(s.slice(0, e.pos).trim());
        s = s.slice(e.pos);
        continue;
      }
      const cut = resync(s);
      cells.push(s.slice(0, cut).trim());
      s = s.slice(cut);
    }
  }
  return cells.filter((c) => c.length);
}

function collect() {
  const cells = [];
  for (const script of document.querySelectorAll("script")) {
    if (types.has((script.type || "").trim().toLowerCase())) {
      for (const cell of splitCells(script.textContent)) cells.push(cell);
    }
  }
  return cells;
}

async function run(container = document.body) {
  const cells = collect();
  console.log(cells);
  if (cells.length) return render(cells, container);
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => run());
} else {
  run();
}
