//! Node-facing bindings for the Cooked compiler.

use napi_derive::napi;

#[napi(object)]
pub struct CompileResult {
    pub code: String,
    pub errors: Vec<String>,
}

/// Compile a `.ck` source string into a JS module targeting the `cooked` runtime.
#[napi]
pub fn compile(source: String) -> CompileResult {
    let out = cooked_compiler::compile(&source);
    CompileResult { code: out.code, errors: out.errors }
}
