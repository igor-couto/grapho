use std::collections::HashSet;
use std::io;
use std::path::Path;

use tokio::fs;

use super::DEFAULT_TITLE;

// Leave room for the extension, duplicate suffix, and atomic-write suffix.
const MAX_FILENAME_BYTES: usize = 200;
const EXTENSION: &str = ".md";
const INVALID_CHARS: &str = "<>:\"/\\|?*";

pub(super) fn filename_key(name: &str) -> String {
    name.to_lowercase()
}

pub(super) fn valid_filename(name: &str) -> bool {
    let Some((stem, extension)) = name.rsplit_once('.') else {
        return false;
    };
    extension.eq_ignore_ascii_case("md")
        && !stem.is_empty()
        && stem == trim_stem(stem)
        && name.len() <= MAX_FILENAME_BYTES
        && !reserved(stem)
        && !name.chars().any(invalid_character)
}

pub(super) struct FilenameSet<'a> {
    folder: &'a Path,
    taken: HashSet<String>,
}

impl<'a> FilenameSet<'a> {
    pub(super) async fn read(folder: &'a Path) -> io::Result<Self> {
        let mut taken = HashSet::new();
        let mut entries = fs::read_dir(folder).await?;
        while let Some(entry) = entries.next_entry().await? {
            if let Some(name) = entry.file_name().to_str() {
                taken.insert(filename_key(name));
            }
        }
        Ok(Self { folder, taken })
    }

    /// Preserve a usable name on a move. On a rename, prefer the new title.
    /// A case-only change keeps the existing spelling so both names never
    /// alias the same file during the write and index commit.
    pub(super) async fn claim(
        &mut self,
        title: &str,
        preferred: Option<&str>,
        owned: Option<&str>,
    ) -> io::Result<String> {
        let stem = title_stem(title);
        let first = preferred.map_or_else(|| candidate(&stem, 1), str::to_owned);
        let mut candidates = std::iter::once(first).chain((1..).map(|n| candidate(&stem, n)));
        loop {
            let name = candidates.next().expect("unbounded filename candidates");
            let key = filename_key(&name);
            if let Some(existing) = owned.filter(|existing| filename_key(existing) == key) {
                self.taken.insert(key);
                return Ok(existing.to_owned());
            }
            if self.taken.contains(&key) {
                continue;
            }
            // The filesystem can equate spellings beyond Unicode lowercase.
            match fs::symlink_metadata(self.folder.join(&name)).await {
                Ok(_) => continue,
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    self.taken.insert(key);
                    return Ok(name);
                }
                Err(error) => return Err(error),
            }
        }
    }
}

fn invalid_character(character: char) -> bool {
    character.is_control() || INVALID_CHARS.contains(character)
}

fn trim_stem(stem: &str) -> &str {
    stem.trim_matches(|character: char| character.is_whitespace() || character == '.')
}

fn reserved(stem: &str) -> bool {
    let first = stem
        .split('.')
        .next()
        .unwrap_or_default()
        .trim_end()
        .to_ascii_uppercase();
    matches!(
        first.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$"
    ) || first
        .strip_prefix("COM")
        .or_else(|| first.strip_prefix("LPT"))
        .is_some_and(|number| {
            matches!(
                number,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        })
}

fn title_stem(title: &str) -> String {
    let cleaned: String = title
        .chars()
        .map(|character| {
            if invalid_character(character) {
                '-'
            } else {
                character
            }
        })
        .collect();
    let stem = trim_stem(&cleaned);
    if stem.is_empty() {
        DEFAULT_TITLE.to_owned()
    } else if reserved(stem) {
        format!("_{stem}")
    } else {
        stem.to_owned()
    }
}

fn candidate(stem: &str, number: usize) -> String {
    let suffix = if number == 1 {
        String::new()
    } else {
        format!(" ({number})")
    };
    let limit = MAX_FILENAME_BYTES - suffix.len() - EXTENSION.len();
    let mut end = limit.min(stem.len());
    while !stem.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}{suffix}{EXTENSION}", trim_stem(&stem[..end]))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_become_portable_names_without_losing_readable_text() {
        assert_eq!(
            candidate(&title_stem("Lessons: Week 1"), 1),
            "Lessons- Week 1.md"
        );
        assert_eq!(candidate(&title_stem("con.txt"), 1), "_con.txt.md");
        assert_eq!(candidate(&title_stem("..."), 1), "Untitled document.md");
        assert_eq!(
            candidate(&title_stem("Relatório de Física"), 1),
            "Relatório de Física.md"
        );
        let long = candidate(&title_stem(&"📓".repeat(200)), 2);
        assert!(valid_filename(&long));
        assert!(long.ends_with(" (2).md"));
        assert!(!valid_filename("../Notes.md"));
        assert!(!valid_filename("folder\\Notes.md"));
    }
}
