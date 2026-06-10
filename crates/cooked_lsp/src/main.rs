use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::RwLock;
use tower_lsp::jsonrpc::Result;
use tower_lsp::lsp_types::*;
use tower_lsp::{Client, LanguageServer, LspService, Server};
use url::Url;

#[derive(Debug, Default)]
struct DocumentStore {
    docs: RwLock<HashMap<Url, String>>,
}

impl DocumentStore {
    async fn set(&self, uri: Url, text: String) {
        self.docs.write().await.insert(uri, text);
    }

    async fn remove(&self, uri: &Url) {
        self.docs.write().await.remove(uri);
    }

    async fn get(&self, uri: &Url) -> Option<String> {
        self.docs.read().await.get(uri).cloned()
    }
}

#[derive(Debug)]
struct Backend {
    client: Client,
    documents: Arc<DocumentStore>,
}

#[tower_lsp::async_trait]
impl LanguageServer for Backend {
    async fn initialize(&self, _: InitializeParams) -> Result<InitializeResult> {
        Ok(InitializeResult {
            server_info: Some(ServerInfo {
                name: "cooked-lsp".into(),
                version: Some(env!("CARGO_PKG_VERSION").into()),
            }),
            capabilities: ServerCapabilities {
                text_document_sync: Some(TextDocumentSyncCapability::Kind(
                    TextDocumentSyncKind::FULL,
                )),
                completion_provider: Some(CompletionOptions {
                    trigger_characters: Some(vec![
                        ".".into(),
                        "<".into(),
                        "{".into(),
                        "\"".into(),
                        "'".into(),
                        ":".into(),
                    ]),
                    ..CompletionOptions::default()
                }),
                hover_provider: Some(HoverProviderCapability::Simple(true)),
                document_symbol_provider: Some(OneOf::Left(true)),
                definition_provider: Some(OneOf::Left(true)),
                diagnostic_provider: Some(DiagnosticServerCapabilities::Options(
                    DiagnosticOptions {
                        identifier: Some("cooked".into()),
                        inter_file_dependencies: false,
                        workspace_diagnostics: false,
                        ..DiagnosticOptions::default()
                    },
                )),
                ..ServerCapabilities::default()
            },
        })
    }

    async fn initialized(&self, _: InitializedParams) {
        self.client
            .log_message(MessageType::INFO, "Cooked language server initialized")
            .await;
    }

    async fn shutdown(&self) -> Result<()> {
        Ok(())
    }

    async fn did_open(&self, params: DidOpenTextDocumentParams) {
        let uri = params.text_document.uri;
        self.documents
            .set(uri.clone(), params.text_document.text)
            .await;
        self.publish_diagnostics(uri).await;
    }

    async fn did_change(&self, params: DidChangeTextDocumentParams) {
        let uri = params.text_document.uri;
        if let Some(change) = params.content_changes.into_iter().last() {
            self.documents.set(uri.clone(), change.text).await;
            self.publish_diagnostics(uri).await;
        }
    }

    async fn did_save(&self, params: DidSaveTextDocumentParams) {
        self.publish_diagnostics(params.text_document.uri).await;
    }

    async fn did_close(&self, params: DidCloseTextDocumentParams) {
        let uri = params.text_document.uri;
        self.documents.remove(&uri).await;
        self.client.publish_diagnostics(uri, vec![], None).await;
    }

    async fn completion(&self, params: CompletionParams) -> Result<Option<CompletionResponse>> {
        let uri = params.text_document_position.text_document.uri;
        let pos = params.text_document_position.position;
        let Some(text) = self.documents.get(&uri).await else {
            return Ok(None);
        };

        let items = completion_items(&text, pos);
        Ok(Some(CompletionResponse::Array(items)))
    }

    async fn hover(&self, params: HoverParams) -> Result<Option<Hover>> {
        let uri = params.text_document_position_params.text_document.uri;
        let pos = params.text_document_position_params.position;
        let Some(text) = self.documents.get(&uri).await else {
            return Ok(None);
        };
        let Some(word) = word_at(&text, pos) else {
            return Ok(None);
        };
        let Some(markdown) = hover_text(&word) else {
            return Ok(None);
        };

        Ok(Some(Hover {
            contents: HoverContents::Markup(MarkupContent {
                kind: MarkupKind::Markdown,
                value: markdown,
            }),
            range: word_range(&text, pos),
        }))
    }

    async fn document_symbol(
        &self,
        params: DocumentSymbolParams,
    ) -> Result<Option<DocumentSymbolResponse>> {
        let Some(text) = self.documents.get(&params.text_document.uri).await else {
            return Ok(None);
        };
        Ok(Some(DocumentSymbolResponse::Nested(document_symbols(
            &text,
        ))))
    }

    async fn goto_definition(
        &self,
        params: GotoDefinitionParams,
    ) -> Result<Option<GotoDefinitionResponse>> {
        let uri = params.text_document_position_params.text_document.uri;
        let pos = params.text_document_position_params.position;
        let Some(text) = self.documents.get(&uri).await else {
            return Ok(None);
        };
        let Some(word) = word_at(&text, pos) else {
            return Ok(None);
        };
        let Some(range) = definition_range(&text, &word) else {
            return Ok(None);
        };
        Ok(Some(GotoDefinitionResponse::Scalar(Location::new(
            uri, range,
        ))))
    }

    async fn diagnostic(
        &self,
        params: DocumentDiagnosticParams,
    ) -> Result<DocumentDiagnosticReportResult> {
        let uri = params.text_document.uri;
        let diagnostics = match self.documents.get(&uri).await {
            Some(text) => diagnostics_for(&uri, &text),
            None => vec![],
        };
        Ok(DocumentDiagnosticReportResult::Report(
            DocumentDiagnosticReport::Full(RelatedFullDocumentDiagnosticReport {
                related_documents: None,
                full_document_diagnostic_report: FullDocumentDiagnosticReport {
                    result_id: None,
                    items: diagnostics,
                },
            }),
        ))
    }
}

impl Backend {
    async fn publish_diagnostics(&self, uri: Url) {
        let diagnostics = match self.documents.get(&uri).await {
            Some(text) => diagnostics_for(&uri, &text),
            None => vec![],
        };
        self.client
            .publish_diagnostics(uri, diagnostics, None)
            .await;
    }
}

fn diagnostics_for(uri: &Url, text: &str) -> Vec<Diagnostic> {
    let mut diagnostics = vec![];
    if is_cooked_uri(uri) {
        let out = cooked_compiler::compile_with_filename(text, uri.as_str());
        diagnostics.extend(out.errors.into_iter().map(|message| Diagnostic {
            range: diagnostic_range(text, &message),
            severity: Some(DiagnosticSeverity::ERROR),
            source: Some("cooked".into()),
            message,
            ..Diagnostic::default()
        }));
    }

    diagnostics.extend(css_diagnostics(text));
    diagnostics.extend(lightweight_ts_diagnostics(text));
    diagnostics
}

fn completion_items(text: &str, pos: Position) -> Vec<CompletionItem> {
    if in_style_object(text, pos) {
        return css_completions();
    }
    if after_dot(text, pos) {
        return ts_member_completions();
    }
    if in_tag(text, pos) {
        return jsx_completions();
    }

    let mut items = vec![];
    items.extend(keyword_completions());
    items.extend(runtime_completions());
    items.extend(symbol_completions(text));
    items
}

fn keyword_completions() -> Vec<CompletionItem> {
    [
        ("export fn", "export fn ${1:Component}(${2:props}) {\n  rt (\n    $0\n  )\n}"),
        ("let mut", "let mut ${1:name} = ${2:value}"),
        ("derived", "let ${1:name} => ${2:expr}"),
        ("effect", "effect {\n  $0\n}"),
        ("rt", "rt (\n  $0\n)"),
        ("Keyed", "<Keyed each={${1:items}} by={${2:item => item.id}}>\n  {${3:item => <div>{item}</div>}}\n</Keyed>"),
    ]
    .into_iter()
    .map(|(label, insert_text)| CompletionItem {
        label: label.into(),
        kind: Some(CompletionItemKind::SNIPPET),
        insert_text: Some(insert_text.into()),
        insert_text_format: Some(InsertTextFormat::SNIPPET),
        ..CompletionItem::default()
    })
    .collect()
}

fn runtime_completions() -> Vec<CompletionItem> {
    [
        ("createStore", "createStore(${1:initial})"),
        (
            "createActions",
            "createActions(${1:store}, (${2:api}) => ({\n  $0\n}))",
        ),
        ("atom", "atom(${1:value})"),
        ("signal", "signal(${1:value})"),
        ("memo", "memo(() => ${1:value})"),
        ("effect", "effect(() => {\n  $0\n})"),
        ("batch", "batch(() => {\n  $0\n})"),
    ]
    .into_iter()
    .map(|(label, insert_text)| CompletionItem {
        label: label.into(),
        kind: Some(CompletionItemKind::FUNCTION),
        insert_text: Some(insert_text.into()),
        insert_text_format: Some(InsertTextFormat::SNIPPET),
        detail: Some("Cooked runtime".into()),
        ..CompletionItem::default()
    })
    .collect()
}

fn css_completions() -> Vec<CompletionItem> {
    [
        "color",
        "backgroundColor",
        "display",
        "position",
        "inset",
        "width",
        "height",
        "padding",
        "margin",
        "border",
        "borderRadius",
        "fontSize",
        "fontWeight",
        "lineHeight",
        "gap",
        "gridTemplateColumns",
        "alignItems",
        "justifyContent",
        "transform",
        "opacity",
    ]
    .into_iter()
    .map(|label| CompletionItem {
        label: label.into(),
        kind: Some(CompletionItemKind::PROPERTY),
        detail: Some("CSS property".into()),
        ..CompletionItem::default()
    })
    .collect()
}

fn ts_member_completions() -> Vec<CompletionItem> {
    [
        "map",
        "filter",
        "reduce",
        "find",
        "includes",
        "trim",
        "toString",
        "toLowerCase",
        "toUpperCase",
        "length",
        "push",
        "slice",
        "then",
        "catch",
    ]
    .into_iter()
    .map(|label| CompletionItem {
        label: label.into(),
        kind: Some(CompletionItemKind::METHOD),
        detail: Some("TypeScript/JavaScript member".into()),
        ..CompletionItem::default()
    })
    .collect()
}

fn jsx_completions() -> Vec<CompletionItem> {
    [
        "div", "span", "button", "input", "form", "section", "article", "ul", "li",
    ]
    .into_iter()
    .map(|label| CompletionItem {
        label: label.into(),
        kind: Some(CompletionItemKind::CLASS),
        detail: Some("HTML element".into()),
        ..CompletionItem::default()
    })
    .collect()
}

fn symbol_completions(text: &str) -> Vec<CompletionItem> {
    let mut items = vec![];
    for symbol in top_level_symbols(text) {
        items.push(CompletionItem {
            label: symbol.name,
            kind: Some(symbol.kind),
            detail: Some(symbol.detail),
            ..CompletionItem::default()
        });
    }
    items
}

fn hover_text(word: &str) -> Option<String> {
    let text = match word {
        "let" => "`let mut name = value` creates reactive component state in Cooked.",
        "effect" => "`effect { ... }` runs a reactive side effect and tracks signal reads.",
        "rt" => "`rt (...)` returns the JSX view for a Cooked component.",
        "Keyed" => {
            "`<Keyed each={items} by={item => key}>` preserves DOM identity across list reorders."
        }
        "createStore" => "`createStore(initial)` creates a typed shared Cooked store.",
        "createActions" => "`createActions(store, factory)` creates ergonomic store actions.",
        "atom" => "`atom(value)` is a tiny writable signal alias.",
        "signal" => "`signal(value)` creates a writable reactive value.",
        "memo" => "`memo(() => expr)` creates a cached derived value.",
        _ => return None,
    };
    Some(text.into())
}

#[derive(Debug)]
struct SymbolInfo {
    name: String,
    detail: String,
    kind: CompletionItemKind,
    range: Range,
}

fn top_level_symbols(text: &str) -> Vec<SymbolInfo> {
    let mut symbols = vec![];
    for (line_idx, line) in text.lines().enumerate() {
        let trimmed = line.trim_start();
        let offset = line.len() - trimmed.len();
        let maybe_name = if let Some(rest) = trimmed.strip_prefix("export async fn ") {
            rest.split('(')
                .next()
                .map(|name| (name, "async component/function"))
        } else if let Some(rest) = trimmed.strip_prefix("export fn ") {
            rest.split('(')
                .next()
                .map(|name| (name, "component/function"))
        } else if let Some(rest) = trimmed.strip_prefix("fn ") {
            rest.split('(').next().map(|name| (name, "function"))
        } else if let Some(rest) = trimmed.strip_prefix("component ") {
            rest.split_whitespace()
                .next()
                .map(|name| (name, "component"))
        } else {
            None
        };
        if let Some((name, detail)) = maybe_name {
            let start = offset + trimmed.find(name).unwrap_or(0);
            symbols.push(SymbolInfo {
                name: name.to_string(),
                detail: detail.into(),
                kind: CompletionItemKind::FUNCTION,
                range: Range::new(
                    Position::new(line_idx as u32, start as u32),
                    Position::new(line_idx as u32, (start + name.len()) as u32),
                ),
            });
        }
    }
    symbols
}

fn document_symbols(text: &str) -> Vec<DocumentSymbol> {
    top_level_symbols(text)
        .into_iter()
        .map(|symbol| DocumentSymbol {
            name: symbol.name,
            detail: Some(symbol.detail),
            kind: SymbolKind::FUNCTION,
            tags: None,
            #[allow(deprecated)]
            deprecated: None,
            range: symbol.range,
            selection_range: symbol.range,
            children: None,
        })
        .collect()
}

fn definition_range(text: &str, word: &str) -> Option<Range> {
    top_level_symbols(text)
        .into_iter()
        .find(|symbol| symbol.name == word)
        .map(|symbol| symbol.range)
}

fn css_diagnostics(text: &str) -> Vec<Diagnostic> {
    let mut diagnostics = vec![];
    for (line_idx, line) in text.lines().enumerate() {
        if let Some(style_pos) = line.find("style={{") {
            let allowed = [
                "color",
                "backgroundColor",
                "display",
                "position",
                "width",
                "height",
                "padding",
                "margin",
                "border",
                "borderRadius",
                "fontSize",
                "fontWeight",
                "lineHeight",
                "gap",
                "alignItems",
                "justifyContent",
                "opacity",
            ];
            for prop in object_keys(line) {
                if !allowed.contains(&prop.as_str()) {
                    diagnostics.push(Diagnostic {
                        range: Range::new(
                            Position::new(line_idx as u32, (style_pos + 1) as u32),
                            Position::new(line_idx as u32, line.len() as u32),
                        ),
                        severity: Some(DiagnosticSeverity::WARNING),
                        source: Some("cooked-css".into()),
                        message: format!("Unknown CSS property `{}`", prop),
                        ..Diagnostic::default()
                    });
                }
            }
        }
    }
    diagnostics
}

fn lightweight_ts_diagnostics(text: &str) -> Vec<Diagnostic> {
    let mut diagnostics = vec![];
    for (line_idx, line) in text.lines().enumerate() {
        if line.contains("console.log(") {
            diagnostics.push(Diagnostic {
                range: Range::new(
                    Position::new(line_idx as u32, 0),
                    Position::new(line_idx as u32, line.len() as u32),
                ),
                severity: Some(DiagnosticSeverity::HINT),
                source: Some("cooked-ts".into()),
                message: "Debug logging in component code".into(),
                ..Diagnostic::default()
            });
        }
    }
    diagnostics
}

fn object_keys(line: &str) -> Vec<String> {
    let mut keys = vec![];
    for part in line.split(',') {
        if let Some((key, _)) = part.split_once(':') {
            let key = key
                .trim()
                .trim_start_matches('{')
                .trim_start_matches("style={{")
                .trim_matches(|c: char| c == '"' || c == '\'' || c == '{' || c == '}');
            if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') {
                keys.push(key.to_string());
            }
        }
    }
    keys
}

fn diagnostic_range(text: &str, message: &str) -> Range {
    let parts: Vec<&str> = message.split(':').collect();
    let numeric = parts
        .windows(2)
        .filter_map(|pair| {
            let line = pair[0].parse::<u32>().ok()?;
            let col = pair[1].parse::<u32>().ok()?;
            Some((line, col))
        })
        .last();
    if let Some((line, col)) = numeric {
        let line = line.saturating_sub(1);
        let col = col.saturating_sub(1);
        return Range::new(Position::new(line, col), Position::new(line, col + 1));
    }
    Range::new(Position::new(0, 0), end_position(text))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completes_css_inside_style_objects() {
        let text = "export fn App() { rt ( <div style={{ col }} /> ) }";
        let items = completion_items(text, Position::new(0, 39));
        assert!(items.iter().any(|item| item.label == "color"));
        assert!(items.iter().any(|item| item.label == "backgroundColor"));
    }

    #[test]
    fn finds_cooked_symbols() {
        let text = "export fn App() { rt ( <div /> ) }\nfn helper(): string { return \"\" }";
        let symbols = top_level_symbols(text);
        assert_eq!(
            symbols.iter().map(|s| s.name.as_str()).collect::<Vec<_>>(),
            ["App", "helper"]
        );
    }

    #[test]
    fn parses_uri_diagnostic_ranges() {
        let range = diagnostic_range("a\nb\nc", "file:///tmp/App.ck:2:3: expected `}`");
        assert_eq!(range.start, Position::new(1, 2));
    }
}

fn end_position(text: &str) -> Position {
    let line = text.lines().count().saturating_sub(1) as u32;
    let character = text.lines().last().map(|line| line.len()).unwrap_or(0) as u32;
    Position::new(line, character)
}

fn is_cooked_uri(uri: &Url) -> bool {
    uri.path().ends_with(".ck")
}

fn in_style_object(text: &str, pos: Position) -> bool {
    let Some(line) = line_at(text, pos.line) else {
        return false;
    };
    let prefix = prefix_at(line, pos.character);
    prefix.rfind("style={{").is_some_and(|start| {
        let after = &prefix[start..];
        after.matches('{').count() > after.matches('}').count()
    })
}

fn in_tag(text: &str, pos: Position) -> bool {
    let Some(line) = line_at(text, pos.line) else {
        return false;
    };
    let prefix = prefix_at(line, pos.character);
    prefix.rfind('<') > prefix.rfind('>')
}

fn after_dot(text: &str, pos: Position) -> bool {
    let Some(line) = line_at(text, pos.line) else {
        return false;
    };
    prefix_at(line, pos.character).trim_end().ends_with('.')
}

fn line_at(text: &str, line: u32) -> Option<&str> {
    text.lines().nth(line as usize)
}

fn prefix_at(line: &str, character: u32) -> &str {
    let end = (character as usize).min(line.len());
    &line[..end]
}

fn word_at(text: &str, pos: Position) -> Option<String> {
    let line = line_at(text, pos.line)?;
    let idx = (pos.character as usize).min(line.len());
    let bytes = line.as_bytes();
    let mut start = idx;
    while start > 0 && is_word(bytes[start - 1] as char) {
        start -= 1;
    }
    let mut end = idx;
    while end < bytes.len() && is_word(bytes[end] as char) {
        end += 1;
    }
    if start == end {
        None
    } else {
        Some(line[start..end].to_string())
    }
}

fn word_range(text: &str, pos: Position) -> Option<Range> {
    let line = line_at(text, pos.line)?;
    let idx = (pos.character as usize).min(line.len());
    let bytes = line.as_bytes();
    let mut start = idx;
    while start > 0 && is_word(bytes[start - 1] as char) {
        start -= 1;
    }
    let mut end = idx;
    while end < bytes.len() && is_word(bytes[end] as char) {
        end += 1;
    }
    Some(Range::new(
        Position::new(pos.line, start as u32),
        Position::new(pos.line, end as u32),
    ))
}

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '_' || c == '$'
}

#[tokio::main]
async fn main() {
    let stdin = tokio::io::stdin();
    let stdout = tokio::io::stdout();
    let documents = Arc::new(DocumentStore::default());

    let (service, socket) = LspService::new(|client| Backend {
        client,
        documents: documents.clone(),
    });
    Server::new(stdin, stdout, socket).serve(service).await;
}
