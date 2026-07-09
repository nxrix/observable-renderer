import { Runtime, Inspector, Library } from "https://cdn.jsdelivr.net/npm/@observablehq/runtime@5/dist/runtime.js";
import { parseCell } from "https://cdn.jsdelivr.net/npm/@observablehq/parser@6.1.0/+esm";

const stdlib = new Library();
const Generators = stdlib.Generators;

class Mutable {
  constructor(value) {
    let change;
    Object.defineProperty(this, "value", {
      get: () => value,
      set: (v) => change(value = v),
    });
    this._gen = Generators.observe((notify) => {
      change = notify;
      notify(value);
    });
  }
}

const refName = (ref) => ref.type === "Identifier" ? ref.name : ref.id.name;

const isJs = (type) => type === "js" || type === "ojs" || type === "javascript";

const classify = (side) => {
  side = side.trim();
  if (side.startsWith("mutable ")) return { kind: "mutable", base: side.slice(8).trim() };
  if (side.startsWith("viewof ")) return { kind: "viewof", base: side.slice(7).trim() };
  return { kind: "value", base: side };
};

const parseImportNames = (src) => {
  const m = src.match(/import\s*\{([^}]*)\}/);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean).map((token) => {
    const [lhs, rhs] = token.split(/\s+as\s+/);
    const from = classify(lhs);
    const localBase = rhs ? classify(rhs).base : from.base;
    return { kind: from.kind, srcBase: from.base, localBase };
  });
};

const specVars = (spec) => {
  const { kind, srcBase, localBase } = spec;
  if (kind === "viewof") return [
    { srcName: `viewof ${srcBase}`, localName: `viewof ${localBase}` },
    { localName: localBase, viewInput: `viewof ${localBase}` },
  ];
  if (kind === "mutable") return [
    { srcName: `mutable ${srcBase}`, localName: `mutable ${localBase}` },
    { srcName: srcBase, localName: localBase },
  ];
  return [{ srcName: srcBase, localName: localBase }];
};

const parseImportSpec = (src) => {
  const um = src.match(/from\s+["']([^"']+)["']/);
  if (!um) throw new Error("Unsupported import syntax");
  const spec = um[1];
  const url = spec.startsWith("http") ? spec : `https://api.observablehq.com/${spec}.js?v=3`;
  const wm = src.match(/\bwith\s*\{([^}]*)\}/);
  const injections = [];
  if (wm) {
    for (const token of wm[1].split(",").map((s) => s.trim()).filter(Boolean)) {
      const [lhs, rhs] = token.split(/\s+as\s+/);
      const name = lhs.trim();
      const alias = rhs ? rhs.trim() : name;
      injections.push({ name, alias });
    }
  }
  return { url, injections };
};

const resolveInputs = (cell) => {
  const seen = new Set();
  const inputs = [];
  for (const ref of cell.references || []) {
    const name = refName(ref);
    const key =
      ref.type === "ViewExpression" ? `viewof ${name}` :
      ref.type === "MutableExpression" ? `mutable ${name}` :
      name;
    if (!seen.has(key)) {
      seen.add(key);
      inputs.push(key);
    }
  }
  return inputs;
};

const rewriteRange = (input, cell, start, end) => {
  const refs = (cell.references || [])
    .filter((ref) => ref.type === "ViewExpression" || ref.type === "MutableExpression")
    .filter((ref) => ref.start >= start && ref.end <= end)
    .sort((a, b) => b.start - a.start);
  let body = input.slice(start, end);
  for (const ref of refs) {
    const name = refName(ref);
    const repl = ref.type === "ViewExpression" ? `__viewof_${name}__` : `__mutable_${name}__.value`;
    body = body.slice(0, ref.start - start) + repl + body.slice(ref.end - start);
  }
  return body;
};

const buildFn = (body, cell, inputs) => {
  const args = inputs.map((inp) => {
    const mm = inp.match(/^mutable (.+)$/);
    if (mm) return `__mutable_${mm[1]}__`;
    const mv = inp.match(/^viewof (.+)$/);
    if (mv) return `__viewof_${mv[1]}__`;
    return inp;
  }).join(",");

  const a = cell.async;
  const g = cell.generator;

  if (cell.body.type === "BlockStatement") {
    const tag = a && g ? "async function*" : a ? "async function" : g ? "function*" : "function";
    return (0, eval)(`(${tag}(${args})${body})`);
  }

  if (a && g) return (0, eval)(`(async function*(${args}){ return (${body}); })`);
  if (g) return (0, eval)(`(function*(${args}){ return (${body}); })`);
  if (a) return (0, eval)(`(async(${args}) => (${body}))`);
  return (0, eval)(`((${args}) => (${body}))`);
};

const buildTagged = (input, cell, tag) => {
  const inputs = [...new Set([tag, ...resolveInputs(cell)])];
  const tl = cell.body;
  const cooked = tl.quasis.map((q) => q.value.cooked != null ? q.value.cooked : q.value.raw);
  const raw = tl.quasis.map((q) => q.value.raw);
  const strings = `Object.assign([${cooked.map((s) => JSON.stringify(s)).join(",")}],{raw:[${raw.map((s) => JSON.stringify(s)).join(",")}]})`;
  const exprs = tl.expressions.map((e) => rewriteRange(input, cell, e.start, e.end));
  const call = `${tag}(${strings}${exprs.length ? "," + exprs.join(",") : ""})`;
  return { inputs, fn: buildFn(call, cell, inputs) };
};

const rewriteImports = (src) => {
  return src.replace(
    /import\(\s*["']([^"']+)["']\s*\)/g,
    (_, spec) => {
      if (spec.startsWith("http")) {
        return `import("${spec}")`;
      }
      if (spec.startsWith("@")) {
        return `import("https://api.observablehq.com/${spec}.js?v=3")`;
      }
      return `import("https://cdn.jsdelivr.net/npm/${spec}/+esm")`;
    }
  );
};

const transpile = (value, type) => {
  const stripped = rewriteImports(value.trim());
  const tag = isJs(type) ? null : type;
  const cell = parseCell(stripped, tag ? { tag } : undefined);

  if (!cell.body || cell.body.type === "ImportDeclaration") return null;

  if (cell.tag) {
    const { inputs, fn } = buildTagged(stripped, cell, tag);
    return [{ name: null, inputs, fn, show: true }];
  }

  const inputs = resolveInputs(cell);
  const body = rewriteRange(stripped, cell, cell.body.start, cell.body.end);
  const fn = buildFn(body, cell, inputs);

  if (!cell.id) return [{ name: null, inputs, fn, show: true }];

  if (cell.id.type === "ViewExpression") {
    const name = cell.id.id.name;
    return [
      { name: `viewof ${name}`, inputs, fn, show: true },
      { name, inputs: [`viewof ${name}`], fn: (el) => Generators.input(el), show: false },
    ];
  }

  if (cell.id.type === "MutableExpression") {
    const name = cell.id.id.name;
    return [
      { name: `mutable ${name}`, inputs, fn: (...args) => new Mutable(fn(...args)), show: false },
      { name, inputs: [`mutable ${name}`], fn: (m) => m._gen, show: true },
    ];
  }

  return [{ name: cell.id.name, inputs, fn, show: true }];
};

const fenceFor = (src) => {
  let max = 0, run = 0;
  for (const ch of src) {
    if (ch === "`") { run++; if (run > max) max = run; }
    else run = 0;
  }
  return "`".repeat(Math.max(3, max + 1));
};

const sourceDef = (src, lang) => {
  const fence = fenceFor(src);
  const text = `${fence}${lang}\n${src}\n${fence}`;
  return { name: null, inputs: ["md"], fn: (md) => md(Object.assign([text], { raw: [text] })) };
};

const makeErrorDiv = (src, err) => {
  const w = document.createElement("div");
  w.className = "cell observablehq observablehq--error";
  const e = document.createElement("div");
  e.className = "observablehq--inspect";
  e.textContent = "Error: " + err.message;
  w.appendChild(e);
  const s = document.createElement("div");
  s.className = "observablehq--inspect";
  s.textContent = "Source: " + src;
  w.appendChild(s);
  return w;
};

const preRegister = (main, name) => {
  const v = main.variable(null);
  v.define(name, [], () => new Promise(() => {}));
  return v;
};

const normalize = (cell) =>
  typeof cell === "string"
    ? { value: cell, type: "js", show: true, pinned: false }
    : { value: cell.value, type: cell.type || "js", show: cell.show !== false, pinned: !!cell.pinned };

const isImport = (item) => isJs(item.type) && /^\s*import\s+/.test(item.value.trim());

const language = (type) => isJs(type) ? "js" : type;

const render = async (cells, container = document.body) => {
  const runtime = new Runtime(stdlib);
  const main = runtime.module();

  const items = cells.map(normalize).filter((c) => c.value != null && c.value.trim());
  const importVarMap = new Map();

  for (const item of items) {
    if (!isImport(item)) continue;
    for (const spec of parseImportNames(item.value)) {
      for (const { localName } of specVars(spec)) {
        if (!importVarMap.has(localName)) importVarMap.set(localName, preRegister(main, localName));
      }
    }
  }

  const appendInspector = (def) => {
    const wrap = document.createElement("div");
    wrap.className = "cell";
    main.variable(new Inspector(wrap)).define(def.name, def.inputs, def.fn);
    container.appendChild(wrap);
    return wrap;
  };

  const tasks = [];
  for (const item of items) {
    if (isImport(item)) {
      const src = item.value.trim();
      const anchor = item.show ? appendInspector(sourceDef(src, "js")) : null;
      tasks.push({ src, anchor });
      continue;
    }

    let defs;
    try {
      defs = transpile(item.value, item.type);
    } catch (e) {
      container.appendChild(makeErrorDiv(item.value, e));
      continue;
    }
    if (!defs) continue;

    for (const def of defs) {
      if (item.show && def.show) appendInspector(def);
      else main.variable(null).define(def.name, def.inputs, def.fn);
    }

    if (item.pinned) appendInspector(sourceDef(item.value.trim(), language(item.type)));
  }

  await Promise.all(
    tasks.map(async ({ src, anchor }) => {
      try {
        const { url, injections } = parseImportSpec(src);
        const define = (await import(url)).default;
        let mod = runtime.module(define);
        if (injections.length) mod = mod.derive(injections, main);
        for (const spec of parseImportNames(src)) {
          for (const entry of specVars(spec)) {
            const target = importVarMap.get(entry.localName);
            if (!target) continue;
            if (entry.viewInput) target.define(entry.localName, [entry.viewInput], (el) => Generators.input(el));
            else target.import(entry.srcName, entry.localName, mod);
          }
        }
      } catch (e) {
        const err = makeErrorDiv(src, e);
        if (anchor) anchor.after(err);
        else container.appendChild(err);
        for (const spec of parseImportNames(src)) {
          for (const { localName } of specVars(spec)) {
            const target = importVarMap.get(localName);
            if (target) target.define(localName, [], () => { throw e; });
          }
        }
      }
    })
  );

  return { runtime, main };
};

const isComplete = (src) => {
  try {
    parseCell(src);
    return true;
  } catch (e) {
    return false;
  }
};

const resync = (s) => {
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
};

const split = (source) => {
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
};

export { render, split };
