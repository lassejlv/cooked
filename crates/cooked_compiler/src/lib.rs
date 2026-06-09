//! Cooked compiler — `.ck` source -> JS module (targeting the `cooked` runtime).

mod ast;
mod codegen;
mod jsx;
mod parser;
mod rewrite;

#[derive(Debug, Clone)]
pub struct CompileOutput {
    pub code: String,
    pub errors: Vec<String>,
}

/// Compile a `.ck` source file into a JS module.
pub fn compile(source: &str) -> CompileOutput {
    let result = parser::parse_file(source).and_then(|file| codegen::gen_module(&file));
    match result {
        Ok(code) => CompileOutput { code, errors: vec![] },
        Err(e) => CompileOutput { code: String::new(), errors: vec![e] },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn compile_ok(src: &str) -> String {
        let out = compile(src);
        assert!(out.errors.is_empty(), "errors: {:?}", out.errors);
        out.code
    }

    const COUNTER: &str = r#"
component Counter {
  prop label: string = "Count"

  let mut count = 0
  let doubled => count * 2

  effect {
    console.log("count is", count)
  }

  fn inc() {
    count += 1
  }

  view {
    <div class="counter">
      <h1>{label}: {count} (x2 = {doubled})</h1>
      <button onClick={inc}>+</button>
    </div>
  }
}
"#;

    #[test]
    fn compiles_counter() {
        let code = compile_ok(COUNTER);
        eprintln!("---- generated ----\n{}\n-------------------", code);

        // reactive declarations
        assert!(code.contains("const count = $.signal(0);"), "signal decl missing");
        assert!(code.contains("const doubled = $.memo(() => count.get() * 2);"), "memo decl missing");
        // effect with rewritten read
        assert!(code.contains("$.effect(() => { console.log(\"count is\", count.get()) });"));
        // fn with rewritten write
        assert!(code.contains("const inc = () => { count.set(count.get() + (1)) };"));
        // prop default
        assert!(code.contains("$.withDefaults(props ?? {}, { label: \"Count\" });"));
        // dom structure
        assert!(code.contains("document.createElement(\"div\")"));
        assert!(code.contains(".className = \"counter\";"));
        assert!(code.contains("document.createElement(\"h1\")"));
        // dynamic text spots with rewritten reads
        assert!(code.contains("props.label"));
        assert!(code.contains("count.get()"));
        assert!(code.contains("doubled.get()"));
        assert!(code.contains("$.insert("));
        // event
        assert!(code.contains("$.listen(") && code.contains("\"click\", inc)"));
    }

    #[test]
    fn compiles_conditional_and_list() {
        let code = compile_ok(
            r#"
component TodoList {
  let mut items = []

  view {
    <ul class="todos">
      {items.length === 0 && <li class="empty">Nothing to do</li>}
      {items.map(item => <li onClick={() => console.log(item)}>{item.text}</li>)}
    </ul>
  }
}
"#,
        );
        eprintln!("{}", code);
        // dynamic regions are anchored with comment markers
        assert!(code.contains("document.createComment"));
        // nested JSX compiles to IIFEs
        assert!(code.contains("(() => {"));
        assert!(code.contains("document.createElement(\"li\")"));
        // state read rewritten inside the expressions
        assert!(code.contains("items.get().length === 0"));
        assert!(code.contains("items.get().map(item =>"));
        // the .map param shadows; item is not rewritten
        assert!(code.contains("item.text"));
        assert!(!code.contains("item.get()"));
    }

    #[test]
    fn compiles_child_components_with_reactive_props() {
        let code = compile_ok(
            r#"
component Badge {
  prop count: number = 0
  view {
    <span class="badge">{count}</span>
  }
}

component App {
  let mut clicks = 0
  view {
    <div>
      <button onClick={() => clicks++}>hit</button>
      <Badge count={clicks} />
    </div>
  }
}
"#,
        );
        eprintln!("{}", code);
        // component call with a getter prop (stays reactive)
        assert!(code.contains("Badge({ get count() { return clicks.get(); } })"));
        assert!(code.contains("clicks.set(clicks.get() + 1)"));
        // both components exported
        assert!(code.contains("export function Badge(props)"));
        assert!(code.contains("export function App(props)"));
    }

    #[test]
    fn compiles_component_children_and_fragments() {
        let code = compile_ok(
            r#"
component Card {
  prop title: string = ""
  view {
    <section class="card">
      <h2>{title}</h2>
      {children}
    </section>
  }
}

component Page {
  view {
    <>
      <Card title="Hello">
        <p>Body text</p>
      </Card>
      <footer>fin</footer>
    </>
  }
}
"#,
        );
        eprintln!("{}", code);
        // implicit children prop
        assert!(code.contains("props.children"));
        // children passed as a built fragment
        assert!(code.contains("children: _c"));
        // multi-root view becomes a DocumentFragment
        assert!(code.contains("const _root = document.createDocumentFragment();"));
    }

    #[test]
    fn compiles_inputs_attrs_and_refs() {
        let code = compile_ok(
            r#"
component Form {
  let mut text = ""
  let mut agreed = false

  view {
    <form>
      <input value={text} onInput={e => text = e.target.value} placeholder="type..." />
      <input type="checkbox" checked={agreed} onChange={e => agreed = e.target.checked} />
      <button disabled={text.length === 0} ref={el => console.log(el)}>Send</button>
    </form>
  }
}
"#,
        );
        eprintln!("{}", code);
        // value/checked are DOM properties
        assert!(code.contains("$.setProp(") && code.contains("\"value\""));
        assert!(code.contains("\"checked\""));
        // static attribute set once
        assert!(code.contains(".setAttribute(\"placeholder\", \"type...\")"));
        // dynamic attribute is reactive
        assert!(code.contains("$.setAttr(") && code.contains("\"disabled\""));
        // events write back to state
        assert!(code.contains("text.set(e.target.value)"));
        assert!(code.contains("agreed.set(e.target.checked)"));
        // ref invoked with the element
        assert!(code.contains("(el => console.log(el))(_el"));
    }

    #[test]
    fn passes_through_imports() {
        let code = compile_ok(
            r#"
import { Button } from "./Button.ck"

component App {
  view {
    <div><Button label="go" /></div>
  }
}
"#,
        );
        assert!(code.contains("import { Button } from \"./Button.ck\";"));
        assert!(code.contains("Button({ label: \"go\" })"));
    }

    #[test]
    fn jsx_text_keeps_apostrophes_and_entities() {
        let code = compile_ok(
            r#"
component Hello {
  view {
    <p>don't panic &amp; stay calm</p>
  }
}
"#,
        );
        assert!(code.contains("don't panic & stay calm"));
    }

    #[test]
    fn compiles_fn_component_with_rt() {
        let code = compile_ok(
            r#"
export fn Counter(label: string = "Count", step: number = 1) {
  let mut count = 0
  let doubled => count * 2

  fn inc() {
    count += step
  }

  rt (
    <div class="counter">
      <h1>{label}: {count} (x2 = {doubled})</h1>
      <button onClick={inc}>+</button>
    </div>
  )
}
"#,
        );
        eprintln!("{}", code);
        assert!(code.contains("export function Counter(props)"));
        // fn params become props with defaults
        assert!(code.contains("$.withDefaults(props ?? {}, { label: \"Count\", step: 1 });"));
        assert!(code.contains("count.set(count.get() + (props.step))"));
        assert!(code.contains("const count = $.signal(0);"));
        assert!(code.contains("return _el0;"));
    }

    #[test]
    fn compiles_async_component_with_raw_statements() {
        let code = compile_ok(
            r#"
export async fn Profile(userId: string) {
  const res = await fetch(`/api/users/${userId}`)
  const user = await res.json()

  let mut likes = 0

  fn like() {
    likes += 1
  }

  rt (
    <div class="profile">
      <h1>{user.name}</h1>
      <button onClick={like}>likes: {likes}</button>
    </div>
  )
}
"#,
        );
        eprintln!("{}", code);
        assert!(code.contains("export async function Profile(props)"));
        // raw statements pass through in order, before the reactive decls
        let fetch_pos = code.find("await fetch").unwrap();
        let signal_pos = code.find("$.signal(0)").unwrap();
        assert!(fetch_pos < signal_pos, "raw statements must keep their position");
        assert!(code.contains("const user = await res.json();"));
        // prop read rewritten inside the template literal
        assert!(code.contains("props.userId"));
    }

    #[test]
    fn async_child_components_append_through_runtime() {
        let code = compile_ok(
            r#"
export async fn Loader() {
  const data = await Promise.resolve("hi")
  rt ( <p>{data}</p> )
}

export fn App() {
  rt (
    <main>
      <Loader />
    </main>
  )
}
"#,
        );
        eprintln!("{}", code);
        // components append via $.append so Promise<Node> results work
        assert!(code.contains("$.append(_el0, _el1);") || code.contains("$.append("));
    }

    #[test]
    fn compiles_lowercase_fn_as_plain_function() {
        let code = compile_ok(
            r#"
fn formatName(first: string, last: string): string {
  return `${first} ${last}`
}

export fn Hello(name: string = "world") {
  rt ( <p>{formatName(name, "!")}</p> )
}
"#,
        );
        eprintln!("{}", code);
        assert!(code.contains("export function formatName(first, last)"));
        // type annotations stripped from the body
        assert!(!code.contains(": string"));
    }

    #[test]
    fn strips_types_from_bodies() {
        let code = compile_ok(
            r#"
export fn Typed() {
  const n: number = 1
  const m = n as unknown as number
  const el = null! as HTMLElement
  let mut count = 0

  fn add(x: number, y: Array<number> = []) {
    count += x + (y.length as number)
  }

  rt ( <span>{count + n}</span> )
}
"#,
        );
        eprintln!("{}", code);
        assert!(code.contains("const n = 1;"), "annotation not stripped: {}", code);
        assert!(!code.contains("as unknown"));
        assert!(!code.contains("as number"));
        assert!(!code.contains("as HTMLElement"));
        assert!(!code.contains("null!"));
        assert!(code.contains("const add = (x, y = [])"));
    }

    #[test]
    fn reports_view_syntax_errors() {
        let out = compile(
            r#"
component Broken {
  view {
    <div><span></div>
  }
}
"#,
        );
        assert!(!out.errors.is_empty(), "expected an error");
    }

    #[test]
    fn reports_spread_props_as_unsupported() {
        let out = compile(
            r#"
component App {
  let opts = { a: 1 }
  view {
    <div {...opts} />
  }
}
"#,
        );
        assert!(out.errors.iter().any(|e| e.contains("spread")), "errors: {:?}", out.errors);
    }
}
