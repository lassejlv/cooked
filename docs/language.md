# Language guide

[Docs index](./README.md) -> Language guide

Cooked components live in `.ck` files. A component is an exported `fn` with a
capitalized name. Parameters become props, and `rt (...)` returns the view.

```rust
export async fn Profile(userId: string) {
  const res = await fetch(`/api/users/${userId}`)
  const user = await res.json()

  let mut likes = 0
  let likesLabel => `${likes}`

  fn like() {
    likes += 1
  }

  effect {
    document.title = `${user.name} - ${likes}`
  }

  rt (
    <article class="profile">
      <h1>{user.name}</h1>
      <button onClick={like}>{likesLabel}</button>
    </article>
  )
}
```

## Component body

- `let mut count = 0` creates reactive writable state.
- `let doubled => count * 2` creates a memoized derived value.
- `let created = Date.now()` creates a plain constant.
- `fn inc() { ... }` creates a helper function inside the component.
- `effect { ... }` creates a reactive side effect.
- Plain TypeScript statements work, including `await` in `async fn`.

## Views

Views are JSX:

- Interpolation: `{expr}`.
- Conditionals: `{cond && <Empty />}` or `{cond ? <A /> : <B />}`.
- Simple lists: `{items.map(item => <li>{item.text}</li>)}`.
- Keyed lists: `<Keyed each={items} by={item => item.id}>{item => <Row item={item} />}</Keyed>`.
- Components: `<TodoItem text={t} onRemove={() => remove(t.id)} />`.
- Fragments: `<>...</>`.
- Events: `onClick={handler}`.
- Form properties: `value={draft}` and `checked={done}`.
- Attributes: static strings, boolean shorthand, and reactive expressions.
- Spread attributes/props: `{...attrs}` on DOM elements and components.
- Refs: `ref={el => input = el}`.

Later explicit props override earlier spread values:

```rust
<Button {...defaults} label={currentLabel} />
```

## Children

Nested markup is passed as `children`:

```rust
export fn Card(title: string = "") {
  rt (
    <section class="card">
      <h2>{title}</h2>
      {children}
    </section>
  )
}
```

## Plain functions

Lowercase top-level `fn`s compile to normal exported JavaScript functions with
types stripped:

```rust
fn formatName(first: string, last: string): string {
  return `${first} ${last}`
}
```

## Legacy syntax

The older `component Name { ... }` and `view { ... }` block syntax still
compiles, but new examples should prefer `export fn Component(...) { rt (...) }`.

## Related docs

- [State management](./state.md)
- [Tooling](./tooling.md)
- [Architecture](./architecture.md)
