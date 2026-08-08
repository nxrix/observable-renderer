# Observable Renderer

An unofficial lightweight, client-side library to render Observable Notebooks.  
Uses [Observable Runtime](https://github.com/observablehq/runtime) & [Observable Parser](https://github.com/observablehq/parser)

JS, TS and SQL cell types are not supported yet!

---
## Usage

There are two scripts `loader.js` and `renderer.js`

### Loader

To open an Observable notebook directly in browser add the loader script to the notebook:

```html
<script type="module" src="https://cdn.jsdelivr.net/gh/nxrix/observable-renderer/src/loader.js"></script>
```

### Renderer

```js
import { render, split } from "https://cdn.jsdelivr.net/gh/nxrix/observable-renderer/src/renderer.js";

const cells = [
  {
    type: "md",
    value: "# Hello"
  },
  {
    type: "ojs",
    value: "x = 100"
  },
  {
    type: "ojs",
    value: "x + 1"
  }
];

const { runtime, main } = await render(cells, document.body);
```

`render()` accepts an array of cells and an optional container element.

A cell can be either a string or an object:

```js
{
  value: "x = 100",
  type: "ojs",
  show: true,
  pinned: false
}
```

Supported cell types:

* `ojs` — Observable JavaScript
* `md` — Markdown
* `html` — HTML
* `dot` — Graphviz
* `tex` — TeX

The renderer also exposes `split()` for splitting Observable JavaScript source into cells:

```js
import { split } from "https://cdn.jsdelivr.net/gh/nxrix/observable-renderer/src/renderer.js";

const cells = split(`
  x = 100
  y = x + 1
`);
console.log(cells);
```
