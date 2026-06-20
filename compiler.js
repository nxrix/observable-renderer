import { Runtime, Inspector, Library } from "https://cdn.jsdelivr.net/npm/@observablehq/runtime@5/dist/runtime.js";
import { parseCell } from "https://cdn.jsdelivr.net/npm/@observablehq/parser@6.1.0/+esm";

const stdlib = new Library();
const Generators = stdlib.Generators;

class Mutable {
  constructor(value) {
    let change;
    this._gen = (async function* () {
      while (true) {
        yield value;
        value = await new Promise((r) => (change = r));
      }
    })();
    this._set = (v) => change(v);
  }
  set value(v) {
    this._set(v);
  }
}

function findMutableSets(src) {
  const found = [];
  const re = /\bmutable\s+([a-zA-Z_$][a-zA-Z0-9_$]*)\s*=(?!=)/g;
  let m;
  while ((m = re.exec(src)) !== null) found.push(m[1]);
  return [...new Set(found)];
}

function rewriteMutableSets(body, names) {
  let result = body;
  for (const name of names) {
    const re = new RegExp(`\\bmutable\\s+${name}\\s*=(?!=)`, "g");
    result = result.replace(re, `__mutable_${name}__.value =`);
  }
  return result;
}

function rewriteViewofRefs(body, names) {
  let result = body;
  for (const name of names) {
    const re = new RegExp(`\\bviewof\\s+${name}\\b`, "g");
    result = result.replace(re, `__viewof_${name}__`);
  }
  return result;
}

function buildFn(stripped, cell, inputs) {
  const rawBody = stripped.slice(cell.body.start, cell.body.end);

  const mutableSets = findMutableSets(rawBody);
  const viewofRefs = inputs
    .filter((inp) => inp.startsWith("viewof "))
    .map((inp) => inp.slice("viewof ".length));

  let body = rewriteMutableSets(rawBody, mutableSets);
  body = rewriteViewofRefs(body, viewofRefs);

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
  if (g)      return (0, eval)(`(function*(${args}){ return (${body}); })`);
  if (a)      return (0, eval)(`(async(${args}) => (${body}))`);
              return (0, eval)(`((${args}) => (${body}))`);
}

function resolveInputs(stripped, cell) {
  const fromRefs = (cell.references || []).map((ref) => {
    if (ref.type === "ViewExpression")    return "viewof " + ref.id.name;
    if (ref.type === "MutableExpression") return "mutable " + ref.id.name;
    return ref.name;
  });

  const rawBody = stripped.slice(cell.body.start, cell.body.end);
  const fromSets = findMutableSets(rawBody).map((n) => `mutable ${n}`);

  return [...new Set([...fromRefs, ...fromSets])];
}

function parseImportNames(src) {
  const match = src.match(/import\s+\{([^}]+)\}\s+from\s+["']([^"']+)["']/);
  if (!match) return [];
  return match[1].split(",").map((s) => s.trim()).filter(Boolean).map((token) => {
    const parts = token.split(/\s+as\s+/);
    const original = parts[0].trim();
    const alias = parts[1] ? parts[1].trim() : original;
    const isMutable = original.startsWith("mutable ");
    const isViewof = original.startsWith("viewof ");
    const originalBase = isMutable
      ? original.slice("mutable ".length)
      : isViewof
      ? original.slice("viewof ".length)
      : null;
    const aliasBase = isMutable
      ? alias.startsWith("mutable ") ? alias.slice("mutable ".length) : alias
      : isViewof
      ? alias.startsWith("viewof ") ? alias.slice("viewof ".length) : alias
      : null;
    return { original, alias, isMutable, isViewof, originalBase, aliasBase };
  });
}

function parseImportUrl(src) {
  const match = src.match(/import\s+\{[^}]+\}\s+from\s+["']([^"']+)["']/);
  if (!match) throw new Error("Unsupported import syntax");
  const spec = match[1];
  return spec.startsWith("http") ? spec : `https://api.observablehq.com/${spec}.js?v=3`;
}

function transpile(src) {
  const stripped = src.replace(/\bwith\s*\{[^}]*\}/, "").trim();
  const cell = parseCell(stripped);

  if (!cell.body || cell.body.type === "ImportDeclaration") return null;

  const inputs = resolveInputs(stripped, cell);
  const fn = buildFn(stripped, cell, inputs);

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

export async function compile(cells, container = document.body) {
  const runtime = new Runtime(stdlib);
  const main = runtime.module();

  const trimmed = cells.map((s) => s.trim()).filter(Boolean);
  const importSrcs = trimmed.filter((s) => /^\s*import\s+/.test(s));
  const cellSrcs = trimmed.filter((s) => !/^\s*import\s+/.test(s));

  const importVarMap = new Map();

  for (const src of importSrcs) {
    for (const { alias, isMutable, isViewof, aliasBase } of parseImportNames(src)) {
      if (!importVarMap.has(alias)) {
        importVarMap.set(alias, preRegister(main, alias));
      }
      if ((isMutable || isViewof) && aliasBase && !importVarMap.has(aliasBase)) {
        importVarMap.set(aliasBase, preRegister(main, aliasBase));
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
        const url = parseImportUrl(src);
        const define = (await import(url)).default;
        const mod = runtime.module(define);

        for (const { original, alias, isMutable, isViewof, originalBase, aliasBase } of parseImportNames(src)) {
          const v = importVarMap.get(alias);
          if (v) v.import(original, alias, mod);

          if (isMutable && aliasBase) {
            const vBase = importVarMap.get(aliasBase);
            if (vBase) vBase.import(originalBase, aliasBase, mod);
          }

          if (isViewof && aliasBase) {
            const vBase = importVarMap.get(aliasBase);
            if (vBase) vBase.define(aliasBase, [alias], (el) => Generators.input(el));
          }
        }

        placeholder.remove();
      } catch (e) {
        placeholder.replaceWith(makeErrorDiv(src, e));
        for (const { alias, isMutable, isViewof, aliasBase } of parseImportNames(src)) {
          const v = importVarMap.get(alias);
          if (v) v.define(alias, [], () => { throw e; });
          if ((isMutable || isViewof) && aliasBase) {
            const vBase = importVarMap.get(aliasBase);
            if (vBase) vBase.define(aliasBase, [], () => { throw e; });
          }
        }
      }
    })
  );

  return { runtime, main };
}
