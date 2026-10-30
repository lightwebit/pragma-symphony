use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

// ---------------------------------------------------------------------------
// Core atom structure
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Atom {
    pub id: Uuid,
    pub atom_type: AtomType,
    pub file_path: Option<String>,
    pub file_type: Option<FileType>,
    pub action: Option<FileAction>,
    /// Raw text content of the atom (diff lines, tool params, error message, …)
    pub content: String,
    /// DIFF atoms start collapsed; everything else starts expanded
    pub collapsed: bool,
    pub source: OutputSource,
    pub received_at: DateTime<Utc>,
    pub session_id: Uuid,
}

// ---------------------------------------------------------------------------
// Enumerations
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum AtomType {
    FileTouch,
    Diff,
    ToolUse,
    Error,
    AgentNote,
    UserReply,
    PragmaEvent,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileType {
    Code,
    Config,
    Markup,
    Style,
    Build,
    Data,
    Other,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum FileAction {
    Create,
    Modify,
    Delete,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum OutputSource {
    Stdout,
    Stderr,
    /// Action that arrived from the web: the atom recording it is written by the desktop, marked this way.
    /// In the DB it is plain text like the other two: no migration, and an earlier version of
    /// Pragma reads it back as `Stdout`.
    Remote,
}

// ---------------------------------------------------------------------------
// AtomSink trait — decouples parser from output destination
// (Step 1: StdoutSink  |  Step 3: SqliteSink  |  Step 4: IpcSink)
// ---------------------------------------------------------------------------

pub trait AtomSink: Send {
    fn push(&mut self, atom: Atom) -> anyhow::Result<()>;
    fn flush(&mut self) -> anyhow::Result<()>;
    /// Called once when the session ends. Implementors can write summaries, etc.
    fn finalize(&mut self) -> anyhow::Result<()>;
}

// ---------------------------------------------------------------------------
// Helpers: file-type detection, path validation
// ---------------------------------------------------------------------------

/// Returns true if the string looks like a real filesystem path.
/// Used to reject false positives in FILE_TOUCH pattern matching.
pub fn is_valid_path(s: &str) -> bool {
    let s = s.trim();
    if s.is_empty() {
        return false;
    }
    // If the candidate contains spaces it is very likely natural language
    // (e.g. "the approach to use async/await"). Only accept it if it also
    // has a recognised file extension (e.g. "My File.ts").
    if s.contains(' ') {
        return has_known_extension(s);
    }
    // No spaces: accept if it has path separators or a known extension
    s.contains('/') || s.contains('\\') || has_known_extension(s)
}

fn has_known_extension(s: &str) -> bool {
    const EXTS: &[&str] = &[
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".rs",
        ".py",
        ".go",
        ".java",
        ".rb",
        ".php",
        ".c",
        ".cpp",
        ".cc",
        ".h",
        ".hpp",
        ".vue",
        ".svelte",
        ".json",
        ".toml",
        ".yaml",
        ".yml",
        ".env",
        ".html",
        ".cshtml",
        ".md",
        ".mdx",
        ".css",
        ".scss",
        ".sass",
        ".less",
        ".sql",
        ".csv",
        ".sqlite",
        ".db",
        ".sh",
        ".bash",
        ".zsh",
        ".ps1",
        ".bat",
        ".xml",
        ".proto",
        ".graphql",
        ".txt",
        ".log",
        ".lock", // Cargo.lock, package-lock.json, etc.
        ".dockerfile",
    ];
    let lower = s.to_lowercase();
    EXTS.iter().any(|ext| lower.ends_with(ext))
        || lower == "dockerfile"
        || lower.starts_with("dockerfile.")
        || lower == "makefile"
        || lower == "cargo.lock"
        || lower == "cargo.toml"
}

/// Infers FileType from a file path extension.
pub fn detect_file_type(path: &str) -> FileType {
    let lower = path.to_lowercase();

    // Build / infra — check before code to catch Cargo.lock, etc.
    if lower.ends_with(".lock")
        || lower.contains("dockerfile")
        || lower.contains(".github")
        || lower == "makefile"
        || lower.ends_with(".sh")
        || lower.ends_with(".bash")
        || lower.ends_with(".ps1")
        || lower.ends_with(".bat")
    {
        return FileType::Build;
    }

    // Code
    if matches!(
        lower.rsplit_once('.').map(|(_, e)| e),
        Some(
            "ts" | "tsx"
                | "js"
                | "jsx"
                | "mjs"
                | "cjs"
                | "rs"
                | "py"
                | "go"
                | "java"
                | "rb"
                | "php"
                | "c"
                | "cpp"
                | "cc"
                | "h"
                | "hpp"
                | "vue"
                | "svelte"
                | "swift"
                | "kt"
        )
    ) {
        return FileType::Code;
    }

    // Config
    if matches!(
        lower.rsplit_once('.').map(|(_, e)| e),
        Some("json" | "toml" | "yaml" | "yml" | "env" | "ini" | "cfg" | "conf")
    ) {
        return FileType::Config;
    }

    // Markup / template
    if matches!(
        lower.rsplit_once('.').map(|(_, e)| e),
        Some("html" | "cshtml" | "md" | "mdx" | "xml" | "proto" | "graphql")
    ) {
        return FileType::Markup;
    }

    // Style
    if matches!(
        lower.rsplit_once('.').map(|(_, e)| e),
        Some("css" | "scss" | "sass" | "less")
    ) {
        return FileType::Style;
    }

    // Data
    if matches!(
        lower.rsplit_once('.').map(|(_, e)| e),
        Some("sql" | "csv" | "sqlite" | "db")
    ) {
        return FileType::Data;
    }

    FileType::Other
}
