use std::collections::HashSet;
use std::io;

use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

use super::filenames::{DRAWING_SUFFIX, MARKDOWN_SUFFIX};
use super::{is_embedded_image, StoreError};

const PENCIL_VERSION: u32 = 1;
const SQUARE_SCENE_VERSION: u32 = 2;
const EXPANDED_SCENE_VERSION: u32 = 3;
const SHAPE_STYLE_VERSION: u32 = 4;
const ARROW_STYLE_VERSION: u32 = 5;
const LINE_STYLE_VERSION: u32 = 6;
const PENCIL_STYLE_VERSION: u32 = 7;
const TEXT_STYLE_VERSION: u32 = 8;
const IMAGE_VERSION: u32 = 9;
const SIGNED_COORDINATE_VERSION: u32 = 10;
const BACKGROUND_VERSION: u32 = 11;
const BACKGROUND_COLOR_VERSION: u32 = 12;
const SCENE_VERSION: u32 = BACKGROUND_COLOR_VERSION;
const LEGACY_FENCE: &str = "```grapho-drawing-v1";
const SQUARE_SIZE: i32 = 1000;
const MAX_COORDINATE: i32 = 65_535;

type Point = [i32; 2];
type PencilStrokes = Vec<Vec<Point>>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(super) enum DrawingBody {
    Json(String),
    LegacyMarkdown(String),
}

impl DrawingBody {
    pub(super) fn suffix(&self) -> &'static str {
        match self {
            Self::Json(_) => DRAWING_SUFFIX,
            Self::LegacyMarkdown(_) => MARKDOWN_SUFFIX,
        }
    }

    pub(super) fn source(&self) -> &str {
        match self {
            Self::Json(source) | Self::LegacyMarkdown(source) => source,
        }
    }

    pub(super) fn from_scene(scene: &DrawingScene) -> io::Result<Self> {
        let mut source = serde_json::to_string(scene)?;
        source.push('\n');
        Ok(Self::Json(source))
    }

    pub(super) fn scene(&self, document: Uuid) -> Option<DrawingScene> {
        let scene = match self {
            Self::Json(source) => serde_json::from_str(source).ok()?,
            Self::LegacyMarkdown(source) => {
                let json = source
                    .trim()
                    .strip_prefix(LEGACY_FENCE)?
                    .strip_suffix("```")?;
                let strokes: PencilStrokes = serde_json::from_str(json).ok()?;
                // Opening a legacy file is read-only. Derive the same element
                // IDs on every open until the first save writes them to disk.
                let elements = strokes
                    .into_iter()
                    .enumerate()
                    .map(|(index, points)| {
                        let id = Uuid::from_u128(document.as_u128() ^ (index as u128 + 1));
                        DrawingElement::Pencil {
                            id,
                            points,
                            style: None,
                            pressures: Vec::new(),
                        }
                    })
                    .collect();
                DrawingScene {
                    version: PENCIL_VERSION,
                    elements,
                    background: DrawingBackground::default(),
                    background_color: None,
                    pattern_color: None,
                }
            }
        };
        scene.is_valid().then_some(scene)
    }

    pub(super) fn into_native(self, document: Uuid) -> io::Result<Self> {
        if matches!(self, Self::LegacyMarkdown(_)) {
            if let Some(scene) = self.scene(document) {
                return Self::from_scene(&scene);
            }
        }
        Ok(self)
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct DrawingScene {
    version: u32,
    elements: Vec<DrawingElement>,
    #[serde(default, skip_serializing_if = "DrawingBackground::is_default")]
    background: DrawingBackground,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    background_color: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pattern_color: Option<String>,
}

#[derive(Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum DrawingBackground {
    #[default]
    Dots,
    Grid,
    Ruled,
    Plain,
}

impl DrawingBackground {
    fn is_default(&self) -> bool {
        *self == Self::default()
    }
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(tag = "type", rename_all = "snake_case", deny_unknown_fields)]
enum DrawingElement {
    Pencil {
        id: Uuid,
        points: Vec<Point>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<ShapeStyle>,
        #[serde(default, skip_serializing_if = "Vec::is_empty")]
        pressures: Vec<u8>,
    },
    Rectangle(Endpoints),
    Diamond(Endpoints),
    Ellipse(Endpoints),
    Arrow(Endpoints),
    Line(Endpoints),
    Text {
        id: Uuid,
        at: Point,
        text: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        style: Option<TextStyle>,
    },
    Image {
        id: Uuid,
        start: Point,
        end: Point,
        src: String,
        #[serde(default, skip_serializing_if = "String::is_empty")]
        alt: String,
    },
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Endpoints {
    id: Uuid,
    start: Point,
    end: Point,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    style: Option<ShapeStyle>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    vertices: Vec<Point>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    closed: bool,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ShapeStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    stroke: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    fill: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    width: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pattern: Option<StrokePattern>,
    #[serde(skip_serializing_if = "Option::is_none")]
    roughness: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    edges: Option<ShapeEdges>,
    #[serde(skip_serializing_if = "Option::is_none")]
    opacity: Option<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    route: Option<ArrowRoute>,
    #[serde(skip_serializing_if = "Option::is_none")]
    start_head: Option<Arrowhead>,
    #[serde(skip_serializing_if = "Option::is_none")]
    end_head: Option<Arrowhead>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pressure: Option<PencilPressure>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct TextStyle {
    #[serde(skip_serializing_if = "Option::is_none")]
    stroke: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    font_family: Option<TextFamily>,
    #[serde(skip_serializing_if = "Option::is_none")]
    font_size: Option<TextSize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text_align: Option<TextAlignment>,
    #[serde(skip_serializing_if = "Option::is_none")]
    opacity: Option<u8>,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum TextFamily {
    HandDrawn,
    Normal,
    Code,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum TextSize {
    S,
    M,
    L,
    Xl,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum TextAlignment {
    Left,
    Center,
    Right,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum StrokePattern {
    Solid,
    Dashed,
    Dotted,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ShapeEdges {
    Sharp,
    Rounded,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum ArrowRoute {
    Straight,
    Curved,
    Elbow,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum Arrowhead {
    None,
    Arrow,
    Triangle,
    Bar,
}

#[derive(Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
enum PencilPressure {
    Uniform,
    Variable,
}

fn is_hex_color(color: &str) -> bool {
    color
        .strip_prefix('#')
        .is_some_and(|hex| hex.len() == 6 && hex.bytes().all(|digit| digit.is_ascii_hexdigit()))
}

impl ShapeStyle {
    fn is_valid_for(&self, element: &DrawingElement, version: u32) -> bool {
        if version < SHAPE_STYLE_VERSION
            || !self.stroke.as_deref().is_none_or(is_hex_color)
            || !self.fill.as_deref().is_none_or(is_hex_color)
            || !self.width.is_none_or(|width| (1..=3).contains(&width))
            || self.roughness.is_some_and(|roughness| roughness > 2)
            || self.opacity.is_some_and(|opacity| opacity > 100)
        {
            return false;
        }
        if matches!(element, DrawingElement::Pencil { .. }) {
            return version >= PENCIL_STYLE_VERSION
                && self.pattern.is_none()
                && self.roughness.is_none()
                && self.edges.is_none()
                && self.route.is_none()
                && self.start_head.is_none()
                && self.end_head.is_none();
        }
        if self.pressure.is_some() {
            return false;
        }
        if matches!(element, DrawingElement::Arrow(_)) {
            return version >= ARROW_STYLE_VERSION && self.fill.is_none() && self.edges.is_none();
        }
        self.route.is_none()
            && self.start_head.is_none()
            && self.end_head.is_none()
            && match element {
                DrawingElement::Rectangle(_) | DrawingElement::Diamond(_) => true,
                DrawingElement::Ellipse(_) => self.edges.is_none(),
                DrawingElement::Line(_) => version >= LINE_STYLE_VERSION,
                _ => false,
            }
    }
}

impl DrawingScene {
    pub(super) fn is_empty(&self) -> bool {
        self.elements.is_empty()
            && self.background.is_default()
            && self.background_color.is_none()
            && self.pattern_color.is_none()
    }

    pub(super) fn is_valid(&self) -> bool {
        self.is_valid_for(self.version)
    }

    fn is_valid_for(&self, version: u32) -> bool {
        if version < BACKGROUND_VERSION && !self.background.is_default() {
            return false;
        }
        let colors = [
            self.background_color.as_deref(),
            self.pattern_color.as_deref(),
        ];
        if colors
            .into_iter()
            .flatten()
            .any(|color| version < BACKGROUND_COLOR_VERSION || !is_hex_color(color))
        {
            return false;
        }
        let limit = match version {
            PENCIL_VERSION | SQUARE_SCENE_VERSION => SQUARE_SIZE,
            EXPANDED_SCENE_VERSION..=SCENE_VERSION => MAX_COORDINATE,
            _ => return false,
        };
        let lower = if version >= SIGNED_COORDINATE_VERSION {
            -limit
        } else {
            0
        };
        let on_canvas =
            |[x, y]: Point| (lower..=limit).contains(&x) && (lower..=limit).contains(&y);
        let mut ids = HashSet::new();
        self.elements.iter().all(|element| {
            let (id, valid) = match element {
                DrawingElement::Pencil {
                    id,
                    points,
                    style,
                    pressures,
                } => (
                    id,
                    !points.is_empty()
                        && points.iter().copied().all(on_canvas)
                        && (pressures.is_empty()
                            || (version >= PENCIL_STYLE_VERSION
                                && pressures.len() == points.len()))
                        && style
                            .as_ref()
                            .is_none_or(|style| style.is_valid_for(element, version)),
                ),
                DrawingElement::Rectangle(shape)
                | DrawingElement::Diamond(shape)
                | DrawingElement::Ellipse(shape)
                | DrawingElement::Arrow(shape)
                | DrawingElement::Line(shape) => (
                    &shape.id,
                    version >= SQUARE_SCENE_VERSION
                        && on_canvas(shape.start)
                        && on_canvas(shape.end)
                        && (!shape.closed && shape.vertices.is_empty()
                            || (version >= LINE_STYLE_VERSION
                                && matches!(element, DrawingElement::Line(_))
                                && (!shape.closed || !shape.vertices.is_empty())
                                && shape.vertices.iter().copied().all(on_canvas)))
                        && shape
                            .style
                            .as_ref()
                            .is_none_or(|style| style.is_valid_for(element, version)),
                ),
                DrawingElement::Text {
                    id,
                    at,
                    text,
                    style,
                } => (
                    id,
                    version >= SQUARE_SCENE_VERSION
                        && on_canvas(*at)
                        && !text.is_empty()
                        && style.as_ref().is_none_or(|style| {
                            version >= TEXT_STYLE_VERSION
                                && style.stroke.as_deref().is_none_or(is_hex_color)
                                && style.opacity.is_none_or(|opacity| opacity <= 100)
                        }),
                ),
                DrawingElement::Image {
                    id,
                    start,
                    end,
                    src,
                    alt,
                } => (
                    id,
                    version >= IMAGE_VERSION
                        && on_canvas(*start)
                        && on_canvas(*end)
                        && start[0] < end[0]
                        && start[1] < end[1]
                        && alt.chars().count() <= 160
                        && is_embedded_image(src)
                        && src
                            .split_once(',')
                            .is_some_and(|(_, data)| STANDARD.decode(data).is_ok()),
                ),
            };
            valid && ids.insert(id)
        })
    }
}

/// The stroke arrays remain readable and writable for a drawing tab left open
/// across an upgrade. The new editor exchanges the same scene as the JSON file.
#[derive(Deserialize, Serialize)]
#[serde(untagged, deny_unknown_fields)]
pub(crate) enum DrawingData {
    Scene(DrawingScene),
    Legacy { strokes: PencilStrokes },
}

impl DrawingData {
    pub(super) fn for_client(
        mut scene: DrawingScene,
        version: Option<u32>,
    ) -> Result<Self, StoreError> {
        match version {
            Some(version @ PENCIL_VERSION..=SCENE_VERSION) => {
                if version < scene.version && !scene.is_valid_for(version) {
                    return Err(StoreError::DrawingClientTooOld);
                }
                scene.version = version;
                Ok(Self::Scene(scene))
            }
            None => {
                if !scene.is_valid_for(PENCIL_VERSION) {
                    return Err(StoreError::DrawingClientTooOld);
                }
                let strokes = scene
                    .elements
                    .into_iter()
                    .map(|element| match element {
                        DrawingElement::Pencil { points, .. } => Ok(points),
                        _ => Err(StoreError::DrawingClientTooOld),
                    })
                    .collect::<Result<_, _>>()?;
                Ok(Self::Legacy { strokes })
            }
            Some(_) => Err(StoreError::InvalidDrawing),
        }
    }

    pub(super) fn into_scene(
        self,
        previous: Option<DrawingScene>,
    ) -> Result<DrawingScene, StoreError> {
        let version = match &self {
            Self::Scene(scene) => scene.version,
            Self::Legacy { .. } => PENCIL_VERSION,
        };
        // An open tab can submit a snapshot from before the server was updated.
        if (PENCIL_VERSION..SCENE_VERSION).contains(&version)
            && previous
                .as_ref()
                .is_some_and(|scene| scene.version > version && !scene.is_valid_for(version))
        {
            return Err(StoreError::DrawingClientTooOld);
        }
        match self {
            Self::Scene(scene) => Ok(scene),
            Self::Legacy { strokes } => {
                let elements = strokes
                    .into_iter()
                    .enumerate()
                    .map(|(index, points)| {
                        let id = match previous
                            .as_ref()
                            .and_then(|scene| scene.elements.get(index))
                        {
                            Some(DrawingElement::Pencil {
                                id,
                                points: old_points,
                                ..
                            }) if *old_points == points => *id,
                            _ => Uuid::new_v4(),
                        };
                        DrawingElement::Pencil {
                            id,
                            points,
                            style: None,
                            pressures: Vec::new(),
                        }
                    })
                    .collect();
                Ok(DrawingScene {
                    version: PENCIL_VERSION,
                    elements,
                    background: DrawingBackground::default(),
                    background_color: None,
                    pattern_color: None,
                })
            }
        }
    }
}
