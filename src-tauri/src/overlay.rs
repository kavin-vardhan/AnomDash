use ab_glyph::{point, Font, FontVec, GlyphId, PxScale, ScaleFont};
use image::codecs::png::{CompressionType, FilterType, PngEncoder};
use image::{ExtendedColorType, ImageEncoder, ImageReader, RgbImage};
use rayon::prelude::*;
use serde_json::{Map, Value};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::io::{BufWriter, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Mutex;

#[derive(Debug, Clone, serde::Serialize)]
pub struct OverlayReport {
    pub total_frames: u32,
    pub frames_with_boxes: u32,
    pub images_written: u32,
    pub red_boxes: u32,
    pub amber_boxes: u32,
    pub by_category: BTreeMap<String, u32>,
}

pub(crate) type Rgb = [u8; 3];

const RED: Rgb = [255, 40, 40];
const AMBER: Rgb = [255, 176, 0];
const GREY: Rgb = [140, 140, 140];
const WHITE: Rgb = [255, 255, 255];
const BLACK: Rgb = [0, 0, 0];

const CAT_SHIPPED: &str = "SHIPPED";
const CAT_OUTSIDE: &str = "OUTSIDE-SUBSET";
const CAT_NONMANIF: &str = "NON-MANIFESTED";
const CAT_VETOED: &str = "VETOED";
const CAT_UNMATCHED: &str = "UNMATCHED";
const AMBER_CATEGORIES: [&str; 4] = [CAT_OUTSIDE, CAT_NONMANIF, CAT_VETOED, CAT_UNMATCHED];

const BOX_LINE: i32 = 3;
const FONT_EM_PX: f32 = 16.0;
const TAG_LIFT: f64 = 20.0;
const TAG_INSET: f64 = 2.0;
const TAG_GAP: f32 = 5.0;
const ROW_H: i32 = 20;
const PLATE_PAD: i32 = 2;
const PLATE_KEEP: u32 = 92;
const LEGEND_PAD: i32 = 6;
const LEGEND_SWATCH: i32 = 14;
const LEGEND_TEXT_X: i32 = LEGEND_PAD + LEGEND_SWATCH + 8;
const LEGEND_MIN_W: i32 = 360;
const LEGEND_RED: &str = "RED  in annotation.json - a shipped label";
const LEGEND_AMBER: &str = "AMBER  candidate only - not in annotation.json";

const NO_LABELS: &str = "This capture has no labels.jsonl, so labelled previews can't be drawn. \
The game writes that file during capture unless the \"delivery labels\" setting \
(IAI.Capture.DeliveryLabels) was switched off.";

struct Event {
    kind: Value,
    names: Vec<Value>,
    idx: HashSet<i64>,
    manifested: bool,
}

struct Annotation {
    events: Option<Vec<Event>>,
    assets: HashMap<String, String>,
}

pub(crate) struct PlannedBox {
    pub(crate) rect: [i32; 4],
    pub(crate) colour: Rgb,
    pub(crate) category: &'static str,
    pub(crate) tag_at: (f64, f64),
    pub(crate) primary: String,
    pub(crate) dimmed: String,
}

pub(crate) struct PlannedFrame {
    pub(crate) image: PathBuf,
    pub(crate) output_name: String,
    pub(crate) boxes: Vec<PlannedBox>,
}

pub(crate) struct SessionPlan {
    pub(crate) total_frames: usize,
    pub(crate) counts: BTreeMap<&'static str, u32>,
    pub(crate) frames: Vec<PlannedFrame>,
}

pub fn render_previews(
    session_dir: &Path,
    out_dir: &Path,
    progress: &(dyn Fn(u32, u32) + Sync),
    cancel: &AtomicBool,
) -> Result<OverlayReport, String> {
    let plan = plan_session(session_dir)?;
    fs::create_dir_all(out_dir).map_err(|e| {
        format!(
            "Could not create the preview folder {}: {}. Check that the disk has free space and that the folder is not read-only.",
            out_dir.display(),
            e
        )
    })?;

    let total = to_u32(plan.total_frames);
    let kit = TextKit::load();
    let legend = Legend::build(kit.as_ref());
    let groups = group_by_output(&plan.frames);

    let done = Mutex::new(total.saturating_sub(to_u32(plan.frames.len())));
    if let Ok(d) = done.lock() {
        progress(*d, total);
    }
    if cancel.load(Ordering::Relaxed) {
        return Err("cancelled".to_string());
    }

    let written = AtomicU32::new(0);
    groups.par_iter().try_for_each(|group| -> Result<(), String> {
        for &i in group {
            if cancel.load(Ordering::Relaxed) {
                return Err("cancelled".to_string());
            }
            let frame = &plan.frames[i];
            if frame.image.is_file() {
                if let Some(img) = render_frame(frame, kit.as_ref(), &legend) {
                    write_png(&out_dir.join(&frame.output_name), &img)?;
                    written.fetch_add(1, Ordering::Relaxed);
                }
            }
            if let Ok(mut d) = done.lock() {
                *d += 1;
                progress(*d, total);
            }
        }
        Ok(())
    })?;

    let red = plan.counts.get(CAT_SHIPPED).copied().unwrap_or(0);
    let mut by_category = BTreeMap::new();
    by_category.insert(CAT_SHIPPED.to_string(), red);
    let mut amber = 0;
    for cat in AMBER_CATEGORIES {
        let n = plan.counts.get(cat).copied().unwrap_or(0);
        amber += n;
        if n > 0 {
            by_category.insert(cat.to_string(), n);
        }
    }

    Ok(OverlayReport {
        total_frames: total,
        frames_with_boxes: to_u32(plan.frames.len()),
        images_written: written.load(Ordering::Relaxed),
        red_boxes: red,
        amber_boxes: amber,
        by_category,
    })
}

pub(crate) fn plan_session(session_dir: &Path) -> Result<SessionPlan, String> {
    if !session_dir.is_dir() {
        return Err(format!(
            "The capture folder {} could not be found, so labelled previews can't be drawn.",
            session_dir.display()
        ));
    }
    let sidecar = session_dir.join("labels.jsonl");
    if !sidecar.is_file() {
        return Err(NO_LABELS.to_string());
    }

    let Annotation { events, assets } = load_annotation(session_dir)?;
    let vetoed = any_vetoed(session_dir)?;
    let rows = load_rows(&sidecar)?;

    let mut counts: BTreeMap<&'static str, u32> = BTreeMap::new();
    counts.insert(CAT_SHIPPED, 0);
    for cat in AMBER_CATEGORIES {
        counts.insert(cat, 0);
    }

    let empty = Value::String(String::new());
    let mut frames = Vec::new();
    for rec in &rows {
        let frame_key = match rec.get("session_index") {
            Some(v) => v,
            None => rec.get("frame_index").unwrap_or(&Value::Null),
        };
        let img_name = match rec.get("image") {
            Some(Value::String(s)) => s.as_str(),
            _ => "",
        };

        let mut boxes = Vec::new();
        for a in list_of(rec.get("anomalies")) {
            let a = match a {
                Value::Object(m) => m,
                _ => continue,
            };
            let engine_id = a.get("id").unwrap_or(&empty);
            let target = a.get("target_name").unwrap_or(&empty);
            let (cat, mut colour) = classify(frame_key, engine_id, target, events.as_deref(), vetoed);
            if let Some(n) = counts.get_mut(cat) {
                *n += 1;
            }

            let bbox = match a.get("bbox_px") {
                None => Some([0.0; 4]),
                Some(v) => four_numbers(v),
            };
            if !a.get("bbox_valid").map(truthy).unwrap_or(false) {
                colour = GREY;
            }
            let [x, y, w, h] = match bbox {
                Some(b) => b,
                None => continue,
            };
            if !(w > 0.0 && h > 0.0) {
                continue;
            }

            let (primary, dimmed) = label_for(engine_id, target, &assets);
            boxes.push(PlannedBox {
                rect: [x as i32, y as i32, (x + w) as i32, (y + h) as i32],
                colour,
                category: cat,
                tag_at: (x + TAG_INSET, (y - TAG_LIFT).max(0.0)),
                primary,
                dimmed,
            });
        }

        if boxes.is_empty() {
            continue;
        }
        frames.push(PlannedFrame {
            image: session_dir.join(img_name),
            output_name: format!("{}_annotated.png", py_stem(img_name)),
            boxes,
        });
    }

    Ok(SessionPlan {
        total_frames: rows.len(),
        counts,
        frames,
    })
}

fn classify(
    frame_key: &Value,
    engine_id: &Value,
    target: &Value,
    events: Option<&[Event]>,
    any_vetoed: bool,
) -> (&'static str, Rgb) {
    let events = match events {
        None => return (CAT_SHIPPED, RED),
        Some(e) => e,
    };
    let ctype = match engine_id {
        Value::String(s) if s == "blinking" => Value::String("blink".to_string()),
        other => other.clone(),
    };
    let cands: Vec<&Event> = events
        .iter()
        .filter(|e| py_eq(&e.kind, &ctype) && e.names.iter().any(|n| py_eq(n, target)))
        .collect();

    if let Some(k) = integral(frame_key) {
        if cands.iter().any(|e| e.idx.contains(&k)) {
            return (CAT_SHIPPED, RED);
        }
    }
    if cands.is_empty() {
        return (if any_vetoed { CAT_VETOED } else { CAT_UNMATCHED }, AMBER);
    }
    if cands.iter().any(|e| !e.manifested) {
        return (CAT_NONMANIF, AMBER);
    }
    (CAT_OUTSIDE, AMBER)
}

fn label_for(engine_id: &Value, actor: &Value, assets: &HashMap<String, String>) -> (String, String) {
    let asset = match actor {
        Value::String(s) => assets.get(s).map(String::as_str).unwrap_or(""),
        _ => "",
    };
    if asset.is_empty() {
        (format!("{} {}", py_str(engine_id), py_str(actor)), String::new())
    } else {
        (format!("{} {}", py_str(engine_id), asset), format!("({})", py_str(actor)))
    }
}

fn load_annotation(dir: &Path) -> Result<Annotation, String> {
    let path = dir.join("annotation.json");
    let mut assets = HashMap::new();
    if !path.is_file() {
        return Ok(Annotation { events: None, assets });
    }
    let ann = read_json(&path).map_err(|e| {
        format!(
            "This capture's annotation.json could not be read, so the boxes can't be sorted into red (shipped) and amber (candidate). \
The file may be damaged or still being written. Details: {e}"
        )
    })?;
    let root = match &ann {
        Value::Object(m) => m,
        _ => {
            return Err("This capture's annotation.json is not in the expected format, so the boxes can't be sorted into red (shipped) and amber (candidate).".to_string())
        }
    };

    let mut events = Vec::new();
    for ev in list_of(root.get("anomalies")) {
        let ev = match ev {
            Value::Object(m) => m,
            _ => continue,
        };
        let nodes = obj_of(ev.get("affected_objects"))
            .map(|o| list_of(o.get("nodes")))
            .unwrap_or(&[]);
        let mut names = Vec::new();
        for n in nodes {
            let n = match n {
                Value::Object(m) => m,
                _ => continue,
            };
            if let (Some(Value::String(actor)), Some(Value::String(asset))) = (n.get("name"), n.get("asset_name")) {
                if !actor.is_empty() && !asset.is_empty() && !assets.contains_key(actor) {
                    assets.insert(actor.clone(), asset.clone());
                }
            }
            names.push(n.get("name").cloned().unwrap_or_else(|| Value::String(String::new())));
        }
        let idx = obj_of(ev.get("affected_frames"))
            .map(|af| list_of(af.get("frame_indices")))
            .unwrap_or(&[])
            .iter()
            .filter_map(integral)
            .collect();
        events.push(Event {
            kind: ev.get("anomaly_type").cloned().unwrap_or_else(|| Value::String(String::new())),
            names,
            idx,
            manifested: ev.get("manifested").map(truthy).unwrap_or(true),
        });
    }
    Ok(Annotation {
        events: Some(events),
        assets,
    })
}

fn any_vetoed(dir: &Path) -> Result<bool, String> {
    let path = dir.join("run_summary.json");
    if !path.is_file() {
        return Ok(false);
    }
    let rs = read_json(&path).map_err(|e| {
        format!(
            "This capture's run_summary.json could not be read, so dropped (vetoed) labels can't be told apart from unexpected ones. \
The file may be damaged or still being written. Details: {e}"
        )
    })?;
    let v = match &rs {
        Value::Object(m) => m.get("vetoed_events"),
        _ => {
            return Err("This capture's run_summary.json is not in the expected format, so dropped (vetoed) labels can't be told apart from unexpected ones.".to_string())
        }
    };
    Ok(match v {
        None => false,
        Some(Value::Number(n)) => n.as_f64().map(|f| f.trunc() > 0.0).unwrap_or(false),
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => s.trim().parse::<i64>().map(|i| i > 0).unwrap_or(false),
        Some(_) => false,
    })
}

fn load_rows(path: &Path) -> Result<Vec<Map<String, Value>>, String> {
    let bytes = fs::read(path).map_err(|e| format!("This capture's labels.jsonl could not be opened: {e}"))?;
    let text = String::from_utf8(bytes).map_err(|_| {
        "This capture's labels.jsonl is not readable text, so labelled previews can't be drawn. The file may be damaged.".to_string()
    })?;
    let body = text.strip_prefix('\u{feff}').unwrap_or(&text);
    let mut rows = Vec::new();
    for (n, line) in body.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Value>(line) {
            Ok(Value::Object(m)) => rows.push(m),
            Ok(_) => {
                return Err(format!(
                    "Line {} of this capture's labels.jsonl is not a frame record, so labelled previews can't be drawn. The file may be damaged.",
                    n + 1
                ))
            }
            Err(e) => {
                return Err(format!(
                    "Line {} of this capture's labels.jsonl is damaged, so labelled previews can't be drawn. Details: {e}",
                    n + 1
                ))
            }
        }
    }
    Ok(rows)
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let body = text.strip_prefix('\u{feff}').unwrap_or(&text);
    serde_json::from_str(body).map_err(|e| e.to_string())
}

fn list_of(v: Option<&Value>) -> &[Value] {
    match v {
        Some(Value::Array(a)) => a,
        _ => &[],
    }
}

fn obj_of(v: Option<&Value>) -> Option<&Map<String, Value>> {
    match v {
        Some(Value::Object(m)) => Some(m),
        _ => None,
    }
}

fn truthy(v: &Value) -> bool {
    match v {
        Value::Null => false,
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Value::String(s) => !s.is_empty(),
        Value::Array(a) => !a.is_empty(),
        Value::Object(m) => !m.is_empty(),
    }
}

fn py_num(v: &Value) -> Option<f64> {
    match v {
        Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
        Value::Number(n) => n.as_f64(),
        _ => None,
    }
}

fn py_eq(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Null, Value::Null) => true,
        _ => match (py_num(a), py_num(b)) {
            (Some(x), Some(y)) => x == y,
            (None, None) => a == b,
            _ => false,
        },
    }
}

fn py_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "None".to_string(),
        Value::Bool(true) => "True".to_string(),
        Value::Bool(false) => "False".to_string(),
        other => other.to_string(),
    }
}

fn integral(v: &Value) -> Option<i64> {
    match v {
        Value::Bool(b) => Some(i64::from(*b)),
        Value::Number(n) => n.as_i64().or_else(|| {
            n.as_f64()
                .filter(|f| f.is_finite() && f.fract() == 0.0)
                .map(|f| f as i64)
        }),
        _ => None,
    }
}

fn four_numbers(v: &Value) -> Option<[f64; 4]> {
    match v {
        Value::Array(a) if a.len() == 4 => Some([py_num(&a[0])?, py_num(&a[1])?, py_num(&a[2])?, py_num(&a[3])?]),
        _ => None,
    }
}

fn py_stem(name: &str) -> &str {
    let base = match name.rfind(['/', '\\']) {
        Some(i) => &name[i + 1..],
        None => name,
    };
    match base.rfind('.') {
        Some(dot) if base[..dot].chars().any(|c| c != '.') => &base[..dot],
        _ => base,
    }
}

fn to_u32(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

fn group_by_output(frames: &[PlannedFrame]) -> Vec<Vec<usize>> {
    let mut slot: HashMap<&str, usize> = HashMap::new();
    let mut groups: Vec<Vec<usize>> = Vec::new();
    for (i, f) in frames.iter().enumerate() {
        match slot.get(f.output_name.as_str()) {
            Some(&g) => groups[g].push(i),
            None => {
                slot.insert(f.output_name.as_str(), groups.len());
                groups.push(vec![i]);
            }
        }
    }
    groups
}

fn render_frame(frame: &PlannedFrame, kit: Option<&TextKit>, legend: &Legend) -> Option<RgbImage> {
    let decoded = ImageReader::open(&frame.image)
        .ok()?
        .with_guessed_format()
        .ok()?
        .decode()
        .ok()?;
    let mut img = decoded.into_rgb8();
    let has_amber = frame.boxes.iter().any(|b| b.colour == AMBER);
    let patch = legend.patch(has_amber);
    let keep_out = (patch.width() as i32, patch.height() as i32);
    for b in &frame.boxes {
        outline_rect(&mut img, b.rect, b.colour);
        if let Some(k) = kit {
            draw_tag(&mut img, k, b, keep_out);
        }
    }
    legend.stamp(&mut img, has_amber);
    Some(img)
}

fn write_png(path: &Path, img: &RgbImage) -> Result<(), String> {
    let fail = |e: String| {
        format!(
            "Could not save the preview image {}: {}. Check that the disk has free space and that the folder is not read-only.",
            path.display(),
            e
        )
    };
    let file = fs::File::create(path).map_err(|e| fail(e.to_string()))?;
    let mut out = BufWriter::new(file);
    PngEncoder::new_with_quality(&mut out, CompressionType::Fast, FilterType::Adaptive)
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgb8)
        .map_err(|e| fail(e.to_string()))?;
    out.flush().map_err(|e| fail(e.to_string()))
}

fn put(img: &mut RgbImage, x: i32, y: i32, c: Rgb) {
    if x >= 0 && y >= 0 && (x as u32) < img.width() && (y as u32) < img.height() {
        img.put_pixel(x as u32, y as u32, image::Rgb(c));
    }
}

fn hline(img: &mut RgbImage, x0: i32, y: i32, x1: i32, c: Rgb) {
    let (w, h) = (img.width() as i32, img.height() as i32);
    if y < 0 || y >= h {
        return;
    }
    let (mut a, mut b) = if x0 > x1 { (x1, x0) } else { (x0, x1) };
    if a < 0 {
        a = 0;
    } else if a >= w {
        return;
    }
    if b < 0 {
        return;
    } else if b >= w {
        b = w - 1;
    }
    for x in a..=b {
        img.put_pixel(x as u32, y as u32, image::Rgb(c));
    }
}

fn vline(img: &mut RgbImage, x: i32, from: i32, to: i32, c: Rgb) {
    let step = if to < from { -1 } else { 1 };
    let mut y = from;
    for _ in 0..(to - from).abs() {
        put(img, x, y, c);
        y += step;
    }
}

pub(crate) fn outline_rect(img: &mut RgbImage, rect: [i32; 4], c: Rgb) {
    let [x0, mut y0, x1, mut y1] = rect;
    if y0 > y1 {
        std::mem::swap(&mut y0, &mut y1);
    }
    for i in 0..BOX_LINE {
        hline(img, x0, y0 + i, x1, c);
        hline(img, x0, y1 - i, x1, c);
        vline(img, x1 - i, y0 + BOX_LINE, y1 - BOX_LINE + 1, c);
        vline(img, x0 + i, y0 + BOX_LINE, y1 - BOX_LINE + 1, c);
    }
}

fn fill_rect(img: &mut RgbImage, x0: i32, y0: i32, x1: i32, y1: i32, c: Rgb) {
    for y in y0..=y1 {
        hline(img, x0, y, x1, c);
    }
}

fn shade(img: &mut RgbImage, x0: i32, y0: i32, x1: i32, y1: i32) {
    let (w, h) = (img.width() as i32, img.height() as i32);
    let (xa, xb) = (x0.max(0), x1.min(w));
    let (ya, yb) = (y0.max(0), y1.min(h));
    for y in ya..yb {
        for x in xa..xb {
            let p = img.get_pixel_mut(x as u32, y as u32);
            for ch in p.0.iter_mut() {
                *ch = ((u32::from(*ch) * PLATE_KEEP + 128) >> 8) as u8;
            }
        }
    }
}

fn blend(img: &mut RgbImage, x: i32, y: i32, c: Rgb, coverage: f32) {
    if x < 0 || y < 0 || x as u32 >= img.width() || y as u32 >= img.height() {
        return;
    }
    let a = coverage.clamp(0.0, 1.0);
    if a <= 0.0 {
        return;
    }
    let p = img.get_pixel_mut(x as u32, y as u32);
    for (ch, fg) in p.0.iter_mut().zip(c) {
        let bg = f32::from(*ch);
        *ch = (bg + (f32::from(fg) - bg) * a).round().clamp(0.0, 255.0) as u8;
    }
}

fn draw_tag(img: &mut RgbImage, kit: &TextKit, b: &PlannedBox, keep_out: (i32, i32)) {
    let suffix = if b.category == CAT_SHIPPED {
        String::new()
    } else {
        format!("[{}]", b.category)
    };
    let mut segments: Vec<(&str, Rgb)> = vec![(b.primary.as_str(), b.colour)];
    if !b.dimmed.is_empty() {
        segments.push((b.dimmed.as_str(), GREY));
    }
    if !suffix.is_empty() {
        segments.push((suffix.as_str(), b.colour));
    }

    let mut width = 0.0;
    for (i, (text, _)) in segments.iter().enumerate() {
        if i > 0 {
            width += TAG_GAP;
        }
        width += kit.width(text);
    }

    let mut x = b.tag_at.0 as f32;
    let overflow = x + width + PLATE_PAD as f32 - img.width() as f32;
    if overflow > 0.0 {
        x = (x - overflow).max(PLATE_PAD as f32);
    }
    let px0 = x.floor() as i32 - PLATE_PAD;
    let px1 = (x + width).ceil() as i32 + PLATE_PAD;
    let mut row = b.tag_at.1.floor() as i32;
    if px0 < keep_out.0 && row < keep_out.1 {
        row = keep_out.1 + 1;
    }
    let top = row as f32;
    shade(img, px0, row, px1, row + ROW_H);

    let mut cx = x;
    for (i, (text, colour)) in segments.iter().enumerate() {
        if i > 0 {
            cx += TAG_GAP;
        }
        cx += kit.draw(img, cx, top, text, *colour);
    }
}

struct TextKit {
    font: FontVec,
    scale: PxScale,
    baseline: f32,
}

impl TextKit {
    fn load() -> Option<TextKit> {
        let windir = std::env::var_os("WINDIR")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("C:\\Windows"));
        let fixed = PathBuf::from("C:\\Windows");
        for name in ["segoeui.ttf", "arial.ttf"] {
            for root in [&windir, &fixed] {
                let bytes = match fs::read(root.join("Fonts").join(name)) {
                    Ok(b) => b,
                    Err(_) => continue,
                };
                if let Ok(font) = FontVec::try_from_vec(bytes) {
                    return Some(TextKit::new(font));
                }
            }
        }
        None
    }

    fn new(font: FontVec) -> TextKit {
        let upem = font.units_per_em().unwrap_or(2048.0);
        let scale = PxScale::from(FONT_EM_PX * font.height_unscaled() / upem);
        let rise = ink_extent(&font, scale, "dlHkbh", true);
        let drop = ink_extent(&font, scale, "gpyjq", false);
        let baseline = ((ROW_H as f32 - (rise + drop)) / 2.0 + rise).round();
        TextKit { font, scale, baseline }
    }

    fn width(&self, text: &str) -> f32 {
        let sf = self.font.as_scaled(self.scale);
        let mut w = 0.0;
        let mut prev: Option<GlyphId> = None;
        for c in text.chars() {
            let id = sf.glyph_id(c);
            if let Some(p) = prev {
                w += sf.kern(p, id);
            }
            w += sf.h_advance(id);
            prev = Some(id);
        }
        w
    }

    fn draw(&self, img: &mut RgbImage, x: f32, top: f32, text: &str, colour: Rgb) -> f32 {
        let sf = self.font.as_scaled(self.scale);
        let base = top + self.baseline;
        let mut caret = x;
        let mut prev: Option<GlyphId> = None;
        for c in text.chars() {
            let id = sf.glyph_id(c);
            if let Some(p) = prev {
                caret += sf.kern(p, id);
            }
            let glyph = id.with_scale_and_position(self.scale, point(caret, base));
            if let Some(outlined) = self.font.outline_glyph(glyph) {
                let bounds = outlined.px_bounds();
                let (bx, by) = (bounds.min.x as i32, bounds.min.y as i32);
                outlined.draw(|gx, gy, cov| blend(img, bx + gx as i32, by + gy as i32, colour, cov));
            }
            caret += sf.h_advance(id);
            prev = Some(id);
        }
        caret - x
    }
}

fn ink_extent(font: &FontVec, scale: PxScale, chars: &str, above: bool) -> f32 {
    let mut best = 0.0f32;
    for c in chars.chars() {
        let glyph = font.glyph_id(c).with_scale_and_position(scale, point(0.0, 0.0));
        if let Some(outlined) = font.outline_glyph(glyph) {
            let b = outlined.px_bounds();
            let v = if above { -b.min.y } else { b.max.y };
            best = best.max(v);
        }
    }
    best
}

struct Legend {
    plain: RgbImage,
    amber: RgbImage,
}

impl Legend {
    fn build(kit: Option<&TextKit>) -> Legend {
        Legend {
            plain: legend_patch(kit, false),
            amber: legend_patch(kit, true),
        }
    }

    fn patch(&self, has_amber: bool) -> &RgbImage {
        if has_amber {
            &self.amber
        } else {
            &self.plain
        }
    }

    fn stamp(&self, img: &mut RgbImage, has_amber: bool) {
        let patch = self.patch(has_amber);
        let w = patch.width().min(img.width());
        let h = patch.height().min(img.height());
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, *patch.get_pixel(x, y));
            }
        }
    }
}

fn legend_patch(kit: Option<&TextKit>, with_amber: bool) -> RgbImage {
    let mut lines: Vec<(Rgb, &str)> = vec![(RED, LEGEND_RED)];
    if with_amber {
        lines.push((AMBER, LEGEND_AMBER));
    }
    let text_w = kit
        .map(|k| lines.iter().map(|(_, t)| k.width(t)).fold(0.0f32, f32::max))
        .unwrap_or(0.0);
    let box_w = LEGEND_MIN_W.max(LEGEND_TEXT_X + text_w.ceil() as i32 + LEGEND_PAD);
    let box_h = LEGEND_PAD * 2 + lines.len() as i32 * ROW_H;
    let mut patch = RgbImage::from_pixel((box_w + 1) as u32, (box_h + 1) as u32, image::Rgb(BLACK));
    let mut y = LEGEND_PAD;
    for (colour, text) in &lines {
        fill_rect(&mut patch, LEGEND_PAD, y + 3, LEGEND_PAD + LEGEND_SWATCH, y + 3 + LEGEND_SWATCH, *colour);
        if let Some(k) = kit {
            k.draw(&mut patch, LEGEND_TEXT_X as f32, y as f32, text, WHITE);
        }
        y += ROW_H;
    }
    patch
}
