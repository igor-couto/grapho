pub struct Asset {
    pub bytes: &'static [u8],
    pub content_type: &'static str,
}

pub const INDEX_HTML: &str = include_str!("../assets/index.html");
pub const EDITOR_HTML: &str = include_str!("../assets/editor.html");
pub const NOT_FOUND_HTML: &str = include_str!("../assets/not-found.html");

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
        "favicon.svg" => Asset {
            bytes: include_bytes!("../assets/favicon.svg"),
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
        _ => return None,
    };

    Some(asset)
}
