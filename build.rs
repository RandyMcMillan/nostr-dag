use std::env;
use std::fs;
use std::process::Command;
use std::path::PathBuf;

fn main() {
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=build.rs");

    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR not set"));
    let version = env::var("CARGO_PKG_VERSION").expect("CARGO_PKG_VERSION not set");
    let app_name = env::var("CARGO_PKG_NAME").expect("CARGO_PKG_NAME not set");
    let git_hash = git_previous_short_hash(&manifest_dir)
        .unwrap_or_else(|| "unknown".to_string());
    let branded_version = format!("{version}+{git_hash}");

    let output = manifest_dir.join("demo/shared/app-version.generated.mjs");
    let contents = format!(
        "export const APP_NAME = '{}';\nexport const APP_VERSION = '{}';\n",
        app_name,
        branded_version
    );

    println!("cargo:rustc-env=APP_NAME={app_name}");
    println!("cargo:rustc-env=APP_VERSION={branded_version}");

    if let Ok(existing) = fs::read_to_string(&output) {
        if existing == contents {
            return;
        }
    }

    fs::write(&output, contents).expect("failed to write demo/shared/app-version.generated.mjs");
}

fn git_previous_short_hash(manifest_dir: &PathBuf) -> Option<String> {
    let output = Command::new("git")
        .args(["rev-parse", "--short=7", "HEAD^"])
        .current_dir(manifest_dir)
        .output()
        .ok()?;

    if !output.status.success() {
        return None;
    }

    let hash = String::from_utf8(output.stdout).ok()?.trim().to_string();
    if hash.is_empty() {
        None
    } else {
        Some(hash)
    }
}
