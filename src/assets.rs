pub struct Asset {
    pub bytes: &'static [u8],
    pub content_type: &'static str,
}

pub const INDEX_HTML: &str = include_str!("../assets/index.html");
pub const EDITOR_HTML: &str = include_str!("../assets/editor.html");
pub const LOGIN_HTML: &str = include_str!("../assets/login.html");
pub const NOT_FOUND_HTML: &str = include_str!("../assets/not-found.html");
pub const STORAGE_HTML: &str = include_str!("../assets/storage.html");
pub const SHORTCUTS_HTML: &str = include_str!("../assets/shortcuts.html");
pub const VERSION_HTML: &str = include_str!("../assets/version.html");

pub fn find(path: &str) -> Option<Asset> {
    let asset = match path {
        "app.css" => Asset {
            bytes: include_bytes!("../assets/app.css"),
            content_type: "text/css; charset=utf-8",
        },
        "theme.js" => Asset {
            bytes: include_bytes!("../assets/theme.js"),
            content_type: "text/javascript; charset=utf-8",
        },
        "home.js" => Asset {
            bytes: include_bytes!("../assets/home.js"),
            content_type: "text/javascript; charset=utf-8",
        },
        "editor.js" => Asset {
            bytes: include_bytes!("../assets/editor.js"),
            content_type: "text/javascript; charset=utf-8",
        },
        "login.js" => Asset {
            bytes: include_bytes!("../assets/login.js"),
            content_type: "text/javascript; charset=utf-8",
        },
        "menu.js" => script(include_bytes!("../assets/menu.js")),
        "quick-open.js" => script(include_bytes!("../assets/quick-open.js")),
        "storage.js" => script(include_bytes!("../assets/storage.js")),
        "version.js" => script(include_bytes!("../assets/version.js")),
        "doc/clipboard.js" => script(include_bytes!("../assets/doc/clipboard.js")),
        "doc/image.js" => script(include_bytes!("../assets/doc/image.js")),
        "doc/input.js" => script(include_bytes!("../assets/doc/input.js")),
        "doc/layout.js" => script(include_bytes!("../assets/doc/layout.js")),
        "doc/markdown.js" => script(include_bytes!("../assets/doc/markdown.js")),
        "doc/markdown-edit.js" => script(include_bytes!("../assets/doc/markdown-edit.js")),
        "doc/model.js" => script(include_bytes!("../assets/doc/model.js")),
        "doc/pdf.js" => script(include_bytes!("../assets/doc/pdf.js")),
        "doc/pdf-fonts.js" => script(include_bytes!("../assets/doc/pdf-fonts.js")),
        "doc/spellcheck.js" => script(include_bytes!("../assets/doc/spellcheck.js")),
        "doc/view.js" => script(include_bytes!("../assets/doc/view.js")),
        "spellcheck/worker.js" => script(include_bytes!("../assets/spellcheck/worker.js")),
        "spellcheck/typo.js" => script(include_bytes!("../assets/spellcheck/typo.js")),
        "spellcheck/en-US.aff" => plain_text(include_bytes!("../assets/spellcheck/en-US.aff")),
        "spellcheck/en-US.dic" => plain_text(include_bytes!("../assets/spellcheck/en-US.dic")),
        "spellcheck/en-US-LICENSE.txt" => {
            plain_text(include_bytes!("../assets/spellcheck/en-US-LICENSE.txt"))
        }
        "spellcheck/Typo-LICENSE.txt" => {
            plain_text(include_bytes!("../assets/spellcheck/Typo-LICENSE.txt"))
        }
        "favicon.svg" => Asset {
            bytes: include_bytes!("../assets/favicon.ico"),
            content_type: "image/svg+xml",
        },
        "fonts/inter-latin.woff2" => Asset {
            bytes: include_bytes!("../assets/fonts/inter-latin.woff2"),
            content_type: "font/woff2",
        },
        "fonts/literata-latin.woff2" => Asset {
            bytes: include_bytes!("../assets/fonts/literata-latin.woff2"),
            content_type: "font/woff2",
        },
        "fonts/literata-italic-latin.woff2" => Asset {
            bytes: include_bytes!("../assets/fonts/literata-italic-latin.woff2"),
            content_type: "font/woff2",
        },
        // Pretext, the text measurement and line layout engine. Vendored from
        // @chenglou/pretext 1.0.0 (MIT); see assets/pretext/LICENSE.txt.
        "pretext/analysis.js" => script(include_bytes!("../assets/pretext/analysis.js")),
        "pretext/gecko-line-breaks.js" => {
            script(include_bytes!("../assets/pretext/gecko-line-breaks.js"))
        }
        "pretext/graphemes.js" => script(include_bytes!("../assets/pretext/graphemes.js")),
        "pretext/han-kerning.js" => script(include_bytes!("../assets/pretext/han-kerning.js")),
        "pretext/layout.js" => script(include_bytes!("../assets/pretext/layout.js")),
        "pretext/line-break.js" => script(include_bytes!("../assets/pretext/line-break.js")),
        "pretext/line-breaks.js" => script(include_bytes!("../assets/pretext/line-breaks.js")),
        "pretext/line-text.js" => script(include_bytes!("../assets/pretext/line-text.js")),
        "pretext/measurement.js" => script(include_bytes!("../assets/pretext/measurement.js")),
        "pretext/prepare.js" => script(include_bytes!("../assets/pretext/prepare.js")),
        "pretext/rich-inline.js" => script(include_bytes!("../assets/pretext/rich-inline.js")),
        "pretext/generated/engine-break-data.js" => script(include_bytes!(
            "../assets/pretext/generated/engine-break-data.js"
        )),
        "pretext/generated/webkit-generic-families.js" => script(include_bytes!(
            "../assets/pretext/generated/webkit-generic-families.js"
        )),
        _ => return None,
    };

    Some(asset)
}

fn script(bytes: &'static [u8]) -> Asset {
    Asset {
        bytes,
        content_type: "text/javascript; charset=utf-8",
    }
}

fn plain_text(bytes: &'static [u8]) -> Asset {
    Asset {
        bytes,
        content_type: "text/plain; charset=utf-8",
    }
}
