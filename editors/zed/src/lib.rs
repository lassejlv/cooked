use zed_extension_api::{self as zed, Result};

struct CookedExtension;

impl zed::Extension for CookedExtension {
    fn new() -> Self {
        CookedExtension
    }

    fn language_server_command(
        &mut self,
        _language_server_id: &zed::LanguageServerId,
        worktree: &zed::Worktree,
    ) -> Result<zed::Command> {
        // Prefer an installed binary (`cargo install --path crates/cooked_lsp`),
        // fall back to the workspace build for development on the Cooked repo.
        let command = worktree
            .which("cooked-lsp")
            .unwrap_or_else(|| format!("{}/target/release/cooked-lsp", worktree.root_path()));

        Ok(zed::Command {
            command,
            args: vec![],
            // The LSP shells out to `bun`/`node` for the TypeScript service —
            // give it the user's PATH.
            env: worktree.shell_env(),
        })
    }
}

zed::register_extension!(CookedExtension);
