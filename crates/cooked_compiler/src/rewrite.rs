//! Reactive expression rewriting via oxc.
//!
//! Parses a TypeScript (TSX) fragment, finds references/assignments to
//! reactive bindings, and rewrites:
//!   - state/derived reads  `count`        -> `count.get()`
//!   - prop reads           `label`        -> `props.label`
//!   - state writes         `count += 1`   -> `count.set(count.get() + (1))`
//!   - state updates        `count++`      -> `count.set(count.get() + 1)`
//!
//! JSX embedded in an expression (`cond ? <a/> : <b/>`, `items.map(i => <li/>)`)
//! is compiled to a DOM-building IIFE via `jsx::gen_element_expr`.
//!
//! Edits are collected as non-overlapping byte-range replacements and applied
//! right-to-left so earlier offsets stay valid.

use std::collections::{HashMap, HashSet};

use oxc::allocator::Allocator;
use oxc::ast::ast::*;
use oxc::ast::visit::walk;
use oxc::ast::Visit;
use oxc::parser::Parser;
use oxc::span::{GetSpan, SourceType};
use oxc::syntax::operator::{AssignmentOperator, UpdateOperator};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Kind {
    State,
    Derived,
    Prop,
    Local,
    Fn,
}

pub type SymbolMap = HashMap<String, Kind>;

struct Edit {
    start: usize,
    end: usize,
    text: String,
}

/// Rewrite a statement-position TS fragment (fn/effect bodies, raw component
/// statements). Parsed inside an `async function` wrapper so `return` and
/// `await` are valid; the wrapper is stripped from the result.
pub fn rewrite_ts(fragment: &str, map: &SymbolMap) -> Result<String, String> {
    if fragment.trim().is_empty() {
        return Ok(String::new());
    }
    const HEAD: &str = "async function __ck(){\n";
    const TAIL: &str = "\n}";
    let wrapped = format!("{}{}{}", HEAD, fragment.trim(), TAIL);
    let out = rewrite_inner(&wrapped, map, &HashSet::new())?;
    Ok(out[HEAD.len()..out.len() - TAIL.len()].to_string())
}

/// Rewrite an expression-position TS fragment. Wrapping in parentheses keeps
/// object literals and JSX parsing as expressions rather than statements.
pub fn rewrite_expr(fragment: &str, map: &SymbolMap) -> Result<String, String> {
    rewrite_expr_with(fragment, map, &HashSet::new())
}

/// Like [`rewrite_expr`], with names already shadowed by an enclosing fragment
/// (used when recursing through JSX nested in expressions).
pub fn rewrite_expr_with(
    fragment: &str,
    map: &SymbolMap,
    inherited: &HashSet<String>,
) -> Result<String, String> {
    let trimmed = fragment.trim();
    if trimmed.is_empty() {
        return Ok(String::new());
    }
    let wrapped = format!("({})", trimmed);
    let out = rewrite_inner(&wrapped, map, inherited)?;
    Ok(out[1..out.len() - 1].to_string())
}

fn rewrite_inner(
    fragment: &str,
    map: &SymbolMap,
    inherited: &HashSet<String>,
) -> Result<String, String> {
    if fragment.trim().is_empty() {
        return Ok(String::new());
    }
    let allocator = Allocator::default();
    let ret = Parser::new(&allocator, fragment, SourceType::tsx()).parse();
    if !ret.errors.is_empty() {
        let msgs: Vec<String> = ret.errors.iter().map(|e| e.to_string()).collect();
        return Err(format!("in `{}`: {}", excerpt(fragment), msgs.join("; ")));
    }

    // Pass 1: names bound locally inside this fragment shadow reactive ones.
    let mut shadows = ShadowCollector {
        names: inherited.clone(),
    };
    shadows.visit_program(&ret.program);

    // Pass 2: collect rewrite edits.
    let mut collector = Collector {
        map,
        shadowed: &shadows.names,
        src: fragment,
        edits: vec![],
        errors: vec![],
    };
    collector.visit_program(&ret.program);
    if !collector.errors.is_empty() {
        return Err(collector.errors.join("; "));
    }

    let mut edits = collector.edits;
    // Apply right-to-left; ties broken so wider/earlier-ending edits stay valid.
    edits.sort_by(|a, b| b.start.cmp(&a.start).then(b.end.cmp(&a.end)));

    let mut bytes = fragment.to_string();
    for e in edits {
        bytes.replace_range(e.start..e.end, &e.text);
    }
    Ok(bytes)
}

fn excerpt(s: &str) -> String {
    let s = s.trim();
    if s.len() > 40 {
        format!(
            "{}…",
            &s[..s
                .char_indices()
                .take(40)
                .last()
                .map(|(i, c)| i + c.len_utf8())
                .unwrap_or(0)]
        )
    } else {
        s.to_string()
    }
}

struct ShadowCollector {
    names: HashSet<String>,
}

impl<'a> Visit<'a> for ShadowCollector {
    fn visit_binding_identifier(&mut self, it: &BindingIdentifier<'a>) {
        self.names.insert(it.name.to_string());
    }
}

struct Collector<'m> {
    map: &'m SymbolMap,
    shadowed: &'m HashSet<String>,
    src: &'m str,
    edits: Vec<Edit>,
    errors: Vec<String>,
}

impl<'m> Collector<'m> {
    fn kind_of(&self, name: &str) -> Option<Kind> {
        if self.shadowed.contains(name) {
            return None;
        }
        self.map.get(name).copied()
    }
}

impl<'a, 'm> Visit<'a> for Collector<'m> {
    fn visit_identifier_reference(&mut self, it: &IdentifierReference<'a>) {
        let name = it.name.as_str();
        if let Some(kind) = self.kind_of(name) {
            let repl = match kind {
                Kind::State | Kind::Derived => Some(format!("{}.get()", name)),
                Kind::Prop => Some(format!("props.{}", name)),
                Kind::Local | Kind::Fn => None,
            };
            if let Some(text) = repl {
                self.edits.push(Edit {
                    start: it.span.start as usize,
                    end: it.span.end as usize,
                    text,
                });
            }
        }
    }

    fn visit_assignment_expression(&mut self, it: &AssignmentExpression<'a>) {
        if let AssignmentTarget::AssignmentTargetIdentifier(id) = &it.left {
            if let Some(Kind::State) = self.kind_of(id.name.as_str()) {
                let name = id.name.as_str();
                let right_start = it.right.span().start as usize;
                let right_end = it.right.span().end as usize;
                let left_start = id.span.start as usize;

                let (prefix, suffix) = if matches!(it.operator, AssignmentOperator::Assign) {
                    (format!("{}.set(", name), ")")
                } else {
                    let base = it.operator.as_str();
                    let base = base.strip_suffix('=').unwrap_or(base);
                    (format!("{}.set({}.get() {} (", name, name, base), "))")
                };

                self.edits.push(Edit {
                    start: left_start,
                    end: right_start,
                    text: prefix,
                });
                self.edits.push(Edit {
                    start: right_end,
                    end: right_end,
                    text: suffix.to_string(),
                });
                // Only descend into the RHS (the LHS identifier is fully rewritten above).
                self.visit_expression(&it.right);
                return;
            }
        }
        walk::walk_assignment_expression(self, it);
    }

    fn visit_update_expression(&mut self, it: &UpdateExpression<'a>) {
        if let SimpleAssignmentTarget::AssignmentTargetIdentifier(id) = &it.argument {
            if let Some(Kind::State) = self.kind_of(id.name.as_str()) {
                let name = id.name.as_str();
                let delta = match it.operator {
                    UpdateOperator::Increment => "+",
                    UpdateOperator::Decrement => "-",
                };
                self.edits.push(Edit {
                    start: it.span.start as usize,
                    end: it.span.end as usize,
                    text: format!("{}.set({}.get() {} 1)", name, name, delta),
                });
                return;
            }
        }
        walk::walk_update_expression(self, it);
    }

    // ----- TypeScript erasure: the emitted module must be plain JS -----

    fn visit_ts_type_annotation(&mut self, it: &TSTypeAnnotation<'a>) {
        // Delete `: T` wholesale; nothing inside a type needs rewriting.
        self.edits.push(Edit {
            start: it.span.start as usize,
            end: it.span.end as usize,
            text: String::new(),
        });
    }

    fn visit_ts_type_parameter_instantiation(&mut self, it: &TSTypeParameterInstantiation<'a>) {
        self.edits.push(Edit {
            start: it.span.start as usize,
            end: it.span.end as usize,
            text: String::new(),
        });
    }

    fn visit_ts_type_parameter_declaration(&mut self, it: &TSTypeParameterDeclaration<'a>) {
        self.edits.push(Edit {
            start: it.span.start as usize,
            end: it.span.end as usize,
            text: String::new(),
        });
    }

    fn visit_ts_as_expression(&mut self, it: &TSAsExpression<'a>) {
        self.edits.push(Edit {
            start: it.expression.span().end as usize,
            end: it.span.end as usize,
            text: String::new(),
        });
        self.visit_expression(&it.expression);
    }

    fn visit_ts_satisfies_expression(&mut self, it: &TSSatisfiesExpression<'a>) {
        self.edits.push(Edit {
            start: it.expression.span().end as usize,
            end: it.span.end as usize,
            text: String::new(),
        });
        self.visit_expression(&it.expression);
    }

    fn visit_ts_non_null_expression(&mut self, it: &TSNonNullExpression<'a>) {
        self.edits.push(Edit {
            start: it.expression.span().end as usize,
            end: it.span.end as usize,
            text: String::new(),
        });
        self.visit_expression(&it.expression);
    }

    fn visit_ts_type_alias_declaration(&mut self, it: &TSTypeAliasDeclaration<'a>) {
        self.edits.push(Edit {
            start: it.span.start as usize,
            end: it.span.end as usize,
            text: String::new(),
        });
    }

    fn visit_ts_interface_declaration(&mut self, it: &TSInterfaceDeclaration<'a>) {
        self.edits.push(Edit {
            start: it.span.start as usize,
            end: it.span.end as usize,
            text: String::new(),
        });
    }

    // JSX in expression position compiles to a DOM-building IIFE. Children are
    // handled inside the generator, so we deliberately do not walk into them.
    fn visit_jsx_element(&mut self, it: &JSXElement<'a>) {
        match crate::jsx::gen_element_expr(it, self.src, self.map, self.shadowed) {
            Ok(text) => self.edits.push(Edit {
                start: it.span.start as usize,
                end: it.span.end as usize,
                text,
            }),
            Err(e) => self.errors.push(e),
        }
    }

    fn visit_jsx_fragment(&mut self, it: &JSXFragment<'a>) {
        match crate::jsx::gen_fragment_expr(it, self.src, self.map, self.shadowed) {
            Ok(text) => self.edits.push(Edit {
                start: it.span.start as usize,
                end: it.span.end as usize,
                text,
            }),
            Err(e) => self.errors.push(e),
        }
    }
}
