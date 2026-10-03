//! Run configurations: the project's `.aditor/run.json`, and what the project
//! looks like it can run.
//!
//! The file is opaque here, the way `settings.json` is to `settings.rs`: the
//! frontend's `src/run/schema.ts` owns its shape. It lives in the project so it
//! can be committed and shared, which also means it can come from anyone who
//! can push to the repo -- nothing here or in the frontend ever runs a
//! configuration without the user pressing Run.
//!
//! Detection only reads a handful of well-known files at the root (and `cmd/*`
//! for Go). It suggests; the user picks what to keep.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::Serialize;
use serde_json::{json, Value};
use tauri::State;

use crate::fs::{off_thread, workspace_root, Workspace};

const DIR: &str = ".aditor";
const FILE: &str = "run.json";

/// Serializes writes, so two quick saves cannot interleave their renames.
static GATE: Mutex<()> = Mutex::new(());

/// The project's run.json, or null when it has none. A file that is not
/// valid JSON is an error, not null: the UI must say so rather than offer to
/// save over a file someone is halfway through editing by hand.
#[tauri::command]
pub async fn run_configs_read(ws: State<'_, Workspace>, root: String) -> Result<Value, String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || read_from(&root)).await
}

#[tauri::command]
pub async fn run_configs_write(
    ws: State<'_, Workspace>,
    root: String,
    value: Value,
) -> Result<(), String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || {
        let _gate = GATE.lock().unwrap_or_else(|e| e.into_inner());
        write_to(&root, &value)
    })
    .await
}

/// Configurations the project looks like it wants, for the dialog to offer.
#[tauri::command]
pub async fn run_detect(ws: State<'_, Workspace>, root: String) -> Result<Detected, String> {
    let root = workspace_root(&ws, &root)?;
    off_thread(move || Ok(detect(&root))).await
}

fn read_from(root: &Path) -> Result<Value, String> {
    let path = root.join(DIR).join(FILE);
    match fs::read_to_string(&path) {
        Ok(text) => {
            serde_json::from_str(&text).map_err(|e| format!("{DIR}/{FILE} is not valid JSON: {e}"))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(format!("{DIR}/{FILE}: {e}")),
    }
}

/// Temp file and rename, so the watcher -- and an agent reading it -- never
/// sees half a file. Ordinary permissions: this is a project file meant to be
/// committed, not a private one.
fn write_to(root: &Path, value: &Value) -> Result<(), String> {
    let dir = root.join(DIR);
    fs::create_dir_all(&dir).map_err(|e| format!("could not create {DIR}: {e}"))?;
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?;
    bytes.push(b'\n');
    let path = dir.join(FILE);
    let tmp = dir.join(format!(".{FILE}.{}.tmp", std::process::id()));
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(&bytes).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, &path).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        format!("could not write {DIR}/{FILE}: {e}")
    })
}

// -------------------------------------------------------------- detection ---

#[derive(Serialize, Default, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Detected {
    /// From the lockfile, for an npm configuration left on "auto".
    package_manager: Option<&'static str>,
    /// A project virtualenv's interpreter, relative to the root, for a Python
    /// configuration left on "auto".
    python: Option<String>,
    suggestions: Vec<Suggestion>,
}

/// A ready-made configuration body: `type` plus that type's fields. The
/// frontend fills in everything else (id, env, ...) from its defaults.
#[derive(Serialize, Debug)]
pub struct Suggestion {
    name: String,
    config: Value,
}

fn suggest(out: &mut Vec<Suggestion>, name: impl Into<String>, config: Value) {
    out.push(Suggestion {
        name: name.into(),
        config,
    });
}

fn detect(root: &Path) -> Detected {
    let mut d = Detected::default();
    npm(root, &mut d);
    cargo(root, &mut d.suggestions);
    go(root, &mut d.suggestions);
    python(root, &mut d);
    maven(root, &mut d.suggestions);
    gradle(root, &mut d.suggestions);
    d
}

fn read(path: PathBuf) -> Option<String> {
    fs::read_to_string(path).ok()
}

fn npm(root: &Path, d: &mut Detected) {
    let Some(pkg) =
        read(root.join("package.json")).and_then(|t| serde_json::from_str::<Value>(&t).ok())
    else {
        return;
    };
    d.package_manager = Some(if root.join("pnpm-lock.yaml").exists() {
        "pnpm"
    } else if root.join("yarn.lock").exists() {
        "yarn"
    } else if root.join("bun.lockb").exists() || root.join("bun.lock").exists() {
        "bun"
    } else {
        "npm"
    });
    if let Some(scripts) = pkg.get("scripts").and_then(Value::as_object) {
        for script in scripts.keys() {
            suggest(
                &mut d.suggestions,
                script.clone(),
                json!({ "type": "npm", "script": script }),
            );
        }
    }
}

fn cargo(root: &Path, out: &mut Vec<Suggestion>) {
    let Some(manifest) = read(root.join("Cargo.toml")).and_then(|t| t.parse::<toml::Table>().ok())
    else {
        return;
    };
    let package = manifest
        .get("package")
        .and_then(|p| p.get("name"))
        .and_then(|n| n.as_str());
    let mut bins: Vec<String> = manifest
        .get("bin")
        .and_then(|b| b.as_array())
        .into_iter()
        .flatten()
        .filter_map(|b| b.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .collect();
    if let Ok(entries) = fs::read_dir(root.join("src/bin")) {
        for e in entries.flatten() {
            let path = e.path();
            let name = if path.extension().is_some_and(|x| x == "rs") {
                path.file_stem().map(|s| s.to_string_lossy().to_string())
            } else if path.join("main.rs").is_file() {
                path.file_name().map(|s| s.to_string_lossy().to_string())
            } else {
                None
            };
            if let Some(name) = name.filter(|n| !bins.contains(n)) {
                bins.push(name);
            }
        }
    }
    bins.sort();

    if package.is_some() && root.join("src/main.rs").is_file() && bins.is_empty() {
        suggest(
            out,
            "cargo run",
            json!({ "type": "cargo", "subcommand": "run" }),
        );
    }
    // With several binaries `cargo run` alone refuses to pick one.
    for bin in &bins {
        suggest(
            out,
            format!("cargo run --bin {bin}"),
            json!({ "type": "cargo", "subcommand": "run", "bin": bin }),
        );
    }
    if package.is_some() || manifest.contains_key("workspace") {
        suggest(
            out,
            "cargo test",
            json!({ "type": "cargo", "subcommand": "test" }),
        );
        suggest(
            out,
            "cargo build",
            json!({ "type": "cargo", "subcommand": "build" }),
        );
    }
}

fn go(root: &Path, out: &mut Vec<Suggestion>) {
    if !root.join("go.mod").is_file() {
        return;
    }
    if root.join("main.go").is_file() {
        suggest(
            out,
            "go run .",
            json!({ "type": "go", "subcommand": "run", "package": "." }),
        );
    }
    let mut cmds: Vec<String> = fs::read_dir(root.join("cmd"))
        .into_iter()
        .flatten()
        .flatten()
        .filter(|e| e.path().join("main.go").is_file())
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    cmds.sort();
    for cmd in cmds {
        let package = format!("./cmd/{cmd}");
        suggest(
            out,
            format!("go run {package}"),
            json!({ "type": "go", "subcommand": "run", "package": package }),
        );
    }
    suggest(
        out,
        "go test ./...",
        json!({ "type": "go", "subcommand": "test", "package": "./..." }),
    );
}

fn python(root: &Path, d: &mut Detected) {
    d.python = [".venv/bin/python", "venv/bin/python"]
        .into_iter()
        .find(|p| root.join(p).exists())
        .map(str::to_string);
    let out = &mut d.suggestions;
    if root.join("manage.py").is_file() {
        suggest(
            out,
            "manage.py runserver",
            json!({ "type": "python", "mode": "script", "target": "manage.py", "args": "runserver" }),
        );
    }
    for script in ["main.py", "app.py"] {
        if root.join(script).is_file() {
            suggest(
                out,
                script,
                json!({ "type": "python", "mode": "script", "target": script }),
            );
        }
    }
    // `[project.scripts] name = "pkg.module:func"` -- run the module; the
    // console script itself only exists once the package is installed.
    let scripts = read(root.join("pyproject.toml"))
        .and_then(|t| t.parse::<toml::Table>().ok())
        .and_then(|t| t.get("project")?.get("scripts")?.as_table().cloned());
    for (name, target) in scripts.into_iter().flatten() {
        if let Some(module) = target.as_str().and_then(|t| t.split(':').next()) {
            suggest(
                out,
                name,
                json!({ "type": "python", "mode": "module", "target": module.trim() }),
            );
        }
    }
}

fn maven(root: &Path, out: &mut Vec<Suggestion>) {
    let Some(pom) = read(root.join("pom.xml")) else {
        return;
    };
    let wrapper = root.join("mvnw").is_file();
    let goal = if pom.contains("spring-boot-maven-plugin") {
        "spring-boot:run"
    } else {
        "package"
    };
    suggest(
        out,
        format!("mvn {goal}"),
        json!({ "type": "maven", "goals": goal, "wrapper": wrapper }),
    );
    suggest(
        out,
        "mvn test",
        json!({ "type": "maven", "goals": "test", "wrapper": wrapper }),
    );
}

fn gradle(root: &Path, out: &mut Vec<Suggestion>) {
    let Some(build) =
        read(root.join("build.gradle.kts")).or_else(|| read(root.join("build.gradle")))
    else {
        return;
    };
    let wrapper = root.join("gradlew").is_file();
    let task = if build.contains("org.springframework.boot") {
        "bootRun"
    } else {
        "run"
    };
    suggest(
        out,
        format!("gradle {task}"),
        json!({ "type": "gradle", "tasks": task, "wrapper": wrapper }),
    );
    suggest(
        out,
        "gradle test",
        json!({ "type": "gradle", "tasks": "test", "wrapper": wrapper }),
    );
}

/// For the tests: the suggestion bodies by name.
#[cfg(test)]
fn by_name(d: &Detected) -> serde_json::Map<String, Value> {
    d.suggestions
        .iter()
        .map(|s| (s.name.clone(), s.config.clone()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("aditor-run-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn put(root: &Path, rel: &str, text: &str) {
        let path = root.join(rel);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, text).unwrap();
    }

    #[test]
    fn missing_file_reads_as_null_and_round_trips() {
        let root = scratch("roundtrip");
        assert_eq!(read_from(&root).unwrap(), Value::Null);
        let value = json!({ "version": 1, "configs": [{ "id": "a", "type": "shell" }] });
        write_to(&root, &value).unwrap();
        assert_eq!(read_from(&root).unwrap(), value);
    }

    #[test]
    fn invalid_json_is_an_error() {
        let root = scratch("invalid");
        put(&root, ".aditor/run.json", "{ nope");
        assert!(read_from(&root).is_err());
    }

    #[test]
    fn npm_scripts_and_lockfile() {
        let root = scratch("npm");
        put(
            &root,
            "package.json",
            r#"{ "scripts": { "dev": "vite", "build": "tsc" } }"#,
        );
        put(&root, "pnpm-lock.yaml", "");
        let d = detect(&root);
        assert_eq!(d.package_manager, Some("pnpm"));
        let s = by_name(&d);
        assert_eq!(s["dev"], json!({ "type": "npm", "script": "dev" }));
        assert!(s.contains_key("build"));
    }

    #[test]
    fn cargo_bins() {
        let root = scratch("cargo");
        put(
            &root,
            "Cargo.toml",
            "[package]\nname = \"x\"\n\n[[bin]]\nname = \"server\"\n",
        );
        put(&root, "src/bin/tool.rs", "fn main() {}");
        let s = by_name(&detect(&root));
        assert_eq!(s["cargo run --bin server"]["bin"], "server");
        assert_eq!(s["cargo run --bin tool"]["bin"], "tool");
        assert!(s.contains_key("cargo test"));
        assert!(!s.contains_key("cargo run"));
    }

    #[test]
    fn go_mains() {
        let root = scratch("go");
        put(&root, "go.mod", "module x");
        put(&root, "main.go", "package main");
        put(&root, "cmd/api/main.go", "package main");
        let s = by_name(&detect(&root));
        assert!(s.contains_key("go run ."));
        assert_eq!(s["go run ./cmd/api"]["package"], "./cmd/api");
    }

    #[test]
    fn python_entry_points_and_venv() {
        let root = scratch("python");
        put(&root, "main.py", "");
        put(&root, ".venv/bin/python", "");
        put(
            &root,
            "pyproject.toml",
            "[project]\nname = \"x\"\n[project.scripts]\nserve = \"x.cli:main\"\n",
        );
        let d = detect(&root);
        assert_eq!(d.python.as_deref(), Some(".venv/bin/python"));
        let s = by_name(&d);
        assert_eq!(
            s["serve"],
            json!({ "type": "python", "mode": "module", "target": "x.cli" })
        );
        assert!(s.contains_key("main.py"));
    }

    #[test]
    fn java_builds() {
        let root = scratch("java");
        put(
            &root,
            "pom.xml",
            "<plugin>spring-boot-maven-plugin</plugin>",
        );
        put(&root, "mvnw", "");
        put(&root, "build.gradle.kts", "plugins { application }");
        let s = by_name(&detect(&root));
        assert_eq!(s["mvn spring-boot:run"]["wrapper"], true);
        assert_eq!(s["gradle run"]["wrapper"], false);
    }
}
