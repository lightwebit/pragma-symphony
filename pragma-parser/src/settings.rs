use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::PathBuf;

use crate::storage::pragma_db_path;

// ---------------------------------------------------------------------------
// OS detection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HostOs {
    Windows,
    MacOs,
    Linux,
    Unknown,
}

impl HostOs {
    pub fn current() -> Self {
        if cfg!(target_os = "windows") {
            Self::Windows
        } else if cfg!(target_os = "macos") {
            Self::MacOs
        } else if cfg!(target_os = "linux") {
            Self::Linux
        } else {
            Self::Unknown
        }
    }

    /// Cartella Downloads di default per l'OS corrente.
    pub fn default_export_dir() -> Option<PathBuf> {
        let home = std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)?;
        Some(home.join("Downloads"))
    }
}

// ---------------------------------------------------------------------------
// Strutture dati
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub label: String,
    pub binary: String,
    pub config_dir: Option<String>,
    #[serde(default)]
    pub language: Option<String>,
    /// Legacy — kept only for migration. Not written back to JSON.
    #[serde(default, skip_serializing)]
    pub system_prompt: Option<String>,
}

fn default_model_opus() -> String {
    "claude-opus-5".to_string()
}
fn default_model_fable() -> String {
    "claude-fable-5-1".to_string()
}
fn default_model_sonnet() -> String {
    "claude-sonnet-5".to_string()
}
fn default_true() -> bool {
    true
}
fn default_false() -> bool {
    false
}

/// Model ids passed to the agent's `--model` flag, one per UI alias.
///
/// `sonnet` used to be missing here, on the assumption that it was the agent's
/// default — but the installed CLI defaults to Opus, so choosing Sonnet in Pragma
/// ran Opus at five times the cost while `sessions.model` still recorded 'sonnet'.
/// Now every alias always passes an explicit `--model`, so what runs is always
/// what the badge says.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelIds {
    #[serde(default = "default_model_opus")]
    pub opus: String,
    #[serde(default = "default_model_fable")]
    pub fable: String,
    #[serde(default = "default_model_sonnet")]
    pub sonnet: String,
}

impl Default for ModelIds {
    fn default() -> Self {
        Self {
            opus: default_model_opus(),
            fable: default_model_fable(),
            sonnet: default_model_sonnet(),
        }
    }
}

impl ModelIds {
    /// Resolves a UI alias to the model id to pass to `--model`.
    /// `None` = no flag (the agent's default) — today only for an unknown alias.
    pub fn resolve(&self, alias: Option<&str>) -> Option<&str> {
        match alias {
            Some("opus") => Some(self.opus.as_str()),
            Some("fable") => Some(self.fable.as_str()),
            Some("sonnet") => Some(self.sonnet.as_str()),
            _ => None,
        }
    }
}

/// Sharing Pragma on the web through the noema.tools relay. Off by default: whoever
/// does not turn it on never opens a connection. The access key is kept in plain text,
/// like the rest of settings.json — accepted for the first version.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RemoteSettings {
    pub enabled: bool,
    pub hub_url: String,
    pub host_secret: String,
    /// «Allow commands from web»: separate from sharing, off by default. Without a
    /// PIN set the bridge treats it as off.
    pub commands_enabled: bool,
    /// `salt:sha256(salt+PIN)` in hex, or empty. The PIN itself is never stored.
    pub command_pin_hash: String,
    /// The sharing privacy notice has already been shown (and sharing was saved as on
    /// at least once). It only appears the first time sharing is switched on.
    pub share_notice_seen: bool,
}

impl Default for RemoteSettings {
    fn default() -> Self {
        Self {
            enabled: false,
            hub_url: "https://noema.tools/hubs/pragma-live".to_string(),
            host_secret: String::new(),
            commands_enabled: false,
            command_pin_hash: String::new(),
            share_notice_seen: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub profiles: Vec<Profile>,
    pub db_path: Option<String>,
    #[serde(default)]
    pub notifications_enabled: bool,
    /// Plays a sound (ring.mp3, bundled) when a session ends.
    #[serde(default = "default_true")]
    pub sound_enabled: bool,
    #[serde(default)]
    pub default_profile_index: usize,
    /// Destination folder for .md and .json exports.
    /// None = use the OS default (~/Downloads).
    #[serde(default)]
    pub export_dir: Option<String>,
    #[serde(default)]
    pub diff_always_open: bool,
    /// Last working directory used — persisted across restarts.
    #[serde(default)]
    pub last_working_dir: Option<String>,
    /// Model id per alias, sovrascrivibili da settings.json.
    #[serde(default)]
    pub models: ModelIds,
    /// Creates a `pragma/<session-id>` branch at the start of a session in a versioned
    /// working directory. Default OFF: one session a day for weeks produces hundreds of
    /// identical branches (114 seen in this very repo, 113 without a single unique commit).
    /// Someone working alone, with no PR/review acting as a gate, does not need them.
    /// If off, or if working_dir is not a git repo, no branch is created: work always
    /// happens on the current branch.
    #[serde(default = "default_false")]
    pub session_branch_enabled: bool,
    /// Runs the independent REVIEW session after a finished session (and a green VERIFY).
    /// On by default; it costs one review per finished session. It works with or without a
    /// session branch: the base of the diff is the commit (plus uncommitted changes) the
    /// session started from.
    #[serde(default = "default_true")]
    pub review_enabled: bool,
    /// Enables the E2E button/popup. Off = configuration stays visible but
    /// no run is allowed, without losing the saved command/spec.
    #[serde(default = "default_true")]
    pub e2e_enabled: bool,
    /// Sharing on the web. Block absent in an old settings.json = off.
    #[serde(default)]
    pub remote: RemoteSettings,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            profiles: Vec::new(),
            db_path: None,
            notifications_enabled: false,
            sound_enabled: default_true(),
            default_profile_index: 0,
            export_dir: None,
            diff_always_open: false,
            last_working_dir: None,
            models: ModelIds::default(),
            session_branch_enabled: default_false(),
            review_enabled: default_true(),
            e2e_enabled: default_true(),
            remote: RemoteSettings::default(),
        }
    }
}

/// Resolves the export folder: uses the configured one, otherwise ~/Downloads.
/// Creates the folder if it does not exist.
pub fn resolve_export_dir(settings: &Settings) -> Result<PathBuf> {
    let dir = match &settings.export_dir {
        Some(p) if !p.trim().is_empty() => PathBuf::from(p),
        _ => HostOs::default_export_dir()
            .unwrap_or_else(|| pragma_db_path().unwrap().parent().unwrap().join("exports")),
    };
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

// ---------------------------------------------------------------------------
// Settings file path
// ---------------------------------------------------------------------------

pub fn settings_path() -> Result<PathBuf> {
    let db = pragma_db_path()?;
    Ok(db.parent().unwrap().join("settings.json"))
}

pub fn prompts_dir() -> Result<PathBuf> {
    let db = pragma_db_path()?;
    let dir = db.parent().unwrap().join("prompts");
    std::fs::create_dir_all(&dir)?;
    Ok(dir)
}

/// Turns a label into a safe file name: lowercase, only [a-z0-9_-].
fn label_to_filename(label: &str) -> String {
    label
        .to_lowercase()
        .chars()
        .map(|c| {
            if c.is_alphanumeric() || c == '-' {
                c
            } else {
                '_'
            }
        })
        .collect::<String>()
        .trim_matches('_')
        .to_string()
}

/// Loads the prompt for the profile with the given label, if it exists.
/// NOTE: prompts are stored as plain text in ~/.pragma/prompts/<label>.txt. Encryption
///       is not implemented and not currently scheduled — anyone with filesystem access
///       to that directory can read them.
pub fn load_prompt(label: &str) -> Option<String> {
    let dir = prompts_dir().ok()?;
    let path = dir.join(format!("{}.txt", label_to_filename(label)));
    let text = std::fs::read_to_string(&path).ok()?;
    let trimmed = text.trim().to_string();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

// ---------------------------------------------------------------------------
// Lettura / scrittura
// ---------------------------------------------------------------------------

pub fn load_settings() -> Result<Settings> {
    let path = settings_path()?;
    if !path.exists() {
        return Ok(Settings::default());
    }
    let content = std::fs::read_to_string(&path)
        .with_context(|| format!("reading settings: {}", path.display()))?;
    let mut settings: Settings = serde_json::from_str(&content).context("parsing settings.json")?;

    // Migrazione: system_prompt inline → file esterno
    let mut migrated = false;
    for profile in &mut settings.profiles {
        if let Some(prompt) = profile.system_prompt.take() {
            if !prompt.trim().is_empty() {
                if let Ok(dir) = prompts_dir() {
                    let file = dir.join(format!("{}.txt", label_to_filename(&profile.label)));
                    if !file.exists() {
                        let _ = std::fs::write(&file, &prompt);
                    }
                }
                migrated = true;
            }
        }
    }
    if migrated {
        // Rewrite without system_prompt (skip_serializing already excludes it)
        let _ = save_settings(&settings);
    }

    Ok(settings)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A settings.json without `sessionBranchEnabled` (a fresh install, or one that predates
    /// the field) must no longer create branches: default OFF. A settings.json that HAS the
    /// field, explicitly written as `true` before the change, stays `true` — the default
    /// does not rewrite a saved choice.
    #[test]
    fn session_branch_enabled_defaults_to_off_but_an_explicit_true_survives() {
        let without_key: Settings =
            serde_json::from_str(r#"{"profiles": []}"#).expect("no sessionBranchEnabled");
        assert!(!without_key.session_branch_enabled);

        let with_explicit_true: Settings =
            serde_json::from_str(r#"{"profiles": [], "sessionBranchEnabled": true}"#)
                .expect("sessionBranchEnabled esplicito");
        assert!(with_explicit_true.session_branch_enabled);

        assert!(!Settings::default().session_branch_enabled);
    }

    /// A settings.json written before web sharing has no `remote` block: sharing must be
    /// off, with no key, and a partial block must not break parsing.
    #[test]
    fn remote_sharing_is_off_unless_explicitly_enabled() {
        let old: Settings = serde_json::from_str(r#"{"profiles": []}"#).expect("senza remote");
        assert!(!old.remote.enabled);
        assert!(old.remote.host_secret.is_empty());
        assert_eq!(old.remote.hub_url, "https://noema.tools/hubs/pragma-live");
        assert!(!Settings::default().remote.enabled);
        // Commands from the web stay off, and without a PIN, for whoever does not switch them on.
        assert!(!old.remote.commands_enabled);
        assert!(old.remote.command_pin_hash.is_empty());
        // The sharing notice does not show as already seen for anyone updating.
        assert!(!old.remote.share_notice_seen);

        let partial: Settings =
            serde_json::from_str(r#"{"profiles": [], "remote": {"enabled": true}}"#)
                .expect("remote parziale");
        assert!(partial.remote.enabled);
        assert_eq!(
            partial.remote.hub_url,
            "https://noema.tools/hubs/pragma-live"
        );

        let full: Settings = serde_json::from_str(
            r#"{"profiles": [], "remote": {"enabled": true, "hubUrl": "http://localhost:5000/hubs/pragma-live", "hostSecret": "s"}}"#,
        )
        .expect("remote completo");
        assert_eq!(
            full.remote.hub_url,
            "http://localhost:5000/hubs/pragma-live"
        );
        assert_eq!(full.remote.host_secret, "s");
    }

    /// `resolve` must return the default model ids.
    #[test]
    fn settings_without_models_key_uses_defaults() {
        let json = r#"{
            "profiles": [],
            "db_path": null
        }"#;
        let settings: Settings =
            serde_json::from_str(json).expect("parsing settings.json without 'models'");

        assert_eq!(settings.models.opus, default_model_opus());
        assert_eq!(settings.models.fable, default_model_fable());
        assert_eq!(settings.models.sonnet, default_model_sonnet());
        assert_eq!(
            settings.models.resolve(Some("opus")),
            Some(default_model_opus().as_str())
        );
        assert_eq!(
            settings.models.resolve(Some("fable")),
            Some(default_model_fable().as_str())
        );
        assert_eq!(
            settings.models.resolve(Some("sonnet")),
            Some(default_model_sonnet().as_str())
        );
        assert_eq!(settings.models.resolve(None), None);
    }

    /// A settings.json saved by an earlier version may carry fields that no longer exist
    /// (here `oldFeatureEnabled`/`oldFeatureUrl`/`oldFeatureTimeoutSecs`).
    /// They must be ignored without errors, the other settings must stay, and on the
    /// next save the three fields disappear from the file.
    #[test]
    fn settings_json_with_removed_fields_still_loads() {
        let json = r#"{
            "profiles": [],
            "notificationsEnabled": true,
            "soundEnabled": false,
            "lastWorkingDir": "C:\\work\\demo",
            "oldFeatureEnabled": true,
            "oldFeatureUrl": "https://localhost:7151/",
            "oldFeatureTimeoutSecs": 3,
            "sessionBranchEnabled": false
        }"#;

        let settings: Settings =
            serde_json::from_str(json).expect("a settings.json with removed fields must load");

        assert!(settings.notifications_enabled);
        assert!(!settings.sound_enabled);
        assert_eq!(settings.last_working_dir.as_deref(), Some("C:\\work\\demo"));
        assert!(!settings.session_branch_enabled);

        let saved = serde_json::to_string(&settings).unwrap();
        assert!(
            !saved.to_lowercase().contains("oldfeature"),
            "removed fields must not be written back: {saved}"
        );
    }

    #[test]
    fn model_ids_resolve_matches_default_values() {
        let models = ModelIds::default();
        assert_eq!(models.resolve(Some("opus")), Some("claude-opus-5"));
        assert_eq!(models.resolve(Some("fable")), Some("claude-fable-5-1"));
        assert_eq!(models.resolve(Some("sonnet")), Some("claude-sonnet-5"));
    }
}

pub fn save_settings(settings: &Settings) -> Result<()> {
    let path = settings_path()?;
    let json = serde_json::to_string_pretty(settings)?;
    std::fs::write(&path, json).with_context(|| format!("writing settings: {}", path.display()))
}

// ---------------------------------------------------------------------------
// Auto-detect binario claude
// ---------------------------------------------------------------------------

/// Looks for the claude binary in this order:
/// 1. system PATH (where/which)
/// 2. ~/.local/bin/claude  (typical Linux/Mac install)
/// 3. %APPDATA%/../Local/Programs/claude/claude.exe (Windows)
pub fn detect_claude_binary() -> Option<String> {
    // 1. where/which
    let cmd = if cfg!(windows) { "where" } else { "which" };
    if let Ok(out) = std::process::Command::new(cmd).arg("claude").output() {
        if out.status.success() {
            let path = String::from_utf8_lossy(&out.stdout);
            let first = path.lines().next().unwrap_or("").trim().to_string();
            if !first.is_empty() {
                return Some(first);
            }
        }
    }

    // 2. ~/.local/bin/claude
    if let Some(home) = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
    {
        let candidate = home.join(".local").join("bin").join("claude");
        if candidate.exists() {
            return Some(candidate.to_string_lossy().to_string());
        }
        // Windows: ~/.local/bin/claude.exe
        let candidate_exe = home.join(".local").join("bin").join("claude.exe");
        if candidate_exe.exists() {
            return Some(candidate_exe.to_string_lossy().to_string());
        }
    }

    None
}

/// The CLI's config folder when a profile does not specify its own
/// (`CLAUDE_CONFIG_DIR` is not passed, the CLI uses `~/.claude`).
fn default_claude_config_dir() -> Option<PathBuf> {
    let home = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE"))?;
    Some(PathBuf::from(home).join(".claude"))
}

/// The Pragma protocol is injected with `--append-system-prompt`, which adds to
/// whatever output style the CLI uses but has never been verified against a style other
/// than the default. If the profile's `settings.json` has a non-default `outputStyle`,
/// the ANALYSIS/PLAN/… markers might not survive — this is only a warning, not a block:
/// Pragma does not decide for the user what goes in the CLI config.
///
/// `config_dir`: same value as `Profile.config_dir` (None = default `~/.claude`).
/// Returns `None` if the style is absent/default, or if the file does not exist or cannot be read.
pub fn output_style_warning(config_dir: Option<&str>) -> Option<String> {
    let dir = match config_dir.map(str::trim) {
        Some(d) if !d.is_empty() => PathBuf::from(d),
        _ => default_claude_config_dir()?,
    };
    let content = std::fs::read_to_string(dir.join("settings.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&content).ok()?;
    let style = json.get("outputStyle")?.as_str()?.trim();
    if style.is_empty() || style.eq_ignore_ascii_case("default") {
        return None;
    }
    Some(style.to_string())
}

/// Loads the settings and, if there are no profiles, tries to add a "claude"
/// profile with the auto-detected binary. Returns the settings (modified or not).
pub fn load_settings_with_autodetect() -> Result<Settings> {
    let mut settings = load_settings()?;
    if settings.profiles.is_empty() {
        if let Some(binary) = detect_claude_binary() {
            settings.profiles.push(Profile {
                label: "claude".to_string(),
                binary,
                config_dir: None,
                language: None,
                system_prompt: None,
            });
            save_settings(&settings)?;
        }
    }
    Ok(settings)
}

#[cfg(test)]
mod output_style_tests {
    use super::*;

    fn temp_config_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "pragma-output-style-{label}-{}",
            uuid::Uuid::new_v4()
        ))
    }

    #[test]
    fn no_output_style_key_is_no_warning() {
        let dir = temp_config_dir("none");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), r#"{"theme":"dark"}"#).unwrap();

        assert_eq!(output_style_warning(Some(dir.to_str().unwrap())), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn default_output_style_is_no_warning() {
        let dir = temp_config_dir("default");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("settings.json"), r#"{"outputStyle":"default"}"#).unwrap();

        assert_eq!(output_style_warning(Some(dir.to_str().unwrap())), None);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn custom_output_style_warns() {
        let dir = temp_config_dir("custom");
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"outputStyle":"Explanatory"}"#,
        )
        .unwrap();

        assert_eq!(
            output_style_warning(Some(dir.to_str().unwrap())),
            Some("Explanatory".to_string())
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_settings_json_is_no_warning() {
        let dir = temp_config_dir("missing");
        // Cartella nemmeno creata: settings.json non esiste.
        assert_eq!(output_style_warning(Some(dir.to_str().unwrap())), None);
    }
}
