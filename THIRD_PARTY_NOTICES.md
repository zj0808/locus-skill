# Third-Party Notices

The bundled runtime includes the following dependencies:

| Component | Version | License | Bundled license |
|---|---:|---|---|
| `ignore` | 7.0.6 | MIT | `runtime/vendor/ignore/LICENSE-MIT` |
| `@napi-rs/keyring-win32-x64-msvc` | 1.3.0 | MIT | `runtime/vendor/keyring-win32-x64-msvc/LICENSE` |
| `@vscode/ripgrep` | 1.17.0 | MIT | `runtime/vendor/ripgrep/LICENSE` |
| `ripgrep` executable | bundled by `@vscode/ripgrep` | MIT | `runtime/vendor/ripgrep/RIPGREP-LICENSE-MIT` |
| `sql.js` | 1.14.0 | MIT | `runtime/vendor/sql.js/LICENSE` |
| `tree-node-cli` | 1.6.0 | MIT | `runtime/vendor/tree-node-cli/LICENSE` |

Paths in this table are relative to `skills/locus-code-search/`.

The bundled `tree-node-cli` source is modified to use an internal JavaScript size formatter and directory-size implementation. Its original optional `pretty-bytes` and `fast-folder-size` dependencies are not distributed.
