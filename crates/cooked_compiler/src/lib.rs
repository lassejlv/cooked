//! Cooked compiler — `.ck` source -> JS module (targeting the `cooked` runtime).

mod ast;
mod codegen;
mod jsx;
mod parser;
mod rewrite;

#[derive(Debug, Clone)]
pub struct CompileOutput {
    pub code: String,
    pub map: String,
    pub declarations: String,
    pub errors: Vec<String>,
}

/// Compile a `.ck` source file into a JS module.
pub fn compile(source: &str) -> CompileOutput {
    compile_with_filename(source, "<cooked>")
}

/// Compile a `.ck` source file into a JS module with source identity for maps and diagnostics.
pub fn compile_with_filename(source: &str, filename: &str) -> CompileOutput {
    let result = parser::parse_file(source).and_then(|file| {
        let declarations = declarations(&file);
        codegen::gen_module(&file, filename).map(|code| (code, declarations))
    });
    match result {
        Ok((code, declarations)) => CompileOutput {
            map: source_map(&code, source, filename),
            declarations,
            code,
            errors: vec![],
        },
        Err(e) => CompileOutput {
            code: String::new(),
            map: String::new(),
            declarations: String::new(),
            errors: vec![format_error(source, filename, &e)],
        },
    }
}

fn declarations(file: &ast::File) -> String {
    let mut out = String::from(
        "type CookedNode = Node | PromiseLike<Node>;\n\
         type CookedProps = Record<string, unknown>;\n\n",
    );

    for f in &file.functions {
        out.push_str(&format!(
            "export function {}(...args: unknown[]): {};\n",
            f.name,
            if f.is_async {
                "Promise<unknown>"
            } else {
                "unknown"
            }
        ));
    }

    for c in &file.components {
        let props = if c.props.is_empty() {
            "CookedProps".to_string()
        } else {
            let fields = c
                .props
                .iter()
                .map(|p| format!("{}?: unknown", p.name))
                .collect::<Vec<_>>()
                .join("; ");
            format!("{{ {} }} & CookedProps", fields)
        };
        out.push_str(&format!(
            "export function {}(props?: {}): {};\n",
            c.name,
            props,
            if c.is_async {
                "PromiseLike<Node>"
            } else {
                "CookedNode"
            }
        ));
    }

    out
}

fn format_error(source: &str, filename: &str, message: &str) -> String {
    if let Some((line, column)) = locate_error(source, message) {
        format!("{filename}:{line}:{column}: {message}")
    } else {
        format!("{filename}: {message}")
    }
}

fn locate_error(source: &str, message: &str) -> Option<(usize, usize)> {
    let needle = quoted_after(message, "found '").or_else(|| quoted_after(message, "in `"))?;
    let trimmed = needle.trim();
    if trimmed.is_empty() || trimmed == "<eof>" {
        return None;
    }
    let byte = source.find(trimmed)?;
    Some(line_col(source, byte))
}

fn quoted_after<'a>(message: &'a str, marker: &str) -> Option<&'a str> {
    let start = message.find(marker)? + marker.len();
    let quote = marker.chars().last()?;
    let rest = &message[start..];
    let end = rest.find(quote)?;
    Some(&rest[..end])
}

fn line_col(source: &str, byte: usize) -> (usize, usize) {
    let mut line = 1;
    let mut column = 1;
    for (i, c) in source.char_indices() {
        if i >= byte {
            break;
        }
        if c == '\n' {
            line += 1;
            column = 1;
        } else {
            column += 1;
        }
    }
    (line, column)
}

fn source_map(code: &str, source: &str, filename: &str) -> String {
    let source_lines: Vec<&str> = source.lines().collect();
    let source_line_count = source_lines.len().max(1);
    let mut mappings = String::new();
    let mut previous_original_line = 0usize;
    for (generated_line, generated) in code.lines().enumerate() {
        if generated_line > 0 {
            mappings.push(';');
        }
        let fallback = generated_line.min(source_line_count - 1);
        let original_line = source_line_for_generated(generated, &source_lines).unwrap_or(fallback);
        let original_line_delta = original_line as i64 - previous_original_line as i64;
        mappings.push_str(&vlq(0)); // generated column
        mappings.push_str(&vlq(0)); // source index
        mappings.push_str(&vlq(original_line_delta));
        mappings.push_str(&vlq(0)); // original column
        previous_original_line = original_line;
    }

    format!(
        "{{\"version\":3,\"sources\":[{}],\"sourcesContent\":[{}],\"names\":[],\"mappings\":{}}}",
        json_string(filename),
        json_string(source),
        json_string(&mappings)
    )
}

fn source_line_for_generated(generated: &str, source_lines: &[&str]) -> Option<usize> {
    let generated = generated.trim();
    if generated.is_empty() || source_lines.is_empty() {
        return None;
    }

    for token in quoted_tokens(generated) {
        if token.len() < 2 || token == "cooked" {
            continue;
        }
        let jsx_token = format!("<{token}");
        if let Some(line) = find_line(source_lines, &jsx_token) {
            return Some(line);
        }
        if let Some(line) = find_line(source_lines, &token) {
            return Some(line);
        }
    }

    if let Some(name) = generated
        .strip_prefix("export function ")
        .and_then(|rest| rest.split('(').next())
    {
        return find_line(source_lines, &format!("fn {name}"));
    }

    if let Some(name) = generated
        .strip_prefix("export async function ")
        .and_then(|rest| rest.split('(').next())
    {
        return find_line(source_lines, &format!("fn {name}"));
    }

    None
}

fn quoted_tokens(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut chars = line.char_indices().peekable();
    while let Some((start, c)) = chars.next() {
        if c != '"' && c != '\'' {
            continue;
        }
        let quote = c;
        let mut escaped = false;
        for (end, d) in chars.by_ref() {
            if escaped {
                escaped = false;
                continue;
            }
            if d == '\\' {
                escaped = true;
                continue;
            }
            if d == quote {
                out.push(line[start + quote.len_utf8()..end].to_string());
                break;
            }
        }
    }
    out
}

fn find_line(lines: &[&str], needle: &str) -> Option<usize> {
    lines.iter().position(|line| line.contains(needle))
}

fn vlq(value: i64) -> String {
    const CHARS: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut n = if value < 0 {
        ((-value) as u64) << 1 | 1
    } else {
        (value as u64) << 1
    };
    let mut out = String::new();
    loop {
        let mut digit = (n & 0b11111) as u8;
        n >>= 5;
        if n > 0 {
            digit |= 0b100000;
        }
        out.push(CHARS[digit as usize] as char);
        if n == 0 {
            break;
        }
    }
    out
}

fn json_string(value: &str) -> String {
    let mut out = String::from("\"");
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if c.is_control() => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
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
        assert!(
            code.contains("const count = $.signal(0);"),
            "signal decl missing"
        );
        assert!(
            code.contains("const doubled = $.memo(() => count.get() * 2);"),
            "memo decl missing"
        );
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
    fn compiles_keyed_list() {
        let code = compile_ok(
            r#"
component TodoItem {
  prop text: string = ""
  view { <li>{text}</li> }
}

component TodoList {
  let mut items = []

  view {
    <ul>
      <Keyed each={items} by={item => item.id}>
        {item => <TodoItem text={item.text} />}
      </Keyed>
    </ul>
  }
}
"#,
        );
        eprintln!("{}", code);
        assert!(code.contains("$.keyed("));
        assert!(code.contains("() => items.get()"));
        assert!(code.contains("item => item.id"));
        assert!(code.contains("item => (() =>"));
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
    fn emits_hot_registration_for_components() {
        let out = compile_with_filename(
            r#"
export fn App() {
  rt ( <main>hi</main> )
}
"#,
            "/src/App.ck",
        );
        assert!(out.errors.is_empty(), "errors: {:?}", out.errors);
        assert!(out.code.contains("$.hot(App, \"/src/App.ck\", \"App\");"));
        assert!(out.code.contains("import.meta.hot.accept"));
        assert!(out.code.contains("$.replaceHot(\"/src/App.ck\", mod)"));
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
        assert!(
            fetch_pos < signal_pos,
            "raw statements must keep their position"
        );
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
        assert!(
            code.contains("const n = 1;"),
            "annotation not stripped: {}",
            code
        );
        assert!(!code.contains("as unknown"));
        assert!(!code.contains("as number"));
        assert!(!code.contains("as HTMLElement"));
        assert!(!code.contains("null!"));
        assert!(code.contains("const add = (x, y = [])"));
    }

    #[test]
    fn reports_view_syntax_errors() {
        let out = compile_with_filename(
            r#"
component Broken {
  view {
    <div><span></div>
  }
}
"#,
            "Broken.ck",
        );
        assert!(!out.errors.is_empty(), "expected an error");
        assert!(
            out.errors[0].contains("Broken.ck:"),
            "expected filename in error: {:?}",
            out.errors
        );
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
        assert!(
            out.errors.iter().any(|e| e.contains("spread")),
            "errors: {:?}",
            out.errors
        );
    }

    #[test]
    fn emits_source_map_with_source_content() {
        let src = r#"
export fn Hello(name: string = "cook") {
  rt ( <p>Hello {name}</p> )
}
"#;
        let out = compile_with_filename(src, "Hello.ck");
        assert!(out.errors.is_empty(), "errors: {:?}", out.errors);
        assert!(out.map.contains("\"version\":3"));
        assert!(out.map.contains("\"sources\":[\"Hello.ck\"]"));
        assert!(out.map.contains("export fn Hello"));
        assert!(out.map.contains("\"mappings\":"));
    }

    #[test]
    fn emits_declarations_for_named_exports() {
        let src = r#"
fn formatName(name: string): string {
  return name
}

export async fn Profile(userId: string) {
  rt ( <p>{userId}</p> )
}
"#;
        let out = compile_with_filename(src, "Profile.ck");
        assert!(out.errors.is_empty(), "errors: {:?}", out.errors);
        assert!(out.declarations.contains("export function formatName"));
        assert!(out.declarations.contains("export function Profile"));
        assert!(out.declarations.contains("userId?: unknown"));
        assert!(out.declarations.contains("PromiseLike<Node>"));
    }
}
