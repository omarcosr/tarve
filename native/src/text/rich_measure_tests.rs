use super::*;
use std::sync::Arc;

#[test]
fn css_generic_font_families_are_resolved_as_generics() {
    let node = |family: &str| -> Node {
        serde_json::from_value(serde_json::json!({
            "id": "font-family",
            "kind": "text",
            "text": "123",
            "style": { "fontFamily": family }
        }))
        .unwrap()
    };

    let system = node("system-ui");
    assert_eq!(
        node_font_family(&system, GenericFamily::Serif),
        FontFamily::from(default_ui_generic_family())
    );

    let monospace = node("monospace");
    assert_eq!(
        node_font_family(&monospace, GenericFamily::Serif),
        FontFamily::from(GenericFamily::Monospace)
    );

    let named = node("Segoe UI");
    assert_eq!(
        node_font_family(&named, GenericFamily::Serif),
        FontFamily::Source("Segoe UI".into())
    );
}

#[derive(Debug)]
struct GlyphRunProbe {
    origin: (f64, f64),
    first_glyph: Option<(u32, f64, f64)>,
}

#[derive(Default)]
struct ProbeTarget {
    runs: Vec<GlyphRunProbe>,
    clips: Vec<Rect>,
    pops: usize,
}

impl PaintTarget for ProbeTarget {
    fn box_shadow(&mut self, _: Affine, _: Rect, _: Rect, _: Color, _: f64, _: f64, _: bool) {}

    fn fill<S: vello::kurbo::Shape>(
        &mut self,
        _fill: Fill,
        _transform: Affine,
        _color: Color,
        _shape: &S,
    ) {
    }

    fn stroke<S: vello::kurbo::Shape>(
        &mut self,
        _stroke: &Stroke,
        _transform: Affine,
        _color: Color,
        _shape: &S,
    ) {
    }

    fn push_clip<S: vello::kurbo::Shape>(&mut self, _fill: Fill, _transform: Affine, shape: &S) {
        self.clips.push(shape.bounding_box());
    }

    fn push_opacity<S: vello::kurbo::Shape>(
        &mut self,
        _alpha: f32,
        _transform: Affine,
        _shape: &S,
    ) {
    }

    fn pop_layer(&mut self) {
        self.pops += 1;
    }

    fn draw_image(&mut self, _key: &str, _image: &vello::peniko::ImageData, _transform: Affine) {}

    fn draw_glyphs(
        &mut self,
        _font: &vello::peniko::FontData,
        _font_size: f32,
        _normalized_coords: &[i16],
        transform: Affine,
        _color: Color,
        glyphs: &[PaintGlyph],
    ) {
        let coeffs = transform.as_coeffs();
        let origin = (coeffs[4], coeffs[5]);
        let first_glyph = glyphs.first().map(|glyph| {
            (
                glyph.id,
                origin.0 + f64::from(glyph.x),
                origin.1 + f64::from(glyph.y),
            )
        });
        self.runs.push(GlyphRunProbe {
            origin,
            first_glyph,
        });
    }
}

#[test]
fn a_code_gutter_number_shares_its_lines_baseline() {
    // Every number is its own Parley layout, but it must use the same font
    // metrics as the source so baseline alignment also looks aligned.
    let mut node: Node = serde_json::from_value(serde_json::json!({
        "id":"code", "kind":"code", "showLineNumbers":true,
        "text":"alpha\n\nbravo\n\ncharlie",
        "style":{"fontFamily":"Consolas","fontSize":13,"lineHeight":1.5}
    }))
    .unwrap();
    node.rich = Some(Arc::new(crate::rich::code(&node.text, None, None)));
    let mut engine = TextEngine::new();
    engine.prepare(&node);
    let layout = engine.layouts.get("code").expect("layout prepared");
    let count = layout.lines().count();
    // Parley may fold a run of blank lines, so the shaped line count is the
    // authority and the gutter must be built from it, not from a count of
    // `\n` in the source. A gutter longer than the layout would number lines
    // that do not exist; one shorter drops the tail of the file.
    assert_eq!(engine.code_gutter_layouts["code"].len(), count);
    // A folded blank line is exactly the case that made the numbers skip:
    // every source line still needs a number, so the gutter is built from
    // the source and each number lands on the line that owns it.
    let source_lines = node.text.split('\n').count();
    assert_eq!(
        engine.code_gutter_layouts["code"].len(),
        source_lines,
        "every source line needs a number: layout has {count}, source has {source_lines}"
    );
    assert!(
        count >= 4,
        "the sample must still shape into several lines, got {count}"
    );
    let source_baselines: Vec<f64> = layout
        .lines()
        .map(|line| f64::from(line.metrics().baseline))
        .collect();
    let gutters = &engine.code_gutter_layouts["code"];
    let offsets = code_gutter_y_offsets(layout, gutters);
    assert_eq!(offsets.len(), source_baselines.len());

    for (index, ((source_baseline, offset), gutter)) in source_baselines
        .iter()
        .zip(&offsets)
        .zip(gutters)
        .enumerate()
    {
        let gutter_baseline = f64::from(
            gutter
                .lines()
                .next()
                .expect("gutter number has one line")
                .metrics()
                .baseline,
        );
        let painted_baseline = offset + gutter_baseline;
        assert!(
            (painted_baseline - source_baseline).abs() < 0.001,
            "line {} gutter baseline {painted_baseline} != source baseline {source_baseline}",
            index + 1
        );
    }

    let source_first_baseline = source_baselines[0];
    for gutter in gutters {
        let gutter_baseline = f64::from(
            gutter
                .lines()
                .next()
                .expect("gutter number has one line")
                .metrics()
                .baseline,
        );
        assert!(
            (gutter_baseline - source_first_baseline).abs() < 0.001,
            "code and gutter must use identical relative baseline metrics: {gutter_baseline} != {source_first_baseline}"
        );
    }
}

#[test]
fn code_gutter_paints_beside_source_with_optical_raster_alignment() {
    // Use the same glyph in the gutter and source so this checks the final
    // paint coordinates, not only Parley's abstract line metrics. This is
    // the regression that was visible in rich-content-view: a correct
    // line count can still look wrong when the two columns are translated
    // independently at paint time.
    let mut node: Node = serde_json::from_value(serde_json::json!({
        "id":"code", "kind":"code", "showLineNumbers":true,
        "text":"1\n2",
        "style":{"fontFamily":"Consolas","fontSize":13,"lineHeight":1.5}
    }))
    .unwrap();
    node.rich = Some(Arc::new(crate::rich::code(&node.text, None, None)));
    let mut engine = TextEngine::new();
    engine.prepare(&node);

    let mut target = ProbeTarget::default();
    let origin = (11.0, 17.0);
    engine.draw(
        &mut target,
        &node,
        TextDrawArea {
            origin,
            width: 200.0,
            visible_y: (0.0, 200.0),
            scroll_x: 0.0,
        },
        Color::from_rgb8(0, 0, 0),
        1.0,
    );

    assert_eq!(target.runs.len(), 4, "two gutter and two source glyph runs");
    let gutters = &engine.code_gutter_layouts["code"];
    for (line, gutter_layout) in gutters.iter().enumerate().take(2) {
        let gutter = &target.runs[line];
        let source = &target.runs[line + 2];
        let (gutter_id, _, gutter_y) = gutter.first_glyph.expect("gutter glyph");
        let (source_id, _, source_y) = source.first_glyph.expect("source glyph");
        assert_eq!(gutter_id, source_id, "same digit must use the same glyph");
        assert!(
            ((gutter_y - source_y) - CODE_GUTTER_OPTICAL_Y_PX).abs() < 0.001,
            "line {} gutter raster offset {} != optical offset {}",
            line + 1,
            gutter_y - source_y,
            CODE_GUTTER_OPTICAL_Y_PX
        );

        let gutter_right = gutter.origin.0 + f64::from(gutter_layout.width());
        let expected_gap = f64::from(CODE_GUTTER_PADDING) - CODE_GUTTER_OPTICAL_X;
        assert!(
            ((source.origin.0 - gutter_right) - expected_gap).abs() < 0.001,
            "line {} gutter gap {} != expected {expected_gap}",
            line + 1,
            source.origin.0 - gutter_right
        );
    }
    assert!(
        (target.runs[2].origin.0 - (origin.0 + f64::from(engine.code_gutter_width(&node)))).abs()
            < 0.001,
        "source column must start after the full gutter"
    );
}

#[test]
fn scrolled_code_source_is_clipped_after_the_fixed_code_gutter() {
    let mut node: Node = serde_json::from_value(serde_json::json!({
        "id":"code", "kind":"code", "showLineNumbers":true,
        "text":"abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuvwxyz",
        "style":{"fontFamily":"Consolas","fontSize":13,"lineHeight":1.5}
    }))
    .unwrap();
    node.rich = Some(Arc::new(crate::rich::code(&node.text, None, None)));
    let mut engine = TextEngine::new();
    engine.prepare(&node);

    let mut target = ProbeTarget::default();
    let origin = (11.0, 17.0);
    let width = 120.0;
    engine.draw(
        &mut target,
        &node,
        TextDrawArea {
            origin,
            width,
            visible_y: (0.0, 80.0),
            scroll_x: 48.0,
        },
        Color::from_rgb8(0, 0, 0),
        1.0,
    );

    let gutter = f64::from(engine.code_gutter_width(&node));
    assert_eq!(target.clips.len(), 1, "source needs one dedicated clip");
    let clip = target.clips[0];
    assert!((clip.x0 - (origin.0 + gutter)).abs() < 0.001);
    assert!((clip.x1 - (origin.0 + f64::from(width))).abs() < 0.001);
    assert_eq!(target.pops, 1, "source clip must be balanced");
    let source = target.runs.last().expect("source glyph run");
    assert!(
        source.origin.0 < clip.x0,
        "the regression sample must scroll source ink behind the clip boundary"
    );
}

#[test]
fn code_gutter_width_comes_from_the_widest_shaped_number() {
    let text = (1..=120)
        .map(|line| format!("line {line}"))
        .collect::<Vec<_>>()
        .join("\n");
    let mut node: Node = serde_json::from_value(serde_json::json!({
        "id":"code", "kind":"code", "showLineNumbers":true,
        "text":text,
        "style":{"fontFamily":"Consolas","fontSize":13,"lineHeight":1.5}
    }))
    .unwrap();
    node.rich = Some(Arc::new(crate::rich::code(&node.text, None, None)));
    let mut engine = TextEngine::new();
    engine.prepare(&node);

    let gutters = &engine.code_gutter_layouts["code"];
    let widest_number = gutters.iter().map(Layout::width).fold(0.0_f32, f32::max);
    let expected = (widest_number + CODE_GUTTER_PADDING * 2.0).ceil();
    assert_eq!(engine.code_gutter_width(&node), expected);

    let right_edge = f64::from(expected) - f64::from(CODE_GUTTER_PADDING) + CODE_GUTTER_OPTICAL_X;
    for index in [0_usize, 9, 99, 119] {
        let gutter = &gutters[index];
        let x = f64::from(expected) - f64::from(gutter.width()) - f64::from(CODE_GUTTER_PADDING)
            + CODE_GUTTER_OPTICAL_X;
        assert!(
            (x + f64::from(gutter.width()) - right_edge).abs() < 0.001,
            "line {} must right-align to the same gutter edge",
            index + 1
        );
    }
}

#[test]
fn toggling_the_gutter_rebuilds_the_code_layout() {
    // The gutter is a node field, not a style key. If it stays out of the
    // layout signature, a node that switches it on keeps the unnumbered
    // geometry and the code paints underneath its own numbers.
    let mut engine = TextEngine::new();
    let build = |show: bool| Node {
        id: "code".into(),
        kind: "code".into(),
        show_line_numbers: show,
        text: "alpha\nbravo\ncharlie".into(),
        style: serde_json::json!({ "fontFamily": "Consolas", "fontSize": 13 }).into(),
        ..serde_json::from_value(serde_json::json!({
            "id":"code", "kind":"code", "text":"alpha\nbravo\ncharlie"
        }))
        .unwrap()
    };
    let mut plain = build(false);
    plain.rich = Some(Arc::new(crate::rich::code(&plain.text, None, None)));
    engine.prepare(&plain);
    assert!(!engine.code_gutter_layouts.contains_key("code"));

    let mut guttered = build(true);
    guttered.rich = Some(Arc::new(crate::rich::code(&guttered.text, None, None)));
    engine.prepare(&guttered);
    assert_eq!(
        engine.code_gutter_layouts["code"].len(),
        3,
        "turning the gutter on must build a number per line"
    );
    // And back off again, so a toggle in either direction is safe.
    engine.prepare(&plain);
    assert!(!engine.code_gutter_layouts.contains_key("code"));
}

#[test]
fn measuring_a_code_block_does_not_change_its_line_count() {
    // The measurement path re-breaks the layout. If that reflows a `Code`
    // block, the gutter — which numbers the lines it built at prepare time —
    // labels a different set of lines than the one paint draws, and the tail
    // of the file loses its numbers.
    let mut node: Node = serde_json::from_value(serde_json::json!({
        "id":"code", "kind":"code", "showLineNumbers":true,
        "text":"alpha\n\nbravo\ncharlie",
        "style":{"fontFamily":"Consolas","fontSize":13,"lineHeight":1.5}
    }))
    .unwrap();
    node.rich = Some(Arc::new(crate::rich::code(&node.text, None, None)));
    let mut engine = TextEngine::new();
    engine.prepare(&node);
    let before = engine.layouts["code"].lines().count();
    let gutters = engine.code_gutter_layouts["code"].len();
    assert_eq!(before, gutters);
    // Measure at several widths, exactly as layout and paint do.
    for width in [None, Some(200.0_f32), Some(1000.0), Some(40.0)] {
        let _ = engine.measure("code", width);
        assert_eq!(
            engine.layouts["code"].lines().count(),
            before,
            "measuring at {width:?} must not reflow a Code block"
        );
    }
}

#[test]
fn two_line_code_measurement_covers_the_last_line_box() {
    let mut node: Node = serde_json::from_value(serde_json::json!({
        "id":"code", "kind":"code",
        "text":"const answer = 42;\nconsole.log(answer);",
        "style":{"fontFamily":"Consolas","fontSize":13,"lineHeight":1.5}
    }))
    .unwrap();
    node.rich = Some(Arc::new(crate::rich::code(&node.text, Some("js"), None)));
    let mut engine = TextEngine::new();
    engine.prepare(&node);
    let expected_bottom = engine.layouts["code"]
        .lines()
        .last()
        .expect("two-line code must shape lines")
        .metrics()
        .block_max_coord
        .ceil();
    let (_, measured_height) = engine.measure("code", Some(760.0));
    assert_eq!(measured_height, expected_bottom);
    assert!(
        measured_height >= 13.0 * 1.5 * 2.0 * 0.9,
        "two code lines were clipped into {measured_height}px"
    );
}

#[test]
fn the_code_gutter_inset_is_reserved_by_measurement() {
    let mut with: Node = serde_json::from_value(serde_json::json!({
        "id":"a", "kind":"code", "showLineNumbers":true, "text":"alpha\nbravo",
        "style":{"fontFamily":"Consolas","fontSize":13}
    }))
    .unwrap();
    let mut without = with.clone();
    without.id = "b".into();
    without.show_line_numbers = false;
    with.rich = Some(Arc::new(crate::rich::code(&with.text, None, None)));
    without.rich = Some(Arc::new(crate::rich::code(&without.text, None, None)));
    let mut engine = TextEngine::new();
    engine.prepare(&with);
    engine.prepare(&without);
    let inset = engine.code_gutter_inset(&with);
    assert!(inset > 0.0, "a guttered block must reserve space");
    assert_eq!(engine.code_gutter_inset(&without), 0.0);
    // TextEngine measures only the source column. The tree adds the gutter
    // inset to that width when it measures the leaf and computes scrollMaxX.
    let source_width = engine.measure("a", None).0;
    let plain = engine.measure("b", None).0;
    assert_eq!(source_width, plain);
    let guttered = source_width + inset;
    assert!(
        guttered > plain,
        "gutter must widen the block: {guttered} vs {plain}"
    );
}

#[test]
fn diff_column_measure_covers_shaped_wide_rows_without_shaping_every_row() {
    let mut node: Node = serde_json::from_value(serde_json::json!({
        "id":"diff", "kind":"diff", "style":{"fontFamily":"Segoe UI", "fontSize":16}
    }))
    .unwrap();
    let (_, rich) = crate::rich::diff("--- a/demo.txt\n+++ b/demo.txt\n@@ -0,0 +1,4 @@\n+WWWWWWWWWW\n+界界界界界\n+🙂🙂🙂🙂🙂\n+mm\tmm\n", None, None, true, &[], None).unwrap();
    node.rich = Some(Arc::new(rich));
    let mut engine = TextEngine::new();
    let (measured, _) = engine.measure_diff(&node);
    let RichContent::Diff {
        rows,
        max_line_number,
        ..
    } = node.rich.as_deref().unwrap()
    else {
        panic!("expected diff")
    };
    for row in rows.iter().filter(|row| row.kind == DiffRowKind::Added) {
        let mut layout = engine.build_diff_row(&node, row).content;
        layout.break_all_lines(None);
        assert!(
            f64::from(measured) - diff_content_inset(&node, *max_line_number)
                >= f64::from(layout.width()),
            "estimated width clipped {}",
            row.text
        );
    }
}
