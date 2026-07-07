//! Codegen: Cooked component AST -> JS module targeting the `cooked` runtime.
//!
//! Imperative DOM construction (createElement + appendChild) with reactive spots
//! wired through `$.insert` / `$.setAttr` / `$.setProp` / `$.listen`. No virtual DOM.

use crate::ast::*;
use crate::jsx;
use crate::jsx::js_string;
use crate::rewrite::{rewrite_expr, rewrite_ts, Kind, SymbolMap};

pub fn gen_module(file: &File, filename: &str) -> Result<String, String> {
    let mut out = String::from("import * as $ from \"@cookedjs/cooked\";\n");
    for imp in &file.imports {
        out.push_str(imp);
        out.push_str(";\n");
    }
    out.push('\n');
    for f in &file.functions {
        out.push_str(&gen_raw_fn(f).map_err(|e| format!("fn {}: {}", f.name, e))?);
        out.push('\n');
    }
    for raw in &file.raws {
        // Strip TypeScript from the pass-through statement (annotations in
        // validators etc.) — the emitted module is plain JS.
        let js = rewrite_ts(raw, &SymbolMap::default())
            .map_err(|e| format!("export statement: {}", e))?;
        out.push_str(js.trim_end());
        out.push('\n');
    }
    for comp in &file.components {
        out.push_str(&gen_component(comp).map_err(|e| format!("component {}: {}", comp.name, e))?);
        out.push_str(&format!(
            "$.hot({}, {}, {});\n",
            comp.name,
            js_string(filename),
            js_string(&comp.name)
        ));
        out.push('\n');
    }
    if !file.components.is_empty() {
        out.push_str(&format!(
            "if (import.meta.hot) {{ import.meta.hot.accept((mod) => $.replaceHot({}, mod)); }}\n",
            js_string(filename)
        ));
    }
    Ok(out)
}

fn build_symbols(comp: &Component) -> SymbolMap {
    let mut map = SymbolMap::new();
    // Implicit: nested markup passed by a parent (`<Card>...</Card>`).
    map.insert("children".to_string(), Kind::Prop);
    for p in &comp.props {
        map.insert(p.name.clone(), Kind::Prop);
    }
    for item in &comp.items {
        match item {
            Item::State(b) => {
                map.insert(b.name.clone(), Kind::State);
            }
            Item::Derived(b) => {
                map.insert(b.name.clone(), Kind::Derived);
            }
            Item::Const(b) => {
                map.insert(b.name.clone(), Kind::Local);
            }
            Item::Fn(f) => {
                map.insert(f.name.clone(), Kind::Fn);
            }
            Item::Effect(_) | Item::Raw(_) | Item::View(_) => {}
        }
    }
    map
}

fn gen_component(comp: &Component) -> Result<String, String> {
    let map = build_symbols(comp);
    let mut b = String::new();
    let asyncness = if comp.is_async { "async " } else { "" };
    b.push_str(&format!(
        "export {}function {}(props) {{\n",
        asyncness, comp.name
    ));

    // prop defaults
    let mut defaults: Vec<String> = vec![];
    for p in &comp.props {
        if let Some(d) = &p.default {
            defaults.push(format!("{}: {}", p.name, rewrite_expr(d, &map)?));
        }
    }
    b.push_str(&format!(
        "  props = $.withDefaults(props ?? {{}}, {{ {} }});\n",
        defaults.join(", ")
    ));

    // body in source order; `rt (...)` compiles to the returned DOM tree
    let mut has_view = false;
    for item in &comp.items {
        match item {
            Item::State(s) => b.push_str(&format!(
                "  const {} = $.signal({});\n",
                s.name,
                rewrite_expr(&s.expr, &map)?
            )),
            Item::Derived(d) => b.push_str(&format!(
                "  const {} = $.memo(() => {});\n",
                d.name,
                rewrite_expr(&d.expr, &map)?
            )),
            Item::Const(c) => b.push_str(&format!(
                "  const {} = {};\n",
                c.name,
                rewrite_expr(&c.expr, &map)?
            )),
            Item::Fn(f) => b.push_str(&format!(
                "  const {} = {}({}) => {{ {} }};\n",
                f.name,
                if f.is_async { "async " } else { "" },
                strip_params(&f.params),
                rewrite_ts(&f.body, &map)?
            )),
            Item::Effect(e) => b.push_str(&format!(
                "  $.effect(() => {{ {} }});\n",
                rewrite_ts(e, &map)?
            )),
            Item::Raw(stmt) => {
                let code = rewrite_ts(stmt, &map)?;
                let code = code.trim_end();
                let semi = if code.ends_with(';') || code.ends_with('}') {
                    ""
                } else {
                    ";"
                };
                b.push_str(&format!("  {}{}\n", code, semi));
            }
            Item::View(view_src) => {
                let view = jsx::gen_view(view_src, &map)?;
                b.push_str(&view.stmts);
                b.push_str(&format!("  return {};\n", view.root));
                has_view = true;
            }
        }
    }
    if !has_view {
        return Err("missing a view — end the component with `rt ( <... /> )`".into());
    }

    b.push_str("}\n");
    Ok(b)
}

/// Lowercase top-level `fn`: a plain function, passed through with types
/// stripped and JSX-in-expressions compiled (no reactive scope).
fn gen_raw_fn(f: &RawFn) -> Result<String, String> {
    let map = SymbolMap::new();
    let asyncness = if f.is_async { "async " } else { "" };
    Ok(format!(
        "export {}function {}({}) {{ {} }}\n",
        asyncness,
        f.name,
        strip_params(&f.params),
        rewrite_ts(&f.body, &map)?
    ))
}

/// Strip TS types from a raw parameter list, keeping defaults:
/// `id: string, n: number = 0` -> `id, n = 0`.
fn strip_params(params: &str) -> String {
    if params.trim().is_empty() {
        return String::new();
    }
    split_top_level(params, ',')
        .into_iter()
        .map(|p| {
            let p = p.trim();
            // the binding name runs up to a top-level ':' (type annotation)
            match find_top_level(p, ':') {
                Some(i) => {
                    let name = p[..i].trim().trim_end_matches('?');
                    match crate::parser::find_default_eq(&p[i..]) {
                        Some(j) => format!("{} = {}", name, p[i + j + 1..].trim()),
                        None => name.to_string(),
                    }
                }
                None => p.to_string(),
            }
        })
        .filter(|p| !p.is_empty())
        .collect::<Vec<_>>()
        .join(", ")
}

fn split_top_level(s: &str, sep: char) -> Vec<String> {
    let mut out = vec![];
    let mut depth = 0i32;
    let mut cur = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '(' | '[' | '{' | '<' => {
                depth += 1;
                cur.push(c);
            }
            ')' | ']' | '}' | '>' => {
                depth -= 1;
                cur.push(c);
            }
            '"' | '\'' | '`' => {
                cur.push(c);
                for d in chars.by_ref() {
                    cur.push(d);
                    if d == c {
                        break;
                    }
                }
            }
            _ if c == sep && depth == 0 => {
                out.push(std::mem::take(&mut cur));
            }
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

fn find_top_level(s: &str, target: char) -> Option<usize> {
    let mut depth = 0i32;
    let mut chars = s.char_indices().peekable();
    while let Some((i, c)) = chars.next() {
        match c {
            '(' | '[' | '{' | '<' => depth += 1,
            ')' | ']' | '}' | '>' => depth -= 1,
            '"' | '\'' | '`' => {
                for (_, d) in chars.by_ref() {
                    if d == c {
                        break;
                    }
                }
            }
            _ if c == target && depth == 0 => return Some(i),
            _ => {}
        }
    }
    None
}
