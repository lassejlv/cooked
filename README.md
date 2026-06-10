# Cooked 🥒

A Svelte/Solid-style **compiled** UI language. Rust × TypeScript.

- **Compiled, not interpreted** — `.ck` files compile to imperative DOM + fine-grained
  signals. No virtual DOM, tiny runtime (the example app bundles to ~2.4 kB gzipped).
- **TypeScript-first** — every expression is real TS (with JSX), parsed and rewritten
  with [oxc](https://oxc.rs). Type annotations are stripped at compile time.
- **Rust core, native speed** — the compiler is a Rust crate shipped to Node via
  napi-rs, wired into Vite with a standard `transform` plugin (works under
  rollup-vite **and** rolldown-vite).

```rust
// Counter.ck
export fn Counter(label: string = "Count") {   // props are fn params
  let mut count = 0          // reactive state
  let doubled => count * 2   // derived (auto-tracked, memoized)

  effect { console.log("count is", count) }

  fn inc() { count += 1 }

  rt (                       // return the view — plain JSX
    <div class="counter">
      <h1>{label}: {count} (x2 = {doubled})</h1>
      <button onClick={inc}>+</button>
    </div>
  )
}
```

compiles to:

```js
import * as $ from "cooked";

export function Counter(props) {
  props = $.withDefaults(props ?? {}, { label: "Count" });
  const count = $.signal(0);
  const doubled = $.memo(() => count.get() * 2);
  $.effect(() => { console.log("count is", count.get()) });
  const inc = () => { count.set(count.get() + (1)) };
  const _el0 = document.createElement("div");
  _el0.className = "counter";
  const _el1 = document.createElement("h1");
  // dynamic spots are anchored with comment markers + $.insert
  ...
  const _el2 = document.createElement("button");
  $.listen(_el2, "click", inc);
  ...
  return _el0;
}
```

The compiler inserts `.get()` on reactive reads and `.set(...)` on writes — you never
write them yourself.

## The language

A component is an exported `fn` with a capitalized name. Parameters are props
(defaults supported). The body is ordinary TypeScript plus a few Rust-flavored forms,
and ends with `rt ( ...jsx... )`:

```rust
import { Spinner } from "./Spinner.ck"

export async fn Profile(userId: string) {
  // any TS statement works here — async/await included
  const res = await fetch(`/api/users/${userId}`)
  const user = await res.json()

  let mut likes = 0            // reactive state   (signal)
  let likesLabel => `${likes}` // derived          (memo)
  let created = Date.now()     // plain const

  fn like() { likes += 1 }     // function (writes auto-compile to .set)

  effect {                     // side-effect (auto-tracked)
    document.title = `${user.name} — ${likes}`
  }

  rt (
    <article class="profile">
      <h1>{user.name}</h1>
      <button onClick={like}>♥ {likesLabel}</button>
    </article>
  )
}
```

Views are JSX:

- **Interpolation** `{expr}` — any TS expression; updates are fine-grained.
- **Conditionals** `{cond && <Empty />}` or `{cond ? <A /> : <B />}`.
- **Lists** `{items.map(item => <li>{item.text}</li>)}` for simple lists, or
  `<Keyed each={items} by={item => item.id}>{item => <Row item={item} />}</Keyed>`
  when DOM identity must survive reorders/removals.
- **Components** `<TodoItem text={t} onRemove={() => remove(i)} />` — capitalized
  tags call the component with a props object; expression props are passed as
  getters so they stay reactive. Nested markup arrives as the implicit
  `children` prop: render it with `{children}`.
- **Fragments** `<>...</>` for multiple roots.
- **Events** `onClick={handler}` (any `on*` attribute; lowercased DOM event).
- **Forms** `value={draft}` / `checked={done}` bind DOM *properties*;
  combine with `onInput={e => draft = e.target.value}`.
- **Attributes** — static strings are set once; `{expr}` values update reactively;
  boolean shorthand (`<input disabled />`) and `style={{ color: "red" }}` work.
- **Refs** `ref={el => input = el}` receives the DOM element.
- **Async components** — `export async fn` may `await` before `rt`; parents render
  a placeholder marker and the markup lands when the promise resolves.

Lowercase top-level `fn`s are plain helper functions (exported, types stripped).
`import` statements pass through to the generated module. The older
`component Name { ... }` / `view { ... }` block syntax still compiles.

Not yet: spread props (`{...props}`), scoped `style`, state-preserving HMR.

Source maps are emitted through the Vite plugin, and compiler errors include the
source filename with line/column context when the compiler can locate the failing
span. The Vite plugin writes sibling `.d.ck.ts` files for named `.ck` exports so
TypeScript-aware editors can resolve imports.

## Architecture

```
 .ck ─▶ cooked_compiler (Rust)                       ─▶ JS module
        │ parser         → structural grammar; JSX + TS spans kept raw
        │ rewrite (oxc)  → reads .get(), writes .set(), props.x, type stripping
        │ jsx + codegen  → createElement + $.insert/$.setAttr/$.setProp/$.listen
        ▼
   cooked_napi (napi-rs)  →  @cooked/binding  (native .node)
        ▼
   vite-plugin-cooked  (transform hook, pre)
        ▼
   cooked  (runtime: signal / memo / effect + ownership tree + DOM helpers)
```

| Path | What |
|------|------|
| `crates/cooked_compiler` | parser, oxc reactive rewriter, JSX codegen |
| `crates/cooked_napi`     | napi-rs bindings → `@cooked/binding` |
| `packages/runtime`       | `cooked` — signals + DOM helpers (the codegen target) |
| `packages/vite-plugin-cooked` | the Vite plugin |
| `examples/counter`       | counter, todo list & async greeting + end-to-end tests |

The runtime keeps an **ownership tree**: effects created while building a view
region are disposed when that region is replaced, so conditionals and lists don't
leak. `mount` returns a disposer that tears the whole tree down.

## Develop

```bash
pnpm install
pnpm --filter @cooked/binding build:debug   # build the native compiler
pnpm --filter cooked build                  # build the runtime
pnpm --filter vite-plugin-cooked build      # build the plugin

cargo test -p cooked_compiler               # compiler unit tests
pnpm -r test                                # runtime + end-to-end tests
pnpm check                                  # full local CI gate
pnpm --filter @cooked/example-counter dev   # run the demo app
```

For TypeScript projects, add the shared `.ck` module declaration:

```ts
/// <reference types="vite-plugin-cooked/client" />
```

The Vite plugin emits `.d.ck.ts` declaration files next to compiled `.ck` modules
by default. Set `cooked({ declarations: false })` to disable that. In dev, `.ck`
edits remount active instances from the updated module without a full page reload;
preserving component-local state across replacement is still on the roadmap.
