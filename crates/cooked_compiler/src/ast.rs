//! Cooked AST. Expression-level TypeScript is kept as raw source text (captured
//! spans) and handed to oxc later for reactive rewriting + type stripping. The
//! `rt ( ... )` / `view { ... }` body is raw JSX text, parsed by oxc in the
//! codegen phase.

#[derive(Debug, Clone)]
pub struct File {
    /// Top-level `import ...` statements, passed through verbatim.
    pub imports: Vec<String>,
    pub components: Vec<Component>,
    /// Lowercase top-level `fn`s: plain helper functions, passed through
    /// (types stripped, JSX-in-expressions compiled).
    pub functions: Vec<RawFn>,
}

#[derive(Debug, Clone)]
pub struct Component {
    pub name: String,
    /// `async fn` — emitted as an async function; `await` works in the body.
    pub is_async: bool,
    pub props: Vec<Prop>,
    /// Body in source order. Raw TS statements interleave with reactive
    /// declarations; `rt (...)` compiles to the returned DOM tree in place.
    pub items: Vec<Item>,
}

#[derive(Debug, Clone)]
pub enum Item {
    State(Binding),   // let mut x = ...
    Derived(Binding), // let x => ...
    Const(Binding),   // let x = ...
    Fn(Func),         // fn name(...) { ... }
    Effect(String),   // effect { ... }
    Raw(String),      // any other TS statement, passed through (rewritten)
    View(String),     // rt ( ...jsx... ) or view { ...jsx... }
}

#[derive(Debug, Clone)]
pub struct RawFn {
    pub name: String,
    pub is_async: bool,
    pub params: String, // raw param list text (types stripped at codegen)
    pub body: String,   // raw statement-block body
}

#[derive(Debug, Clone)]
pub struct Prop {
    pub name: String,
    pub default: Option<String>, // raw expr text; type annotations are dropped
}

#[derive(Debug, Clone)]
pub struct Binding {
    pub name: String,
    pub expr: String, // raw expr text
}

#[derive(Debug, Clone)]
pub struct Func {
    pub name: String,
    pub params: String, // raw param list text (types stripped at codegen)
    pub body: String,   // raw statement-block body
}
