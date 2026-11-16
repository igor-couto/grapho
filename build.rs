//! Records the commit this binary was built from, so `/version` can report it.
//!
//! The variables are absent when git is unavailable, or when the sources were
//! copied without a `.git` directory, as the container image build does. The
//! page then says "unknown" rather than failing.

use std::process::Command;

fn main() {
    let commands: [(&str, &[&str]); 3] = [
        (
            "GRAPHO_TAG",
            &["describe", "--tags", "--exact-match", "HEAD"],
        ),
        ("GRAPHO_COMMIT", &["rev-parse", "--short=10", "HEAD"]),
        (
            "GRAPHO_COMMIT_DATE",
            &["show", "-s", "--format=%cs", "HEAD"],
        ),
    ];

    for (variable, arguments) in commands {
        if let Some(value) = git(arguments) {
            println!("cargo:rustc-env={variable}={value}");
        }
    }
}

fn git(arguments: &[&str]) -> Option<String> {
    let output = Command::new("git").args(arguments).output().ok()?;
    if !output.status.success() {
        return None;
    }

    let text = String::from_utf8(output.stdout).ok()?.trim().to_owned();
    (!text.is_empty()).then_some(text)
}
