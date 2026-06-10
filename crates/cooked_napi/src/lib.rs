//! Node-facing bindings for the Cooked compiler.

use napi_derive::napi;

#[napi(object)]
pub struct CompileResult {
    pub code: String,
    pub map: String,
    pub declarations: String,
    pub errors: Vec<String>,
}

/// Compile a `.ck` source string into a JS module targeting the `cooked` runtime.
#[napi]
pub fn compile(source: String, filename: Option<String>) -> CompileResult {
    let filename = filename.unwrap_or_else(|| "<cooked>".to_string());
    let out = cooked_compiler::compile_with_filename(&source, &filename);
    CompileResult {
        code: out.code,
        map: out.map,
        declarations: out.declarations,
        errors: out.errors,
    }
}
