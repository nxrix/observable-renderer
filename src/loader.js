import { render } from "./renderer.js";

const types = {
  "text/x-typescript": "ts",
  "text/markdown": "md",
  "text/html": "html",
  "module": "js",
  "application/vnd.observable.javascript": "ojs",
  "application/x-tex": "tex",
  "text/vnd.graphviz": "dot"
};

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

const parseNotebook = (notebook) => {
  const title = (notebook.querySelector(":scope > title")?.textContent || "Observable Notebook").trim();
  const theme = notebook.getAttribute("theme") || "air";
  const cells = [...notebook.querySelectorAll(":scope > script")]
    .map((i) => ({
      value: dedent(i.textContent).replace(/^\n+|\n+$/g, ""),
      type: types[i.type],
      show: !i.hasAttribute("hidden"),
      pinned: i.hasAttribute("pinned"),
      id: i.id || null,
    }))
    .filter((c) => c.value.trim().length > 0 && c.type !== "js" && c.type !== "ts");
  return { title, theme, cells };
};

const boot = async () => {
  const notebook = document.querySelector("notebook");
  if (!notebook) return;

  const root = document.documentElement;
  const resize = () => {
    const width = window.innerWidth;
    const height = window.innerHeight;
    root.style.setProperty("--vw", `${width}px`);
    root.style.setProperty("--vh", `${height}px`);
    root.style.setProperty("--vmin", `${Math.min(width, height)}px`);
    root.style.setProperty("--vmax", `${Math.max(width, height)}px`);
  };
  resize();
  window.addEventListener("resize", resize, { passive: true });

  const meta = parseNotebook(notebook);
  document.documentElement.setAttribute("data-theme", meta.theme==="air" ? "light": meta.theme);

  document.title = meta.title;

  const style = document.createElement("style");
  style.textContent = `
    .observablehq:not(.observablehq--error):has(.observablehq--inspect) {
      display: block !important;
    }
  `;
  document.head.appendChild(style);

  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://nxrix.github.io/observable-renderer/assets/styles/notebook.css";
  document.head.appendChild(link);

  const shell = document.createElement("div");
  const main = document.createElement("main");
  shell.appendChild(main);
  document.body.replaceChildren(shell);

  if (document.compatMode === "BackCompat") {
    Object.defineProperty(Document.prototype, "compatMode", {
      configurable: true,
      get() {
        return "CSS1Compat";
      }
    });
  }

  try {
    await render(meta.cells,main);
  } catch (err) {
    const pre = document.createElement("pre");
    pre.textContent = `${err?.stack || err?.message || String(err)}`;
    main.appendChild(pre);
    console.error(err);
  }
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", boot, { once: true });
} else {
  boot();
}
