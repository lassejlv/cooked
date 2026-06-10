//! Hand-written recursive-descent parser for the Cooked structural grammar.
//! Embedded TypeScript is captured as raw text (balanced) and left for oxc to
//! handle in the rewrite pass. The `view` body is JSX: it is captured here with
//! a JSX-aware scanner and parsed properly by oxc in the codegen phase.

use crate::ast::*;

pub type PResult<T> = Result<T, String>;

pub fn parse_file(source: &str) -> PResult<File> {
    let mut p = Parser::new(source);
    p.parse_file()
}

struct Parser {
    chars: Vec<char>,
    pos: usize,
}

/// Scanner frame for the JSX-aware `view { ... }` capture.
#[derive(Debug)]
enum Frame {
    /// Inside JSX children (or at the view root). `from_expr` marks JSX that
    /// started inside a `{ ... }` expression — it pops back to Expr when its
    /// root element closes.
    Markup { tag_depth: u32, from_expr: bool },
    /// Inside an opening tag `<div ...>`.
    Tag,
    /// Inside a `{ ... }` expression (view interpolation or attribute value).
    Expr { brace_depth: u32 },
}

impl Parser {
    fn new(source: &str) -> Self {
        Parser {
            chars: source.chars().collect(),
            pos: 0,
        }
    }

    // ----- cursor primitives -----

    fn eof(&self) -> bool {
        self.pos >= self.chars.len()
    }

    fn peek(&self) -> char {
        self.chars.get(self.pos).copied().unwrap_or('\0')
    }

    fn peek2(&self) -> char {
        self.chars.get(self.pos + 1).copied().unwrap_or('\0')
    }

    fn bump(&mut self) -> char {
        let c = self.peek();
        self.pos += 1;
        c
    }

    fn skip_ws(&mut self) {
        loop {
            let c = self.peek();
            if c == ' ' || c == '\t' || c == '\r' || c == '\n' {
                self.pos += 1;
            } else if c == '/' && self.peek2() == '/' {
                while !self.eof() && self.peek() != '\n' {
                    self.pos += 1;
                }
            } else if c == '/' && self.peek2() == '*' {
                self.pos += 2;
                while !self.eof() && !(self.peek() == '*' && self.peek2() == '/') {
                    self.pos += 1;
                }
                self.pos += 2; // consume */
            } else {
                break;
            }
        }
    }

    /// Skip spaces/tabs (and comments) but not newlines.
    fn skip_inline(&mut self) {
        loop {
            let c = self.peek();
            if c == ' ' || c == '\t' || c == '\r' {
                self.pos += 1;
            } else if c == '/' && self.peek2() == '*' {
                self.pos += 2;
                while !self.eof() && !(self.peek() == '*' && self.peek2() == '/') {
                    self.pos += 1;
                }
                self.pos += 2;
            } else {
                break;
            }
        }
    }

    fn expect(&mut self, c: char) -> PResult<()> {
        if self.peek() == c {
            self.pos += 1;
            Ok(())
        } else {
            Err(format!(
                "expected '{}' but found '{}'",
                c,
                self.describe_here()
            ))
        }
    }

    fn describe_here(&self) -> String {
        if self.eof() {
            "<eof>".into()
        } else {
            let end = (self.pos + 12).min(self.chars.len());
            self.chars[self.pos..end].iter().collect()
        }
    }

    fn is_ident_start(c: char) -> bool {
        c.is_ascii_alphabetic() || c == '_' || c == '$'
    }
    fn is_ident_part(c: char) -> bool {
        c.is_ascii_alphanumeric() || c == '_' || c == '$'
    }

    fn parse_ident(&mut self) -> PResult<String> {
        if !Self::is_ident_start(self.peek()) {
            return Err(format!(
                "expected identifier, found '{}'",
                self.describe_here()
            ));
        }
        let mut s = String::new();
        while Self::is_ident_part(self.peek()) {
            s.push(self.bump());
        }
        Ok(s)
    }

    /// Match a keyword followed by a non-identifier char (so `let` doesn't match `letter`).
    fn at_keyword(&self, kw: &str) -> bool {
        let kw_chars: Vec<char> = kw.chars().collect();
        for (i, &kc) in kw_chars.iter().enumerate() {
            if self.chars.get(self.pos + i).copied().unwrap_or('\0') != kc {
                return false;
            }
        }
        let after = self
            .chars
            .get(self.pos + kw_chars.len())
            .copied()
            .unwrap_or('\0');
        !Self::is_ident_part(after)
    }

    fn eat_keyword(&mut self, kw: &str) -> bool {
        if self.at_keyword(kw) {
            self.pos += kw.chars().count();
            true
        } else {
            false
        }
    }

    // ----- balanced text capture -----

    /// Capture raw text until a top-level char in `stops` (respecting (), [], {},
    /// and string literals). If `arrow_eq` is true, a top-level '=' immediately
    /// followed by '>' is treated as part of the text, not a stop.
    fn capture(&mut self, stops: &[char], arrow_eq: bool) -> String {
        let mut depth = 0i32;
        let start = self.pos;
        while !self.eof() {
            let c = self.peek();
            if depth == 0 && stops.contains(&c) {
                if arrow_eq && c == '=' && self.peek2() == '>' {
                    // part of `=>`, keep going
                } else {
                    break;
                }
            }
            match c {
                '(' | '[' | '{' => {
                    depth += 1;
                    self.pos += 1;
                }
                ')' | ']' | '}' => {
                    if depth == 0 {
                        break;
                    }
                    depth -= 1;
                    self.pos += 1;
                }
                '"' | '\'' | '`' => {
                    self.consume_string(c);
                }
                _ => {
                    self.pos += 1;
                }
            }
        }
        let text: String = self.chars[start..self.pos].iter().collect();
        text.trim().to_string()
    }

    /// Consume a string literal starting at the opening quote `q`.
    fn consume_string(&mut self, q: char) {
        self.pos += 1; // opening
        while !self.eof() {
            let c = self.bump();
            if c == '\\' {
                self.pos += 1; // skip escaped char
            } else if c == q {
                break;
            }
        }
    }

    /// Consume a template literal starting at the backtick, including `${ ... }`
    /// holes (with nested strings and braces).
    fn consume_template(&mut self) {
        self.pos += 1; // opening `
        while !self.eof() {
            let c = self.bump();
            if c == '\\' {
                self.pos += 1;
            } else if c == '`' {
                break;
            } else if c == '$' && self.peek() == '{' {
                self.pos += 1; // {
                let mut depth = 1u32;
                while !self.eof() && depth > 0 {
                    let d = self.peek();
                    match d {
                        '{' => {
                            depth += 1;
                            self.pos += 1;
                        }
                        '}' => {
                            depth -= 1;
                            self.pos += 1;
                        }
                        '"' | '\'' => self.consume_string(d),
                        '`' => self.consume_template(),
                        _ => self.pos += 1,
                    }
                }
            }
        }
    }

    /// Assuming the cursor is at `{`, capture the inner text of the balanced block.
    fn capture_block_inner(&mut self) -> PResult<String> {
        self.expect('{')?;
        let start = self.pos;
        let mut depth = 1i32;
        while !self.eof() {
            let c = self.peek();
            match c {
                '{' => {
                    depth += 1;
                    self.pos += 1;
                }
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        break;
                    }
                    self.pos += 1;
                }
                '"' | '\'' => self.consume_string(c),
                '`' => self.consume_template(),
                '/' if self.peek2() == '/' => {
                    while !self.eof() && self.peek() != '\n' {
                        self.pos += 1;
                    }
                }
                _ => self.pos += 1,
            }
        }
        let inner: String = self.chars[start..self.pos].iter().collect();
        self.expect('}')?;
        Ok(inner.trim().to_string())
    }

    // ----- grammar -----

    fn parse_file(&mut self) -> PResult<File> {
        let mut file = File {
            imports: vec![],
            components: vec![],
            functions: vec![],
        };
        self.skip_ws();
        while !self.eof() {
            if self.at_keyword("component") {
                file.components.push(self.parse_component_block()?);
            } else if self.at_keyword("import") {
                let mut line = self.capture(&['\n'], false);
                if line.ends_with(';') {
                    line.pop();
                }
                file.imports.push(line);
            } else if self.at_keyword("export") || self.at_keyword("async") || self.at_keyword("fn")
            {
                self.parse_top_fn(&mut file)?;
            } else {
                return Err(format!(
                    "expected `fn`, `component` or `import`, found '{}'",
                    self.describe_here()
                ));
            }
            self.skip_ws();
        }
        Ok(file)
    }

    /// `[export] [async] fn Name(params) { ... }` — capitalized names are
    /// components (params become props), lowercase ones plain functions.
    fn parse_top_fn(&mut self, file: &mut File) -> PResult<()> {
        self.eat_keyword("export");
        self.skip_ws();
        let is_async = self.eat_keyword("async");
        self.skip_ws();
        if !self.eat_keyword("fn") {
            return Err(format!("expected `fn`, found '{}'", self.describe_here()));
        }
        self.skip_ws();
        let name = self.parse_ident()?;
        self.skip_ws();
        self.expect('(')?;
        let params = self.capture(&[')'], false);
        self.expect(')')?;
        self.skip_ws();
        let return_ty = self.take_return_type();
        let is_component = name.chars().next().is_some_and(|c| c.is_ascii_uppercase());
        if is_component {
            let mut comp = Component {
                name,
                is_async,
                props: params_to_props(&params)?,
                items: vec![],
            };
            self.parse_component_body(&mut comp)?;
            file.components.push(comp);
        } else {
            let body = self.capture_block_inner()?;
            file.functions.push(RawFn {
                name,
                is_async,
                params,
                return_ty,
                body,
            });
        }
        Ok(())
    }

    /// Legacy `component Name { ... }` block — same body grammar.
    fn parse_component_block(&mut self) -> PResult<Component> {
        self.eat_keyword("component");
        self.skip_ws();
        let name = self.parse_ident()?;
        self.skip_ws();
        let mut comp = Component {
            name,
            is_async: false,
            props: vec![],
            items: vec![],
        };
        self.parse_component_body(&mut comp)?;
        Ok(comp)
    }

    fn parse_component_body(&mut self, comp: &mut Component) -> PResult<()> {
        self.expect('{')?;
        loop {
            self.skip_ws();
            if self.eof() {
                return Err(format!("component {}: unterminated body", comp.name));
            }
            if self.peek() == '}' {
                break;
            }
            if self.at_keyword("prop") {
                comp.props.push(self.parse_prop()?);
            } else if self.at_keyword("let") {
                self.parse_let(comp)?;
            } else if self.at_keyword("fn") {
                let f = self.parse_fn()?;
                comp.items.push(Item::Fn(f));
            } else if self.at_keyword("effect") {
                self.eat_keyword("effect");
                self.skip_ws();
                comp.items.push(Item::Effect(self.capture_block_inner()?));
            } else if self.at_keyword("rt") {
                self.eat_keyword("rt");
                self.skip_ws();
                self.expect('(')?;
                comp.items.push(Item::View(self.capture_view_body(')')?));
            } else if self.at_keyword("view") {
                self.eat_keyword("view");
                self.skip_ws();
                self.expect('{')?;
                comp.items.push(Item::View(self.capture_view_body('}')?));
            } else {
                // Any other TS statement passes through (rewritten at codegen),
                // so `const data = await load()` etc. just work.
                let stmt = self.capture(&['\n'], false);
                if stmt.is_empty() {
                    if self.peek() == ';' {
                        self.pos += 1;
                        continue;
                    }
                    return Err(format!(
                        "component {}: unexpected '{}'",
                        comp.name,
                        self.describe_here()
                    ));
                }
                comp.items.push(Item::Raw(stmt));
            }
        }
        self.expect('}')?;
        Ok(())
    }

    fn parse_prop(&mut self) -> PResult<Prop> {
        self.eat_keyword("prop");
        self.skip_inline();
        let name = self.parse_ident()?;
        self.skip_inline();
        let optional = if self.peek() == '?' {
            self.pos += 1;
            self.skip_inline();
            true
        } else {
            false
        };
        let ty = if self.peek() == ':' {
            self.pos += 1;
            let ty = self.capture(&['=', '\n', '}'], true);
            if ty.is_empty() {
                None
            } else {
                Some(ty)
            }
        } else {
            None
        };
        self.skip_inline();
        let default = if self.peek() == '=' {
            self.pos += 1;
            let d = self.capture(&['\n', '}'], false);
            if d.is_empty() {
                None
            } else {
                Some(d)
            }
        } else {
            None
        };
        Ok(Prop {
            name,
            ty,
            optional,
            default,
        })
    }

    fn parse_let(&mut self, comp: &mut Component) -> PResult<()> {
        self.eat_keyword("let");
        self.skip_inline();
        let is_mut = self.eat_keyword("mut");
        if is_mut {
            self.skip_inline();
        }
        let name = self.parse_ident()?;
        self.skip_inline();
        if self.peek() == ':' {
            self.pos += 1;
            let _ = self.capture(&['=', '\n', '}'], true); // type, discarded
            self.skip_inline();
        }
        // now at `=` or `=>`
        if self.peek() == '=' && self.peek2() == '>' {
            // derived
            self.pos += 2;
            let expr = self.capture(&['\n', '}'], false);
            comp.items.push(Item::Derived(Binding { name, expr }));
        } else if self.peek() == '=' {
            self.pos += 1;
            let expr = self.capture(&['\n', '}'], false);
            if is_mut {
                comp.items.push(Item::State(Binding { name, expr }));
            } else {
                comp.items.push(Item::Const(Binding { name, expr }));
            }
        } else {
            return Err(format!(
                "expected '=' or '=>' in let binding, found '{}'",
                self.describe_here()
            ));
        }
        Ok(())
    }

    fn parse_fn(&mut self) -> PResult<Func> {
        self.eat_keyword("fn");
        self.skip_inline();
        let name = self.parse_ident()?;
        self.skip_inline();
        self.expect('(')?;
        let params = self.capture(&[')'], false);
        self.expect(')')?;
        self.skip_ws();
        self.take_return_type();
        let body = self.capture_block_inner()?;
        Ok(Func { name, params, body })
    }

    /// Capture an optional `-> Type` or `: Type` return annotation before `{`.
    fn take_return_type(&mut self) -> Option<String> {
        if self.peek() == '-' && self.peek2() == '>' {
            self.pos += 2;
            let ty = self.capture(&['{'], false);
            self.skip_ws();
            if ty.is_empty() {
                None
            } else {
                Some(ty)
            }
        } else if self.peek() == ':' {
            self.pos += 1;
            let ty = self.capture(&['{'], false);
            self.skip_ws();
            if ty.is_empty() {
                None
            } else {
                Some(ty)
            }
        } else {
            None
        }
    }

    // ----- view capture (JSX-aware) -----

    /// Capture the raw body of `rt ( ... )` or `view { ... }` (the opener is
    /// already consumed; `close` is `)` or `}`). JSX text may legally contain
    /// apostrophes, quotes and `//`, so plain brace-balancing is not enough —
    /// this scanner tracks whether it is inside markup, an opening tag, or a
    /// `{ ... }` expression, and only applies string/comment rules in the last.
    fn capture_view_body(&mut self, close: char) -> PResult<String> {
        let start = self.pos;
        let mut stack: Vec<Frame> = vec![Frame::Markup {
            tag_depth: 0,
            from_expr: false,
        }];
        // For the `<` is-it-JSX heuristic inside expressions: the last
        // significant (non-space) chars and the last identifier word seen.
        let mut last_sig: (char, char) = ('\0', '\0');
        let mut last_word = String::new();

        while !self.eof() {
            let c = self.peek();
            match stack.last_mut().expect("scanner stack never empty") {
                Frame::Markup {
                    tag_depth,
                    from_expr,
                } => match c {
                    _ if c == close && *tag_depth == 0 => {
                        if *from_expr {
                            return Err(format!(
                                "view: unexpected '{}' after JSX inside an expression",
                                close
                            ));
                        }
                        let body: String = self.chars[start..self.pos].iter().collect();
                        self.pos += 1; // closing delimiter
                        return Ok(body.trim().to_string());
                    }
                    '<' if self.peek2() == '/' => {
                        // closing tag (including `</>`): consume to `>`
                        self.pos += 2;
                        while !self.eof() && self.peek() != '>' {
                            self.pos += 1;
                        }
                        self.expect('>')?;
                        if *tag_depth == 0 {
                            return Err("view: unmatched closing tag".into());
                        }
                        *tag_depth -= 1;
                        if *tag_depth == 0 && *from_expr {
                            stack.pop(); // back to the enclosing expression
                        }
                    }
                    '<' => {
                        self.pos += 1;
                        stack.push(Frame::Tag);
                    }
                    '{' => {
                        self.pos += 1;
                        last_sig = ('\0', '\0');
                        last_word.clear();
                        stack.push(Frame::Expr { brace_depth: 1 });
                    }
                    _ => self.pos += 1, // JSX text: quotes/comments are not special
                },
                Frame::Tag => match c {
                    '"' | '\'' => self.consume_string(c),
                    '{' => {
                        self.pos += 1;
                        last_sig = ('\0', '\0');
                        last_word.clear();
                        stack.push(Frame::Expr { brace_depth: 1 });
                    }
                    '/' if self.peek2() == '>' => {
                        self.pos += 2;
                        stack.pop();
                        // self-closing: if this completed JSX nested in an
                        // expression, pop back to the expression frame.
                        if let Some(Frame::Markup {
                            tag_depth: 0,
                            from_expr: true,
                        }) = stack.last()
                        {
                            stack.pop();
                        }
                    }
                    '>' => {
                        self.pos += 1;
                        stack.pop();
                        if let Some(Frame::Markup { tag_depth, .. }) = stack.last_mut() {
                            *tag_depth += 1;
                        }
                    }
                    _ => self.pos += 1,
                },
                Frame::Expr { brace_depth } => match c {
                    '"' | '\'' => {
                        self.consume_string(c);
                        last_sig = (last_sig.1, '"');
                        last_word.clear();
                    }
                    '`' => {
                        self.consume_template();
                        last_sig = (last_sig.1, '"');
                        last_word.clear();
                    }
                    '/' if self.peek2() == '/' => {
                        while !self.eof() && self.peek() != '\n' {
                            self.pos += 1;
                        }
                    }
                    '/' if self.peek2() == '*' => {
                        self.pos += 2;
                        while !self.eof() && !(self.peek() == '*' && self.peek2() == '/') {
                            self.pos += 1;
                        }
                        self.pos += 2;
                    }
                    '{' => {
                        *brace_depth += 1;
                        self.pos += 1;
                        last_sig = (last_sig.1, '{');
                        last_word.clear();
                    }
                    '}' => {
                        *brace_depth -= 1;
                        let done = *brace_depth == 0;
                        self.pos += 1;
                        if done {
                            stack.pop();
                        } else {
                            last_sig = (last_sig.1, '}');
                            last_word.clear();
                        }
                    }
                    '<' if Self::jsx_starts_here(self.peek2(), last_sig, &last_word) => {
                        self.pos += 1;
                        stack.push(Frame::Markup {
                            tag_depth: 0,
                            from_expr: true,
                        });
                        stack.push(Frame::Tag);
                    }
                    _ => {
                        self.pos += 1;
                        if !c.is_whitespace() {
                            last_sig = (last_sig.1, c);
                            if Self::is_ident_part(c) {
                                last_word.push(c);
                            } else {
                                last_word.clear();
                            }
                        }
                    }
                },
            }
        }
        Err("view: unterminated block".into())
    }

    /// Heuristic: inside an expression, does `<` start JSX (vs a comparison)?
    /// JSX is assumed when an operand is expected: at the start of the
    /// expression, after an opener/operator, after `=>`, or after a keyword
    /// like `return`.
    fn jsx_starts_here(next: char, last_sig: (char, char), last_word: &str) -> bool {
        if !(Self::is_ident_start(next) || next == '>') {
            return false; // `<3`, `<=` etc. are never JSX
        }
        let (prev2, prev) = last_sig;
        let after_arrow = prev == '>' && prev2 == '=';
        let keyword = matches!(
            last_word,
            "return"
                | "yield"
                | "await"
                | "typeof"
                | "case"
                | "do"
                | "else"
                | "in"
                | "of"
                | "void"
                | "new"
        );
        if keyword {
            return true;
        }
        after_arrow
            || matches!(
                prev,
                '\0' | '(' | ',' | '?' | ':' | '=' | '&' | '|' | '!' | ';' | '[' | '{' | '}'
            )
    }
}

/// Turn a component fn's parameter list into props:
/// `label: string = "Count", step = 1` -> [label (default "Count"), step (default 1)].
fn params_to_props(params: &str) -> PResult<Vec<Prop>> {
    let mut props = vec![];
    for piece in split_params(params) {
        let piece = piece.trim();
        if piece.is_empty() {
            continue;
        }
        if piece.starts_with('{') || piece.starts_with('[') || piece.starts_with("...") {
            return Err("component props must be simple `name: type = default` parameters".into());
        }
        let name: String = piece
            .chars()
            .take_while(|c| Parser::is_ident_part(*c))
            .collect();
        if name.is_empty() {
            return Err(format!("invalid component parameter `{}`", piece));
        }
        let default_eq = find_default_eq(piece);
        let type_start = piece.find(':');
        let optional = piece[name.len()..].trim_start().starts_with('?') || default_eq.is_some();
        let ty = type_start.map(|start| {
            let end = default_eq.unwrap_or(piece.len());
            piece[start + 1..end].trim().to_string()
        });
        let default = default_eq.map(|i| piece[i + 1..].trim().to_string());
        props.push(Prop {
            name,
            ty: ty.filter(|t| !t.is_empty()),
            optional,
            default: default.filter(|d| !d.is_empty()),
        });
    }
    Ok(props)
}

/// Split a parameter list on top-level commas (respecting brackets + strings).
fn split_params(s: &str) -> Vec<String> {
    let mut out = vec![];
    let mut depth = 0i32;
    let mut cur = String::new();
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '(' | '[' | '{' => {
                depth += 1;
                cur.push(c);
            }
            ')' | ']' | '}' => {
                depth -= 1;
                cur.push(c);
            }
            '"' | '\'' | '`' => {
                cur.push(c);
                let mut escaped = false;
                for d in chars.by_ref() {
                    cur.push(d);
                    if escaped {
                        escaped = false;
                    } else if d == '\\' {
                        escaped = true;
                    } else if d == c {
                        break;
                    }
                }
            }
            ',' if depth == 0 => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

/// Byte index of the top-level `=` that starts a parameter default — skipping
/// `=>` (arrow function types), `==`/`===`, and `<=`/`>=`/`!=`.
pub(crate) fn find_default_eq(s: &str) -> Option<usize> {
    let bytes = s.as_bytes();
    let mut depth = 0i32;
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        match c {
            '(' | '[' | '{' => depth += 1,
            ')' | ']' | '}' => depth -= 1,
            '"' | '\'' | '`' => {
                i += 1;
                while i < bytes.len() {
                    let d = bytes[i] as char;
                    if d == '\\' {
                        i += 1;
                    } else if d == c {
                        break;
                    }
                    i += 1;
                }
            }
            '=' if depth == 0 => {
                let next = bytes.get(i + 1).map(|&b| b as char);
                let prev = i.checked_sub(1).map(|j| bytes[j] as char);
                let part_of_operator = matches!(next, Some('>') | Some('='))
                    || matches!(prev, Some('=') | Some('!') | Some('<') | Some('>'));
                if !part_of_operator {
                    return Some(i);
                }
            }
            _ => {}
        }
        i += 1;
    }
    None
}
