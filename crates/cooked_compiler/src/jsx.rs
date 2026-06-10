//! JSX view codegen: oxc JSX AST -> imperative DOM statements.
//!
//! The `view { ... }` body is parsed as a real JSX fragment by oxc, then walked
//! to emit `document.createElement` trees with reactive spots wired through
//! `$.insert` / `$.setAttr` / `$.setProp` / `$.setStyle` / `$.listen`.
//!
//! JSX that appears *inside* expressions (`{cond ? <a/> : <b/>}`,
//! `{items.map(i => <li/>)}`) is compiled by `rewrite.rs` calling back into
//! [`gen_element_expr`] / [`gen_fragment_expr`], which wrap the same generator
//! in an IIFE.

use std::collections::HashSet;

use oxc::allocator::Allocator;
use oxc::ast::ast::*;
use oxc::parser::Parser;
use oxc::span::{GetSpan, SourceType, Span};

use crate::rewrite::{rewrite_expr_with, SymbolMap};

pub struct ViewCode {
    pub stmts: String,
    pub root: String,
}

/// Compile a raw `view { ... }` body (JSX) into statements + a root expression.
pub fn gen_view(body: &str, map: &SymbolMap) -> Result<ViewCode, String> {
    if body.trim().is_empty() {
        return Ok(ViewCode {
            stmts: String::new(),
            root: "document.createDocumentFragment()".into(),
        });
    }
    let src = format!("<>{}</>", body);
    let allocator = Allocator::default();
    let ret = Parser::new(&allocator, &src, SourceType::tsx()).parse();
    if !ret.errors.is_empty() {
        let msgs: Vec<String> = ret.errors.iter().map(|e| e.to_string()).collect();
        return Err(format!("view: {}", msgs.join("; ")));
    }
    let frag = match ret.program.body.first() {
        Some(Statement::ExpressionStatement(es)) => match &es.expression {
            Expression::JSXFragment(f) => f,
            _ => return Err("view: expected JSX markup".into()),
        },
        _ => return Err("view: expected JSX markup".into()),
    };

    let shadows = HashSet::new();
    let mut g = Gen {
        src: &src,
        map,
        shadows: &shadows,
        out: String::new(),
        counter: 0,
        indent: "  ",
    };
    let kids: Vec<&JSXChild> = frag.children.iter().filter(|c| !is_blank(c)).collect();
    if kids.len() == 1 {
        if let JSXChild::Element(el) = kids[0] {
            let var = g.gen_element(el, None)?;
            return Ok(ViewCode {
                stmts: g.out,
                root: var,
            });
        }
    }
    g.stmt("const _root = document.createDocumentFragment();");
    for k in kids {
        g.gen_child(k, "_root")?;
    }
    Ok(ViewCode {
        stmts: g.out,
        root: "_root".into(),
    })
}

/// Compile a JSX element found inside an expression into an IIFE.
pub fn gen_element_expr(
    el: &JSXElement,
    src: &str,
    map: &SymbolMap,
    shadows: &HashSet<String>,
) -> Result<String, String> {
    let mut g = Gen {
        src,
        map,
        shadows,
        out: String::new(),
        counter: 0,
        indent: "",
    };
    let var = g.gen_element(el, None)?;
    Ok(format!(
        "(() => {{ {} return {}; }})()",
        g.out.trim_end(),
        var
    ))
}

/// Compile a JSX fragment found inside an expression into an IIFE.
pub fn gen_fragment_expr(
    fr: &JSXFragment,
    src: &str,
    map: &SymbolMap,
    shadows: &HashSet<String>,
) -> Result<String, String> {
    let mut g = Gen {
        src,
        map,
        shadows,
        out: String::new(),
        counter: 0,
        indent: "",
    };
    g.stmt("const _frag = document.createDocumentFragment();");
    for c in fr.children.iter().filter(|c| !is_blank(c)) {
        g.gen_child(c, "_frag")?;
    }
    Ok(format!(
        "(() => {{ {} return _frag; }})()",
        g.out.trim_end()
    ))
}

fn is_blank(child: &JSXChild) -> bool {
    match child {
        JSXChild::Text(t) => jsx_text(&t.value).is_empty(),
        JSXChild::ExpressionContainer(c) => {
            matches!(c.expression, JSXExpression::EmptyExpression(_))
        }
        _ => false,
    }
}

struct Gen<'a> {
    src: &'a str,
    map: &'a SymbolMap,
    /// Names shadowed by enclosing fragments (e.g. `.map(item => ...)` params).
    shadows: &'a HashSet<String>,
    out: String,
    counter: usize,
    indent: &'a str,
}

impl<'a> Gen<'a> {
    fn fresh(&mut self, prefix: &str) -> String {
        let v = format!("_{}{}", prefix, self.counter);
        self.counter += 1;
        v
    }

    fn stmt(&mut self, s: &str) {
        self.out.push_str(self.indent);
        self.out.push_str(s);
        if self.indent.is_empty() {
            self.out.push(' ');
        } else {
            self.out.push('\n');
        }
    }

    fn slice(&self, span: Span) -> &str {
        &self.src[span.start as usize..span.end as usize]
    }

    fn rewrite(&self, span: Span) -> Result<String, String> {
        rewrite_expr_with(self.slice(span), self.map, self.shadows)
    }

    fn name_of(&self, name: &JSXElementName) -> Result<(String, bool), String> {
        match name {
            JSXElementName::Identifier(id) => {
                let n = id.name.to_string();
                let comp = n.chars().next().is_some_and(|c| c.is_ascii_uppercase());
                Ok((n, comp))
            }
            JSXElementName::IdentifierReference(id) => Ok((id.name.to_string(), true)),
            JSXElementName::MemberExpression(me) => Ok((self.slice(me.span).to_string(), true)),
            JSXElementName::NamespacedName(_) => {
                Err("view: namespaced tag names are not supported".into())
            }
            JSXElementName::ThisExpression(_) => Err("view: `<this>` is not supported".into()),
        }
    }

    /// Emit code building `el`; append to `parent` when given. Returns the var.
    fn gen_element(&mut self, el: &JSXElement, parent: Option<&str>) -> Result<String, String> {
        let (name, is_component) = self.name_of(&el.opening_element.name)?;
        if name == "Keyed" {
            return self.gen_keyed(el, parent);
        }
        if is_component {
            return self.gen_component(el, &name, parent);
        }
        let var = self.fresh("el");
        self.stmt(&format!(
            "const {} = document.createElement({});",
            var,
            js_string(&name)
        ));
        for item in &el.opening_element.attributes {
            self.gen_dom_attr(&var, item)?;
        }
        for child in el.children.iter().filter(|c| !is_blank(c)) {
            self.gen_child(child, &var)?;
        }
        if let Some(p) = parent {
            self.stmt(&format!("{}.appendChild({});", p, var));
        }
        Ok(var)
    }

    fn gen_dom_attr(&mut self, var: &str, item: &JSXAttributeItem) -> Result<(), String> {
        let attr = match item {
            JSXAttributeItem::Attribute(a) => a,
            JSXAttributeItem::SpreadAttribute(a) => {
                let expr = self.rewrite(a.argument.span())?;
                self.stmt(&format!("$.spread({}, () => {});", var, expr));
                return Ok(());
            }
        };
        let name = match &attr.name {
            JSXAttributeName::Identifier(id) => id.name.to_string(),
            JSXAttributeName::NamespacedName(_) => {
                return Err("view: namespaced attributes are not supported".into());
            }
        };
        let value = self.attr_value(&name, &attr.value)?;

        if name == "ref" {
            return match value {
                AttrValue::Expr(e) => {
                    self.stmt(&format!("({})({});", e, var));
                    Ok(())
                }
                _ => Err("view: `ref` must be a function expression, e.g. ref={el => ...}".into()),
            };
        }
        if let Some(event) = event_name(&name) {
            return match value {
                AttrValue::Expr(e) => {
                    self.stmt(&format!("$.listen({}, {}, {});", var, js_string(&event), e));
                    Ok(())
                }
                _ => Err(format!(
                    "view: event `{}` needs an expression handler",
                    name
                )),
            };
        }
        match name.as_str() {
            "class" | "className" => match value {
                AttrValue::Str(s) => self.stmt(&format!("{}.className = {};", var, js_string(&s))),
                AttrValue::Expr(e) => {
                    self.stmt(&format!("$.setAttr({}, \"class\", () => {});", var, e))
                }
                AttrValue::None => return Err("view: `class` needs a value".into()),
            },
            "style" => match value {
                AttrValue::Str(s) => self.stmt(&format!(
                    "{}.setAttribute(\"style\", {});",
                    var,
                    js_string(&s)
                )),
                AttrValue::Expr(e) => self.stmt(&format!("$.setStyle({}, () => {});", var, e)),
                AttrValue::None => return Err("view: `style` needs a value".into()),
            },
            // Form state lives on DOM properties, not attributes.
            "value" | "checked" => match value {
                AttrValue::Expr(e) => self.stmt(&format!(
                    "$.setProp({}, {}, () => {});",
                    var,
                    js_string(&name),
                    e
                )),
                AttrValue::Str(s) => self.stmt(&format!("{}.{} = {};", var, name, js_string(&s))),
                AttrValue::None => self.stmt(&format!("{}.{} = true;", var, name)),
            },
            _ => match value {
                AttrValue::None => self.stmt(&format!(
                    "{}.setAttribute({}, \"\");",
                    var,
                    js_string(&name)
                )),
                AttrValue::Str(s) => self.stmt(&format!(
                    "{}.setAttribute({}, {});",
                    var,
                    js_string(&name),
                    js_string(&s)
                )),
                AttrValue::Expr(e) => self.stmt(&format!(
                    "$.setAttr({}, {}, () => {});",
                    var,
                    js_string(&name),
                    e
                )),
            },
        }
        Ok(())
    }

    fn attr_value(
        &mut self,
        name: &str,
        value: &Option<JSXAttributeValue>,
    ) -> Result<AttrValue, String> {
        Ok(match value {
            None => AttrValue::None,
            Some(JSXAttributeValue::StringLiteral(s)) => AttrValue::Str(s.value.to_string()),
            Some(JSXAttributeValue::ExpressionContainer(c)) => match &c.expression {
                JSXExpression::EmptyExpression(_) => {
                    return Err(format!(
                        "view: attribute `{}` has an empty expression",
                        name
                    ));
                }
                expr => AttrValue::Expr(self.rewrite(expr.span())?),
            },
            Some(JSXAttributeValue::Element(el)) => AttrValue::Expr(self.rewrite(el.span)?),
            Some(JSXAttributeValue::Fragment(fr)) => AttrValue::Expr(self.rewrite(fr.span)?),
        })
    }

    fn gen_child(&mut self, child: &JSXChild, parent: &str) -> Result<(), String> {
        match child {
            JSXChild::Text(t) => {
                let text = jsx_text(&t.value);
                if !text.is_empty() {
                    self.stmt(&format!(
                        "{}.appendChild(document.createTextNode({}));",
                        parent,
                        js_string(&text)
                    ));
                }
            }
            JSXChild::Element(el) => {
                self.gen_element(el, Some(parent))?;
            }
            JSXChild::Fragment(fr) => {
                for c in fr.children.iter().filter(|c| !is_blank(c)) {
                    self.gen_child(c, parent)?;
                }
            }
            JSXChild::ExpressionContainer(c) => match &c.expression {
                JSXExpression::EmptyExpression(_) => {} // {/* comment */}
                JSXExpression::StringLiteral(s) => self.stmt(&format!(
                    "{}.appendChild(document.createTextNode({}));",
                    parent,
                    js_string(&s.value)
                )),
                JSXExpression::NumericLiteral(n) => self.stmt(&format!(
                    "{}.appendChild(document.createTextNode({}));",
                    parent,
                    js_string(self.slice(n.span))
                )),
                expr => {
                    let code = self.rewrite(expr.span())?;
                    // A comment marker keeps the dynamic region anchored among
                    // its static siblings.
                    let m = self.fresh("m");
                    self.stmt(&format!("const {} = document.createComment(\"\");", m));
                    self.stmt(&format!("{}.appendChild({});", parent, m));
                    self.stmt(&format!("$.insert({}, () => {}, {});", parent, code, m));
                }
            },
            JSXChild::Spread(_) => return Err("view: spread children are not supported".into()),
        }
        Ok(())
    }

    fn gen_component(
        &mut self,
        el: &JSXElement,
        name: &str,
        parent: Option<&str>,
    ) -> Result<String, String> {
        let mut prop_args: Vec<String> = vec![];
        let mut prop_object: Vec<String> = vec![];
        for item in &el.opening_element.attributes {
            let attr = match item {
                JSXAttributeItem::Attribute(a) => a,
                JSXAttributeItem::SpreadAttribute(a) => {
                    if !prop_object.is_empty() {
                        prop_args.push(format!(
                            "{{ {} }}",
                            std::mem::take(&mut prop_object).join(", ")
                        ));
                    }
                    prop_args.push(self.rewrite(a.argument.span())?);
                    continue;
                }
            };
            let pname = match &attr.name {
                JSXAttributeName::Identifier(id) => id.name.to_string(),
                JSXAttributeName::NamespacedName(_) => {
                    return Err("view: namespaced props are not supported".into());
                }
            };
            let key = prop_key(&pname);
            match self.attr_value(&pname, &attr.value)? {
                AttrValue::None => prop_object.push(format!("{}: true", key)),
                AttrValue::Str(s) => prop_object.push(format!("{}: {}", key, js_string(&s))),
                // Getter keeps the prop reactive without evaluating it eagerly.
                AttrValue::Expr(e) => {
                    prop_object.push(format!("get {}() {{ return {}; }}", key, e))
                }
            }
        }

        let kids: Vec<&JSXChild> = el.children.iter().filter(|c| !is_blank(c)).collect();
        if !kids.is_empty() {
            let cv = self.fresh("c");
            self.stmt(&format!(
                "const {} = document.createDocumentFragment();",
                cv
            ));
            for k in kids {
                self.gen_child(k, &cv)?;
            }
            prop_object.push(format!("children: {}", cv));
        }
        if !prop_object.is_empty() {
            prop_args.push(format!("{{ {} }}", prop_object.join(", ")));
        }

        let var = self.fresh("el");
        let props_expr = if prop_args.is_empty() {
            "{}".to_string()
        } else {
            format!("$.mergeProps({})", prop_args.join(", "))
        };
        self.stmt(&format!("const {} = {}({});", var, name, props_expr));
        if let Some(p) = parent {
            // $.append handles async components (Promise<Node>) with a marker.
            self.stmt(&format!("$.append({}, {});", p, var));
        }
        Ok(var)
    }

    fn gen_keyed(&mut self, el: &JSXElement, parent: Option<&str>) -> Result<String, String> {
        let mut each = None;
        let mut by = None;

        for item in &el.opening_element.attributes {
            let attr = match item {
                JSXAttributeItem::Attribute(a) => a,
                JSXAttributeItem::SpreadAttribute(_) => {
                    return Err("view: `<Keyed>` does not support spread attributes".into());
                }
            };
            let name = match &attr.name {
                JSXAttributeName::Identifier(id) => id.name.to_string(),
                JSXAttributeName::NamespacedName(_) => {
                    return Err("view: `<Keyed>` attributes must not be namespaced".into());
                }
            };
            match (name.as_str(), self.attr_value(&name, &attr.value)?) {
                ("each", AttrValue::Expr(e)) => each = Some(e),
                ("by" | "key", AttrValue::Expr(e)) => by = Some(e),
                ("each" | "by" | "key", _) => {
                    return Err(format!(
                        "view: `<Keyed>` attribute `{}` must be an expression",
                        name
                    ));
                }
                _ => return Err(format!("view: unsupported `<Keyed>` attribute `{}`", name)),
            }
        }

        let each = each.ok_or_else(|| "view: `<Keyed>` needs `each={items}`".to_string())?;
        let by = by.ok_or_else(|| "view: `<Keyed>` needs `by={item => key}`".to_string())?;

        let kids: Vec<&JSXChild> = el.children.iter().filter(|c| !is_blank(c)).collect();
        if kids.len() != 1 {
            return Err("view: `<Keyed>` needs exactly one expression child".into());
        }
        let render = match kids[0] {
            JSXChild::ExpressionContainer(c) => match &c.expression {
                JSXExpression::EmptyExpression(_) => {
                    return Err("view: `<Keyed>` render expression cannot be empty".into());
                }
                expr => self.rewrite(expr.span())?,
            },
            _ => return Err("view: `<Keyed>` child must be a render expression".into()),
        };

        let host = if let Some(p) = parent {
            p.to_string()
        } else {
            let root = self.fresh("root");
            self.stmt(&format!(
                "const {} = document.createDocumentFragment();",
                root
            ));
            root
        };
        let marker = self.fresh("m");
        self.stmt(&format!("const {} = document.createComment(\"\");", marker));
        self.stmt(&format!("{}.appendChild({});", host, marker));
        self.stmt(&format!(
            "$.keyed({}, () => {}, {}, {}, {});",
            host, each, by, render, marker
        ));
        Ok(if parent.is_some() { marker } else { host })
    }
}

enum AttrValue {
    None,
    Str(String),
    Expr(String),
}

/// `onClick` / `onclick` -> `click`; anything else -> None.
fn event_name(attr: &str) -> Option<String> {
    let rest = attr.strip_prefix("on")?;
    let first = rest.chars().next()?;
    if first.is_ascii_alphabetic() {
        Some(rest.to_lowercase())
    } else {
        None
    }
}

/// Object key for a component prop: bare identifier when valid, quoted otherwise.
fn prop_key(name: &str) -> String {
    let valid = !name.is_empty()
        && name
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_' || c == '$')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$');
    if valid {
        name.to_string()
    } else {
        js_string(name)
    }
}

/// JSX text semantics: trim whitespace around newlines, collapse interior
/// newline runs to a single space, decode common HTML entities.
fn jsx_text(raw: &str) -> String {
    let lines: Vec<&str> = raw.split('\n').collect();
    let n = lines.len();
    let mut parts: Vec<&str> = vec![];
    for (i, line) in lines.iter().enumerate() {
        let mut l: &str = line;
        if i > 0 {
            l = l.trim_start();
        }
        if i < n - 1 {
            l = l.trim_end();
        }
        if !l.is_empty() {
            parts.push(l);
        }
    }
    decode_entities(&parts.join(" "))
}

fn decode_entities(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '&' {
            if let Some(semi) = chars[i + 1..].iter().take(10).position(|&c| c == ';') {
                let entity: String = chars[i + 1..i + 1 + semi].iter().collect();
                let decoded = match entity.as_str() {
                    "amp" => Some('&'),
                    "lt" => Some('<'),
                    "gt" => Some('>'),
                    "quot" => Some('"'),
                    "apos" => Some('\''),
                    "nbsp" => Some('\u{a0}'),
                    _ => {
                        if let Some(hex) = entity.strip_prefix("#x").or(entity.strip_prefix("#X")) {
                            u32::from_str_radix(hex, 16).ok().and_then(char::from_u32)
                        } else if let Some(dec) = entity.strip_prefix('#') {
                            dec.parse::<u32>().ok().and_then(char::from_u32)
                        } else {
                            None
                        }
                    }
                };
                if let Some(c) = decoded {
                    out.push(c);
                    i += semi + 2;
                    continue;
                }
            }
        }
        out.push(chars[i]);
        i += 1;
    }
    out
}

/// JS double-quoted string literal.
pub fn js_string(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}
