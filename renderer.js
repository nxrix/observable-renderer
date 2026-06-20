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

function refName(ref) {
  return ref.type === "Identifier" ? ref.name : ref.id.name;
}

function classify(side) {
  side = side.trim();
  if (side.startsWith("mutable ")) return { kind: "mutable", base: side.slice(8).trim() };
  if (side.startsWith("viewof ")) return { kind: "viewof", base: side.slice(7).trim() };
  return { kind: "value", base: side };
}

function parseImportNames(src) {
  const m = src.match(/import\s*\{([^}]*)\}/);
  if (!m) return [];
  return m[1].split(",").map((s) => s.trim()).filter(Boolean).map((token) => {
    const [lhs, rhs] = token.split(/\s+as\s+/);
    const from = classify(lhs);
    const localBase = rhs ? classify(rhs).base : from.base;
    return { kind: from.kind, srcBase: from.base, localBase };
  });
}

function specVars(spec) {
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
}

function parseImportSpec(src) {
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
}

function resolveInputs(cell) {
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
}

function rewriteBody(stripped, cell) {
  const refs = (cell.references || [])
    .filter((ref) => ref.type === "ViewExpression" || ref.type === "MutableExpression")
    .filter((ref) => ref.start >= cell.body.start && ref.end <= cell.body.end)
    .sort((a, b) => b.start - a.start);
  let body = stripped.slice(cell.body.start, cell.body.end);
  for (const ref of refs) {
    const name = refName(ref);
    const repl = ref.type === "ViewExpression" ? `__viewof_${name}__` : `__mutable_${name}__.value`;
    body = body.slice(0, ref.start - cell.body.start) + repl + body.slice(ref.end - cell.body.start);
  }
  return body;
}

function buildFn(body, cell, inputs) {
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
}

function transpile(src) {
  const stripped = src.trim();
  const cell = parseCell(stripped);

  if (!cell.body || cell.body.type === "ImportDeclaration") return null;

  const inputs = resolveInputs(cell);
  const body = rewriteBody(stripped, cell);
  const fn = buildFn(body, cell, inputs);

  if (!cell.id) {
    return [{ name: null, inputs, fn, show: true }];
  }

  if (cell.id.type === "ViewExpression") {
    const name = cell.id.id.name;
    return [
      { name: `viewof ${name}`, inputs, fn, show: true },
      {
        name,
        inputs: [`viewof ${name}`],
        fn: (el) => Generators.input(el),
        show: false,
      },
    ];
  }

  if (cell.id.type === "MutableExpression") {
    const name = cell.id.id.name;
    return [
      {
        name: `mutable ${name}`,
        inputs,
        fn: (...args) => new Mutable(fn(...args)),
        show: false,
      },
      {
        name,
        inputs: [`mutable ${name}`],
        fn: (m) => m._gen,
        show: true,
      },
    ];
  }

  return [{ name: cell.id.name, inputs, fn, show: true }];
}

function makeErrorDiv(src, err) {
  const wrap = document.createElement("div");
  wrap.className = "cell cell-error";

  const label = document.createElement("pre");
  label.className = "cell-src";
  label.textContent = src;

  const msg = document.createElement("pre");
  msg.className = "cell-err-msg";
  msg.textContent = err.message;

  wrap.appendChild(label);
  wrap.appendChild(msg);
  return wrap;
}

function preRegister(main, name) {
  const v = main.variable(null);
  v.define(name, [], () => new Promise(() => {}));
  return v;
}

export async function render(cells, container = document.body) {
  const runtime = new Runtime(stdlib);
  const main = runtime.module();

  const trimmed = cells.map((s) => s.trim()).filter(Boolean);
  const importSrcs = trimmed.filter((s) => /^\s*import\s+/.test(s));
  const cellSrcs = trimmed.filter((s) => !/^\s*import\s+/.test(s));

  const importVarMap = new Map();

  for (const src of importSrcs) {
    for (const spec of parseImportNames(src)) {
      for (const { localName } of specVars(spec)) {
        if (!importVarMap.has(localName)) {
          importVarMap.set(localName, preRegister(main, localName));
        }
      }
    }
  }

  for (const src of cellSrcs) {
    let defs;
    try {
      defs = transpile(src);
    } catch (e) {
      container.appendChild(makeErrorDiv(src, e));
      continue;
    }

    if (!defs) continue;

    for (const { name, inputs, fn, show } of defs) {
      if (!show) {
        main.variable(null).define(name, inputs, fn);
        continue;
      }
      const wrap = document.createElement("div");
      wrap.className = "cell";
      main.variable(new Inspector(wrap)).define(name, inputs, fn);
      container.appendChild(wrap);
    }
  }

  await Promise.all(
    importSrcs.map(async (src) => {
      const placeholder = document.createElement("div");
      container.appendChild(placeholder);
      try {
        const { url, injections } = parseImportSpec(src);
        const define = (await import(url)).default;
        let mod = runtime.module(define);
        if (injections.length) mod = mod.derive(injections, main);

        for (const spec of parseImportNames(src)) {
          for (const entry of specVars(spec)) {
            const target = importVarMap.get(entry.localName);
            if (!target) continue;
            if (entry.viewInput) {
              target.define(entry.localName, [entry.viewInput], (el) => Generators.input(el));
            } else {
              target.import(entry.srcName, entry.localName, mod);
            }
          }
        }

        placeholder.remove();
      } catch (e) {
        placeholder.replaceWith(makeErrorDiv(src, e));
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
}
