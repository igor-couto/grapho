//! The Markdown written to disk. Ordinary editor blocks use portable Markdown.
//! Safe HTML preserves the few rich-text details Markdown cannot express.

use std::collections::BTreeMap;

use base64::{engine::general_purpose::STANDARD, Engine};
use html_escape::{decode_html_entities, encode_double_quoted_attribute, encode_text};
use sha2::{Digest, Sha256};
use uuid::Uuid;

pub type ImageAttributes = BTreeMap<String, Vec<BTreeMap<String, String>>>;

const IMAGE_ATTRIBUTES: &[&str] = &[
    "class",
    "width",
    "height",
    "data-width",
    "data-radius",
    "data-x",
    "data-y",
];

pub struct Body {
    pub markdown: String,
    pub images: BTreeMap<String, Vec<u8>>,
    pub image_attributes: ImageAttributes,
}

pub fn attachment_owner(name: &str) -> Option<Uuid> {
    let (stem, extension) = name.rsplit_once('.')?;
    mime(extension)?;
    let (id, digest) = stem.rsplit_once('-')?;
    if id.len() != 36 || digest.len() != 64 || !digest.bytes().all(|byte| byte.is_ascii_hexdigit())
    {
        return None;
    }
    let parsed = Uuid::parse_str(id).ok()?;
    (parsed.to_string() == id).then_some(parsed)
}

fn mime(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        "gif" => Some("image/gif"),
        "avif" => Some("image/avif"),
        _ => None,
    }
}

pub fn attachment_content_type(name: &str) -> Option<&'static str> {
    mime(name.rsplit_once('.')?.1)
}

#[derive(Clone, Copy)]
struct Element<'a> {
    name: &'a str,
    opening: &'a str,
    inner: &'a str,
    raw: &'a str,
}

fn tag(input: &str) -> Option<(&str, &str)> {
    let content = input.strip_prefix('<')?;
    let name_end = content.find(|c: char| c.is_ascii_whitespace() || c == '>')?;
    let name = &content[..name_end];
    if name.is_empty()
        || !name
            .trim_start_matches('/')
            .bytes()
            .all(|b| b.is_ascii_alphanumeric())
    {
        return None;
    }
    let mut quote = None;
    for (index, c) in content.char_indices().skip(name_end) {
        match (quote, c) {
            (None, '"' | '\'') => quote = Some(c),
            (Some(open), c) if open == c => quote = None,
            (None, '>') => return Some((name, &input[..index + 2])),
            _ => {}
        }
    }
    None
}

fn element(input: &str) -> Option<Element<'_>> {
    let (name, opening) = tag(input)?;
    if name.starts_with('/') {
        return None;
    }
    if matches!(name, "br" | "hr" | "img") {
        return Some(Element {
            name,
            opening,
            inner: "",
            raw: opening,
        });
    }

    let mut depth = 1;
    let mut at = opening.len();
    while let Some(next) = input[at..].find('<') {
        at += next;
        let Some((found, token)) = tag(&input[at..]) else {
            at += 1;
            continue;
        };
        if found == name {
            depth += 1;
        } else if found.strip_prefix('/') == Some(name) {
            depth -= 1;
            if depth == 0 {
                return Some(Element {
                    name,
                    opening,
                    inner: &input[opening.len()..at],
                    raw: &input[..at + token.len()],
                });
            }
        }
        at += token.len();
    }
    None
}

fn attributes(mut opening: &str) -> impl Iterator<Item = (&str, &str)> {
    // The writer only receives the sanitizer's double-quoted HTML.
    opening = opening.split_once(' ').map_or("", |(_, rest)| rest);
    std::iter::from_fn(move || {
        let (name, rest) = opening.trim_start().split_once("=\"")?;
        let (value, rest) = rest.split_once('"')?;
        opening = rest;
        Some((name, value))
    })
}

pub(crate) fn escape_markdown(text: &str) -> String {
    let mut output = String::new();
    for c in text.chars() {
        if matches!(c, '\\' | '*' | '_' | '~' | '[' | ']' | '<' | '>' | '\x60') {
            output.push('\\');
        }
        output.push(c);
    }
    output
}

fn longest_ticks(text: &str) -> usize {
    text.split(|c| c != '\x60').map(str::len).max().unwrap_or(0)
}

fn inline_markdown(mut input: &str, depth: usize) -> Option<String> {
    if depth == 16 {
        return None;
    }
    let mut output = String::new();
    while !input.is_empty() {
        let Some(at) = input.find('<') else {
            output.push_str(&escape_markdown(&decode_html_entities(input)));
            break;
        };
        output.push_str(&escape_markdown(&decode_html_entities(&input[..at])));
        let item = element(&input[at..])?;
        let markdown = match item.name {
            "br" | "u" => item.raw.to_owned(),
            "code" if !item.inner.contains('<') => {
                let text = decode_html_entities(item.inner);
                let ticks = "\x60".repeat(longest_ticks(&text) + 1);
                let pad = if text.starts_with(['\x60', ' ']) || text.ends_with(['\x60', ' ']) {
                    " "
                } else {
                    ""
                };
                format!("{ticks}{pad}{text}{pad}{ticks}")
            }
            "a" => {
                let href = attributes(item.opening)
                    .find(|(name, _)| *name == "href")?
                    .1;
                let href = decode_html_entities(href);
                let label = inline_markdown(item.inner, depth + 1)?;
                format!("[{label}]({href})")
            }
            "b" | "strong" | "i" | "em" | "s" | "del" | "strike" => {
                let mark = match item.name {
                    "b" | "strong" => "**",
                    "s" | "del" | "strike" => "~~",
                    _ => "*",
                };
                let inner = inline_markdown(item.inner, depth + 1)?;
                if inner.starts_with(char::is_whitespace) || inner.ends_with(char::is_whitespace) {
                    return None;
                }
                format!("{mark}{inner}{mark}")
            }
            _ => return None,
        };
        output.push_str(&markdown);
        input = &input[at + item.raw.len()..];
    }
    Some(output)
}

fn same_html(left: &str, right: &str) -> bool {
    fn canonical(html: &str) -> String {
        html.replace("<strong>", "<b>")
            .replace("</strong>", "</b>")
            .replace("<em>", "<i>")
            .replace("</em>", "</i>")
            .replace("<del>", "<s>")
            .replace("</del>", "</s>")
            .replace("<strike>", "<s>")
            .replace("</strike>", "</s>")
            .replace(" rel=\"noopener noreferrer\"", "")
    }
    left == right || canonical(left) == canonical(right)
}

fn block_markdown(item: Element<'_>) -> Option<String> {
    if item.opening.len() != item.name.len() + 2 && item.name != "img" {
        return None;
    }
    match item.name {
        "hr" => Some("---".to_owned()),
        "pre" => {
            let inner = item.inner.replace("<span>\n</span>", "\n");
            if inner.contains('<') {
                return None;
            }
            let text = decode_html_entities(&inner);
            let fence = "\x60".repeat((longest_ticks(&text) + 1).max(3));
            Some(format!("{fence}\n{text}\n{fence}"))
        }
        "p" | "h1" | "h2" | "h3" | "blockquote" => {
            let (prefix, inner) = match item.name {
                "h1" => ("# ", item.inner),
                "h2" => ("## ", item.inner),
                "h3" => ("### ", item.inner),
                "blockquote" => ("> ", item.inner.strip_prefix("<p>")?.strip_suffix("</p>")?),
                _ => ("", item.inner),
            };
            let mut inline = inline_markdown(inner, 0)?;
            if inline.contains('\n') {
                return None;
            }
            if item.name == "p" {
                if inline.trim().is_empty()
                    || inline.starts_with("    ")
                    || inline.starts_with('\t')
                    || inline.ends_with("  ")
                {
                    return None;
                }
                if heading(&inline).is_some() || inline.starts_with("---") {
                    inline.insert(0, '\\');
                } else if let Some((indent, tag, _)) = list_item(&inline) {
                    let marker_end = if tag == "ol" {
                        inline.find('.')?
                    } else {
                        indent
                    };
                    inline.insert(marker_end, '\\');
                }
            }
            Some(format!("{prefix}{inline}"))
        }
        "ol" | "ul" => {
            let mut lines = Vec::new();
            list_markdown(item, 0, &mut lines)?;
            Some(lines.join("\n"))
        }
        "table" => table_markdown(item),
        _ => None,
    }
}

/// One row of a canonical table: a bare `<tr>` holding bare cells of the
/// expected tag. Any other shape is left for the raw HTML fallback.
fn table_row<'a>(inner: &'a str, cell: &str) -> Option<Vec<&'a str>> {
    let mut cells = Vec::new();
    let mut rest = inner;
    while !rest.is_empty() {
        let item = element(rest)?;
        if item.name != cell || item.opening.len() != item.name.len() + 2 {
            return None;
        }
        cells.push(item.inner);
        rest = &rest[item.raw.len()..];
    }
    (!cells.is_empty()).then_some(cells)
}

/// A canonical table as a GFM pipe table, or None when the pipe form cannot
/// carry it and the block has to stay raw HTML.
fn table_markdown(item: Element<'_>) -> Option<String> {
    let head = element(item.inner)?;
    let header_row = element(head.inner)?;
    if head.name != "thead"
        || head.opening != "<thead>"
        || header_row.name != "tr"
        || header_row.opening != "<tr>"
        || header_row.raw.len() != head.inner.len()
    {
        return None;
    }
    let header = table_row(header_row.inner, "th")?;

    let mut rows = Vec::<Vec<&str>>::new();
    let mut rest = &item.inner[head.raw.len()..];
    if !rest.is_empty() {
        let body = element(rest)?;
        if body.name != "tbody" || body.opening != "<tbody>" || body.raw.len() != rest.len() {
            return None;
        }
        rest = body.inner;
        while !rest.is_empty() {
            let row = element(rest)?;
            if row.name != "tr" || row.opening != "<tr>" {
                return None;
            }
            let cells = table_row(row.inner, "td")?;
            if cells.len() != header.len() {
                return None;
            }
            rows.push(cells);
            rest = &rest[row.raw.len()..];
        }
    }

    let mut lines = vec![table_markdown_line(&header)?];
    lines.push(format!("| {} |", vec!["---"; header.len()].join(" | ")));
    for row in rows {
        lines.push(table_markdown_line(&row)?);
    }
    Some(lines.join("\n"))
}

fn table_markdown_line(cells: &[&str]) -> Option<String> {
    let cells = cells
        .iter()
        .map(|cell| table_cell_markdown(cell))
        .collect::<Option<Vec<_>>>()?;
    Some(format!("| {} |", cells.join(" | ")))
}

/// One cell as the inside of a GFM pipe cell. Pipes are escaped so the row
/// splitter sees them as text. A cell whose Markdown table parsing would trim
/// cannot round-trip, so it is refused instead.
fn table_cell_markdown(html: &str) -> Option<String> {
    let mut markdown = inline_markdown(html, 0)?;
    if markdown.contains('\n')
        || markdown.starts_with(|c: char| c.is_ascii_whitespace())
        || markdown.ends_with(|c: char| c.is_ascii_whitespace())
    {
        return None;
    }
    if markdown.contains('|') {
        markdown = markdown.replace('|', "\\|");
    }
    Some(markdown)
}

fn list_markdown(list: Element<'_>, depth: usize, lines: &mut Vec<String>) -> Option<()> {
    if depth > 6 || list.opening.len() != 4 {
        return None;
    }
    let mut rest = list.inner;
    while !rest.is_empty() {
        let item = element(rest)?;
        if item.name != "li" || item.opening != "<li>" {
            return None;
        }
        let nested = item
            .inner
            .find("<ul>")
            .into_iter()
            .chain(item.inner.find("<ol>"))
            .min();
        let (body, mut children) = item.inner.split_at(nested.unwrap_or(item.inner.len()));
        let inline = inline_markdown(body, 0)?;
        if inline.contains('\n') {
            return None;
        }
        let marker = if list.name == "ol" { "1. " } else { "- " };
        lines.push(format!("{}{marker}{inline}", "    ".repeat(depth)));
        while !children.is_empty() {
            let child = element(children)?;
            if !matches!(child.name, "ul" | "ol") {
                return None;
            }
            list_markdown(child, depth + 1, lines)?;
            children = &children[child.raw.len()..];
        }
        rest = &rest[item.raw.len()..];
    }
    Some(())
}

fn replace_image_sources(html: &str, mut replace: impl FnMut(&str) -> Option<String>) -> String {
    let mut rest = html;
    let mut output = String::new();
    while let Some(at) = rest.find("<img") {
        output.push_str(&rest[..at]);
        rest = &rest[at..];
        match tag(rest) {
            Some(("img", opening)) => {
                if let Some(value) = replace(opening) {
                    output.push_str(&value);
                } else {
                    output.push_str(opening);
                }
                rest = &rest[opening.len()..];
            }
            _ => {
                output.push('<');
                rest = &rest[1..];
            }
        }
    }
    output.push_str(rest);
    output
}

pub fn encode(id: Uuid, html: &str) -> Body {
    let mut body = Body {
        markdown: String::new(),
        images: BTreeMap::new(),
        image_attributes: ImageAttributes::new(),
    };
    let html = replace_image_sources(html, |opening| {
        let mut attrs: BTreeMap<_, _> = attributes(opening).collect();
        let source = attrs.remove("src")?;
        let (media, bytes) = source.strip_prefix("data:")?.split_once(";base64,")?;
        let extension = ["png", "jpg", "webp", "gif", "avif"]
            .into_iter()
            .find(|ext| mime(ext) == Some(media))?;
        let Ok(bytes) = STANDARD.decode(bytes) else {
            return Some("<img>".to_owned());
        };
        let name = format!("{id}-{:x}.{extension}", Sha256::digest(&bytes));
        body.images.entry(name.clone()).or_insert(bytes);
        let placement = IMAGE_ATTRIBUTES
            .iter()
            .filter_map(|&key| {
                attrs
                    .get(key)
                    .map(|value| (key.to_owned(), decode_html_entities(value).into_owned()))
            })
            .collect();
        body.image_attributes
            .entry(name.clone())
            .or_default()
            .push(placement);
        let alt = attrs.get("alt").copied().unwrap_or_default();
        Some(format!("<img alt=\"{alt}\" src=\"{name}\">"))
    });

    let mut rest = html.as_str();
    let mut blocks = Vec::new();
    while !rest.is_empty() {
        let Some(item) = element(rest) else {
            let at = rest
                .char_indices()
                .skip(1)
                .find_map(|(at, c)| (c == '<').then_some(at))
                .unwrap_or(rest.len());
            // Sanitized text is already entity-escaped.
            blocks.push(escape_markdown(&decode_html_entities(&rest[..at])));
            rest = &rest[at..];
            continue;
        };
        let markdown = if item.name == "img" {
            let attrs: BTreeMap<_, _> = attributes(item.opening).collect();
            attrs.get("src").and_then(|src| {
                let alt = decode_html_entities(attrs.get("alt").copied().unwrap_or_default());
                (!alt.contains('\n')).then(|| format!("![{}]({src})", escape_markdown(&alt)))
            })
        } else {
            block_markdown(item).filter(|markdown| same_html(&render(markdown), item.raw))
        };
        blocks.push(markdown.unwrap_or_else(|| item.raw.to_owned()));
        rest = &rest[item.raw.len()..];
    }

    body.markdown = blocks.join("\n\n");
    if !body.markdown.is_empty() {
        body.markdown.push('\n');
    }
    body
}

fn line(input: &str) -> (&str, &str) {
    input.split_once('\n').unwrap_or((input, ""))
}

fn heading(line: &str) -> Option<(usize, &str)> {
    let (marker, text) = line.split_once(' ')?;
    (matches!(marker, "#" | "##" | "###")).then_some((marker.len(), text))
}

fn fence(line: &str) -> Option<usize> {
    let ticks = line
        .trim_start()
        .bytes()
        .take_while(|&b| b == b'\x60')
        .count();
    (ticks >= 3).then_some(ticks)
}

fn list_item(line: &str) -> Option<(usize, &str, &str)> {
    let trimmed = line.trim_start_matches(' ');
    let indent = line.len() - trimmed.len();
    let (marker, text) = trimmed.split_once(' ')?;
    match marker {
        "-" | "+" | "*" => Some((indent, "ul", text)),
        _ if marker.strip_suffix('.').is_some_and(|n| {
            !n.is_empty() && n.len() <= 9 && n.bytes().all(|b| b.is_ascii_digit())
        }) =>
        {
            Some((indent, "ol", text))
        }
        _ => None,
    }
}

fn render_list<'a>(mut rest: &'a str, indent: usize, depth: usize, out: &mut String) -> &'a str {
    let mut current = "";
    while let Some((column, tag, text)) = list_item(line(rest).0) {
        if column < indent || (column > indent && current.is_empty()) {
            break;
        }
        if column > indent {
            // The nested list is consumed by its parent item below.
            break;
        }
        if tag != current {
            if !current.is_empty() {
                out.push_str(if current == "ol" { "</ol>" } else { "</ul>" });
            }
            out.push_str(if tag == "ol" { "<ol>" } else { "<ul>" });
            current = tag;
        }
        out.push_str("<li>");
        inline_html(text, 0, out);
        rest = line(rest).1;
        if let Some((next, _, _)) = list_item(line(rest).0) {
            if next > indent && depth < 6 {
                rest = render_list(rest, next, depth + 1, out);
            }
        }
        out.push_str("</li>");
    }
    out.push_str(if current == "ol" { "</ol>" } else { "</ul>" });
    rest
}

fn find_unescaped(text: &str, pattern: &str) -> Option<usize> {
    let mut escaped = false;
    for (at, c) in text.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if text[at..].starts_with(pattern) {
            return Some(at);
        }
    }
    None
}

// Find a matching closing delimiter. URLs can contain balanced parentheses.
fn matching_delimiter(input: &str, open: char, close: char) -> Option<usize> {
    let mut depth = 1;
    let mut escaped = false;
    for (at, c) in input.char_indices() {
        if escaped {
            escaped = false;
        } else if c == '\\' {
            escaped = true;
        } else if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some(at);
            }
        }
    }
    None
}

fn link(input: &str) -> Option<(&str, &str, &str)> {
    let after = input.strip_prefix('[')?;
    let close = matching_delimiter(after, '[', ']')?;
    let url = after[close + 1..].strip_prefix('(')?;
    let end = matching_delimiter(url, '(', ')')?;
    Some((&after[..close], &url[..end], &url[end + 1..]))
}

fn inline_html(mut text: &str, depth: usize, out: &mut String) {
    if depth == 16 {
        out.push_str(&encode_text(text));
        return;
    }
    while !text.is_empty() {
        let at = text
            .find(['\\', '*', '_', '~', '\x60', '[', '!', '<'])
            .unwrap_or(text.len());
        out.push_str(&encode_text(&text[..at]));
        text = &text[at..];
        let Some(first) = text.chars().next() else {
            break;
        };
        if let Some(escaped) = text.strip_prefix('\\').and_then(|rest| rest.chars().next()) {
            if escaped.is_ascii_punctuation() {
                out.push_str(&encode_text(&text[1..2]));
                text = &text[2..];
                continue;
            }
        }

        if first == '\x60' {
            let count = text.bytes().take_while(|&byte| byte == b'\x60').count();
            let marker = &text[..count];
            let after = &text[count..];
            if let Some(end) = after.match_indices(marker).find_map(|(at, _)| {
                (!after[..at].ends_with('\x60') && !after[at + count..].starts_with('\x60'))
                    .then_some(at)
            }) {
                let code = &after[..end];
                let code = code
                    .strip_prefix(' ')
                    .and_then(|s| s.strip_suffix(' '))
                    .filter(|s| !s.trim().is_empty())
                    .unwrap_or(code);
                out.push_str("<code>");
                out.push_str(&encode_text(code));
                out.push_str("</code>");
                text = &after[end + count..];
                continue;
            }
            out.push_str(marker);
            text = after;
            continue;
        }

        let delimiters = [
            ("***", "<b><i>", "</i></b>"),
            ("___", "<b><i>", "</i></b>"),
            ("**", "<b>", "</b>"),
            ("__", "<b>", "</b>"),
            ("*", "<i>", "</i>"),
            ("_", "<i>", "</i>"),
            ("~~", "<s>", "</s>"),
        ];
        if let Some((after, end, marker, open, close)) =
            delimiters.iter().find_map(|&(marker, open, close)| {
                let after = text.strip_prefix(marker)?;
                let end = find_unescaped(after, marker)?;
                (end > 0
                    && !after[..end].starts_with(char::is_whitespace)
                    && !after[..end].ends_with(char::is_whitespace))
                .then_some((after, end, marker, open, close))
            })
        {
            out.push_str(open);
            inline_html(&after[..end], depth + 1, out);
            out.push_str(close);
            text = &after[end + marker.len()..];
            continue;
        }

        if first == '[' || first == '!' {
            let image = first == '!';
            if let Some((label, target, rest)) = link(if image { &text[1..] } else { text }) {
                let target = target
                    .strip_prefix('<')
                    .and_then(|s| s.strip_suffix('>'))
                    .unwrap_or(target);
                if image {
                    out.push_str("<img alt=\"");
                    let mut alt = String::new();
                    let mut chars = label.chars().peekable();
                    while let Some(c) = chars.next() {
                        if c == '\\' && chars.peek().is_some_and(char::is_ascii_punctuation) {
                            alt.push(chars.next().expect("a character was just peeked"));
                        } else {
                            alt.push(c);
                        }
                    }
                    out.push_str(&encode_double_quoted_attribute(&alt));
                    out.push_str("\" src=\"");
                    out.push_str(&encode_double_quoted_attribute(target));
                    out.push_str("\">");
                } else {
                    out.push_str("<a href=\"");
                    out.push_str(&encode_double_quoted_attribute(target));
                    out.push_str("\">");
                    inline_html(label, depth + 1, out);
                    out.push_str("</a>");
                }
                text = rest;
                continue;
            }
        }

        if first == '<' {
            if let Some(item) = element(text).filter(|item| matches!(item.name, "br" | "u" | "img"))
            {
                out.push_str(item.raw);
                text = &text[item.raw.len()..];
                continue;
            }
        }

        out.push_str(&encode_text(&text[..first.len_utf8()]));
        text = &text[first.len_utf8()..];
    }
}

fn is_raw_block(name: &str) -> bool {
    matches!(
        name,
        "p" | "div"
            | "h1"
            | "h2"
            | "h3"
            | "h4"
            | "blockquote"
            | "ul"
            | "ol"
            | "pre"
            | "hr"
            | "img"
            | "table"
    )
}

fn raw_block(text: &str) -> Option<Element<'_>> {
    let block = element(text)?;
    let after = &text[block.raw.len()..];
    (is_raw_block(block.name) && (after.is_empty() || after.starts_with('\n'))).then_some(block)
}

/// A GFM table line split into its raw cells. A backslash escapes the next
/// character, so `\|` is cell text rather than a cell boundary. The empty cells
/// outside a leading or trailing pipe are dropped.
fn table_cells(line: &str) -> Vec<&str> {
    let mut cells = Vec::new();
    let mut start = 0;
    let mut escaped = false;
    for (index, character) in line.char_indices() {
        if escaped {
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '|' {
            cells.push(&line[start..index]);
            start = index + 1;
        }
    }
    cells.push(&line[start..]);
    if cells.len() > 1 && table_cell_text(cells[0]).is_empty() {
        cells.remove(0);
    }
    if cells.len() > 1 && table_cell_text(cells[cells.len() - 1]).is_empty() {
        cells.pop();
    }
    cells
}

fn table_cell_text(cell: &str) -> &str {
    cell.trim_matches([' ', '\t'])
}

fn has_unescaped_pipe(line: &str) -> bool {
    let mut escaped = false;
    for character in line.chars() {
        if escaped {
            escaped = false;
        } else if character == '\\' {
            escaped = true;
        } else if character == '|' {
            return true;
        }
    }
    false
}

fn is_table_delimiter(cell: &str) -> bool {
    let cell = table_cell_text(cell);
    let cell = cell.strip_prefix(':').unwrap_or(cell);
    let cell = cell.strip_suffix(':').unwrap_or(cell);
    !cell.is_empty() && cell.bytes().all(|byte| byte == b'-')
}

/// A cell's inline Markdown with only the table escape resolved: `\|` becomes
/// the literal pipe again, and every other backslash stays for `inline_html`.
fn table_cell_html(cell: &str) -> String {
    table_cell_text(cell).replace("\\|", "|")
}

fn render(markdown: &str) -> String {
    let normalized = markdown.replace("\r\n", "\n").replace('\r', "\n");
    let mut rest = normalized.trim_start_matches('\u{feff}');
    let mut out = String::new();
    while !rest.is_empty() {
        let (current, next) = line(rest);
        if current.trim().is_empty() {
            rest = next;
            continue;
        }
        if let Some(block) = raw_block(rest) {
            out.push_str(block.raw);
            rest = &rest[block.raw.len()..];
            continue;
        }
        if let Some(ticks) = fence(current) {
            let mut lines = Vec::new();
            rest = next;
            while !rest.is_empty() {
                let (code, after) = line(rest);
                rest = after;
                if fence(code).is_some_and(|length| length >= ticks)
                    && code.trim().bytes().all(|b| b == b'\x60')
                {
                    break;
                }
                lines.push(code);
            }
            let code = lines.join("\n");
            out.push_str("<pre>");
            if let Some(after) = code.strip_prefix('\n') {
                out.push_str("<span>\n</span>");
                out.push_str(&encode_text(after));
            } else {
                out.push_str(&encode_text(&code));
            }
            out.push_str("</pre>");
            continue;
        }
        // A GFM pipe table: the line above a delimiter row is its header. The
        // delimiter's cells decide the column count, and rows run until a blank
        // line or a line without a pipe.
        if has_unescaped_pipe(current) {
            let (delimiter, after_header) = line(next);
            let header = table_cells(current);
            let delimiters = table_cells(delimiter);
            if delimiters.len() == header.len()
                && delimiters.iter().all(|cell| is_table_delimiter(cell))
            {
                let mut rows = Vec::new();
                let mut rows_rest = after_header;
                while !rows_rest.is_empty() {
                    let (row, after) = line(rows_rest);
                    if row.trim().is_empty() || !has_unescaped_pipe(row) {
                        break;
                    }
                    rows.push(row);
                    rows_rest = after;
                }

                out.push_str("<table><thead><tr>");
                for cell in &header {
                    out.push_str("<th>");
                    inline_html(&table_cell_html(cell), 0, &mut out);
                    out.push_str("</th>");
                }
                out.push_str("</tr></thead><tbody>");
                for row in rows {
                    let cells = table_cells(row);
                    out.push_str("<tr>");
                    for column in 0..header.len() {
                        out.push_str("<td>");
                        if let Some(cell) = cells.get(column) {
                            inline_html(&table_cell_html(cell), 0, &mut out);
                        }
                        out.push_str("</td>");
                    }
                    out.push_str("</tr>");
                }
                out.push_str("</tbody></table>");
                rest = rows_rest;
                continue;
            }
        }
        if let Some((indent, _, _)) = list_item(current) {
            rest = render_list(rest, indent, 0, &mut out);
            continue;
        }
        if let Some((level, label)) = heading(current) {
            out.push_str(&format!("<h{level}>"));
            inline_html(label, 0, &mut out);
            out.push_str(&format!("</h{level}>"));
        } else if let Some(quote) = current
            .strip_prefix("> ")
            .or_else(|| (current == ">").then_some(""))
        {
            out.push_str("<blockquote><p>");
            inline_html(quote, 0, &mut out);
            out.push_str("</p></blockquote>");
        } else if matches!(current.trim(), "---" | "***" | "___") {
            out.push_str("<hr>");
        } else if link(current.strip_prefix('!').unwrap_or_default())
            .is_some_and(|(_, _, rest)| rest.is_empty())
        {
            inline_html(current, 0, &mut out);
        } else {
            out.push_str("<p>");
            inline_html(current, 0, &mut out);
            let mut continuation = next;
            while !continuation.is_empty() {
                let (following, after) = line(continuation);
                if following.trim().is_empty()
                    || heading(following).is_some()
                    || fence(following).is_some()
                    || list_item(following).is_some()
                    || following.starts_with(['>', '<', '!'])
                    || matches!(following.trim(), "---" | "***" | "___")
                {
                    break;
                }
                out.push(' ');
                inline_html(following, 0, &mut out);
                continuation = after;
            }
            out.push_str("</p>");
            rest = continuation;
            continue;
        }
        rest = next;
    }
    out
}

pub fn decode(
    markdown: &str,
    images: &BTreeMap<String, Vec<u8>>,
    placement: &ImageAttributes,
) -> String {
    let mut occurrences = BTreeMap::new();
    replace_image_sources(&render(markdown), |opening| {
        let attrs: BTreeMap<_, _> = attributes(opening).collect();
        let src = attrs.get("src").copied()?;
        let Some(bytes) = images.get(src) else {
            // Let the HTML sanitizer strip unsupported image sources.
            // A Markdown data URL is not an attachment.
            return Some("<img>".to_owned());
        };
        let media = attachment_content_type(src)?;
        let alt = attrs.get("alt").copied().unwrap_or_default();
        let mut output = format!("<img alt=\"{alt}\"");
        let occurrence = occurrences.entry(src.to_owned()).or_insert(0);
        if let Some(settings) = placement
            .get(src)
            .and_then(|entries| entries.get(*occurrence))
        {
            for &key in IMAGE_ATTRIBUTES {
                if let Some(value) = settings.get(key) {
                    output.push_str(&format!(
                        " {key}=\"{}\"",
                        encode_double_quoted_attribute(value)
                    ));
                }
            }
        }
        *occurrence += 1;
        output.push_str(&format!(
            " src=\"data:{media};base64,{}\">",
            STANDARD.encode(bytes)
        ));
        Some(output)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn decode_text(markdown: &str) -> String {
        decode(markdown, &BTreeMap::new(), &ImageAttributes::new())
    }

    #[test]
    fn canonical_tables_round_trip_through_markdown() {
        let html = concat!(
            "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead>",
            "<tbody><tr><td>Tea</td><td>2</td></tr>",
            "<tr><td>Coffee</td><td>1</td></tr></tbody></table>"
        );
        let body = encode(Uuid::nil(), html);

        assert_eq!(
            body.markdown,
            "| Name | Qty |\n| --- | --- |\n| Tea | 2 |\n| Coffee | 1 |\n"
        );
        assert_eq!(decode_text(&body.markdown), html);
    }

    #[test]
    fn a_table_with_an_empty_body_round_trips() {
        let html = "<table><thead><tr><th>a</th></tr></thead><tbody></tbody></table>";
        let body = encode(Uuid::nil(), html);

        assert_eq!(body.markdown, "| a |\n| --- |\n");
        assert_eq!(decode_text(&body.markdown), html);
    }

    #[test]
    fn table_cells_keep_their_inline_markup() {
        let html = concat!(
            "<table><thead><tr><th><b>Bold</b></th><th><code>a|b</code></th></tr></thead>",
            "<tbody><tr><td><a href=\"https://example.com\">link</a></td><td>plain | pipe</td></tr>",
            "<tr><td>first<br>second</td><td><u>underlined</u></td></tr></tbody></table>"
        );
        let body = encode(Uuid::nil(), html);

        assert_eq!(
            body.markdown,
            concat!(
                "| **Bold** | `a\\|b` |\n",
                "| --- | --- |\n",
                "| [link](https://example.com) | plain \\| pipe |\n",
                "| first<br>second | <u>underlined</u> |\n"
            )
        );
        assert_eq!(decode_text(&body.markdown), html);
    }

    #[test]
    fn tables_the_pipe_form_cannot_carry_stay_raw_html() {
        for html in [
            // Attributes are not part of the canonical shape.
            "<table class=\"layout\"><thead><tr><th>a</th></tr></thead><tbody></tbody></table>",
            // A header row of body cells.
            "<table><thead><tr><td>a</td></tr></thead><tbody></tbody></table>",
            // No tbody around the body rows.
            "<table><thead><tr><th>a</th></tr></thead><tr><td>b</td></tr></table>",
            // Rows are rectangular in a canonical table.
            "<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>b</td><td>c</td></tr></tbody></table>",
            // Cell Markdown would be trimmed by table parsing.
            "<table><thead><tr><th> spaced</th></tr></thead><tbody></tbody></table>",
        ] {
            let body = encode(Uuid::nil(), html);

            assert_eq!(body.markdown, format!("{html}\n"), "raw fallback: {html}");
            assert_eq!(decode_text(&body.markdown), html);
        }
    }

    #[test]
    fn hand_written_pipe_tables_decode_to_canonical_html() {
        assert_eq!(
            decode_text("| Name | Qty |\n| :--- | ---: |\n| Tea | 2 |\n"),
            concat!(
                "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead>",
                "<tbody><tr><td>Tea</td><td>2</td></tr></tbody></table>"
            )
        );
        assert_eq!(
            decode_text("Name | Qty\n--- | ---\nTea | 2\n"),
            concat!(
                "<table><thead><tr><th>Name</th><th>Qty</th></tr></thead>",
                "<tbody><tr><td>Tea</td><td>2</td></tr></tbody></table>"
            )
        );
    }

    #[test]
    fn pipe_table_rows_are_padded_and_capped_to_the_header() {
        assert_eq!(
            decode_text("| one |\n| --- |\n| short |\n| a | b | c |\n"),
            concat!(
                "<table><thead><tr><th>one</th></tr></thead>",
                "<tbody><tr><td>short</td></tr><tr><td>a</td></tr></tbody></table>"
            )
        );
        assert_eq!(
            decode_text("| one | two |\n| --- | --- |\n| short |\n\nafter | pipe\n"),
            concat!(
                "<table><thead><tr><th>one</th><th>two</th></tr></thead>",
                "<tbody><tr><td>short</td><td></td></tr></tbody></table>",
                "<p>after | pipe</p>"
            )
        );
    }

    #[test]
    fn escaped_pipes_are_text_inside_a_cell() {
        assert_eq!(
            decode_text("| a \\| b |\n| --- |\n"),
            "<table><thead><tr><th>a | b</th></tr></thead><tbody></tbody></table>"
        );
    }

    #[test]
    fn dividers_and_paragraph_pipes_are_not_tables() {
        assert_eq!(decode_text("---\n"), "<hr>");
        assert_eq!(decode_text("a | b\n"), "<p>a | b</p>");
        assert_eq!(decode_text("a | b\nc | d\n"), "<p>a | b c | d</p>");
        assert_eq!(decode_text("a | b\n---\n"), "<p>a | b</p><hr>");
    }
}
