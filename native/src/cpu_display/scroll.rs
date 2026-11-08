//! Retained scrolling. A frame that scrolls a container moves the pixels the last frame drew
//! there ([`ScrollBlit`]) and redraws only what moving cannot give: the strip scrolled into
//! view, content that changed besides scrolling and what paints over the container.
use super::*;

/// The pixels of `rect` (whole device pixels) move by `dx`, `dy` (whole pixels too).
#[derive(Clone, Copy, Debug, PartialEq)]
pub(crate) struct ScrollBlit {
    pub(crate) rect: Rect,
    pub(crate) dx: f64,
    pub(crate) dy: f64,
}

impl ScrollBlit {
    /// Moves the pixels of a frame `width` × `height` pixels.
    pub(crate) fn apply(&self, pixels: &mut [u32], width: usize, height: usize) {
        let x0 = self.rect.x0.max(0.0) as usize;
        let y0 = self.rect.y0.max(0.0) as usize;
        let x1 = (self.rect.x1.max(0.0) as usize).min(width);
        let y1 = (self.rect.y1.max(0.0) as usize).min(height);
        if x1 <= x0 || y1 <= y0 || pixels.len() < width * height {
            return;
        }
        let (dx, dy) = (self.dx as isize, self.dy as isize);
        let (w, h) = ((x1 - x0) as isize, (y1 - y0) as isize);
        if dx.abs() >= w || dy.abs() >= h {
            return;
        }
        let (source_x, target_x) = if dx >= 0 {
            (x0, x0 + dx as usize)
        } else {
            (x0 + (-dx) as usize, x0)
        };
        let length = (w - dx.abs()) as usize;
        let rows = (h - dy.abs()) as usize;
        let mut copy = |row: usize| {
            let (source_y, target_y) = if dy >= 0 {
                (y0 + row, y0 + row + dy as usize)
            } else {
                (y0 + row + (-dy) as usize, y0 + row)
            };
            let source = source_y * width + source_x;
            pixels.copy_within(source..source + length, target_y * width + target_x);
        };
        // Rows move away from the side they come from, so none is read after it is written.
        if dy > 0 {
            (0..rows).rev().for_each(&mut copy);
        } else {
            (0..rows).for_each(&mut copy);
        }
    }

    /// Where pixels of `region` inside the rect show once moved; None when none are inside.
    pub(crate) fn carry(&self, region: Rect) -> Option<Rect> {
        let inside = region.intersect(self.rect);
        if inside.width() <= 0.0 || inside.height() <= 0.0 {
            return None;
        }
        let moved = (inside + Vec2::new(self.dx, self.dy)).intersect(self.rect);
        (moved.width() > 0.0 && moved.height() > 0.0).then_some(moved)
    }

    /// The strips the move leaves without a source: where the content scrolls in from.
    fn exposed(&self) -> [Rect; 2] {
        let r = self.rect;
        let vertical = if self.dy > 0.0 {
            Rect::new(r.x0, r.y0, r.x1, r.y0 + self.dy)
        } else if self.dy < 0.0 {
            Rect::new(r.x0, r.y1 + self.dy, r.x1, r.y1)
        } else {
            Rect::ZERO
        };
        let horizontal = if self.dx > 0.0 {
            Rect::new(r.x0, r.y0, r.x0 + self.dx, r.y1)
        } else if self.dx < 0.0 {
            Rect::new(r.x1 + self.dx, r.y0, r.x1, r.y1)
        } else {
            Rect::ZERO
        };
        [vertical, horizontal]
    }
}

/// The whole pixels `rect` covers entirely, and those it touches.
fn inner_pixels(rect: Rect) -> Rect {
    Rect::new(
        rect.x0.ceil(),
        rect.y0.ceil(),
        rect.x1.floor(),
        rect.y1.floor(),
    )
}

fn outer_pixels(rect: Rect) -> Rect {
    Rect::new(
        rect.x0.floor(),
        rect.y0.floor(),
        rect.x1.ceil(),
        rect.y1.ceil(),
    )
}

fn overlaps(a: Rect, b: Rect) -> bool {
    a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1
}

fn contains(outer: Rect, inner: Rect) -> bool {
    const EPSILON: f64 = 1e-6;
    outer.x0 <= inner.x0 + EPSILON
        && outer.y0 <= inner.y0 + EPSILON
        && outer.x1 >= inner.x1 - EPSILON
        && outer.y1 >= inner.y1 - EPSILON
}

/// The box a device-space path surely covers: its bounding box, less its rounded corners
/// (a rectangle keeps the whole box; any other shape is estimated generously).
fn covered_box(transform: Affine, path: &BezPath) -> Rect {
    let device = transform * path.clone();
    let bounds = device.bounding_box();
    let mut corner: f64 = 0.0;
    for element in device.elements() {
        let points: &[vello::kurbo::Point] = match element {
            PathEl::MoveTo(p) | PathEl::LineTo(p) => std::slice::from_ref(p),
            PathEl::QuadTo(a, b) => &[*a, *b],
            PathEl::CurveTo(a, b, c) => &[*a, *b, *c],
            PathEl::ClosePath => &[],
        };
        for p in points {
            let x = (p.x - bounds.x0).min(bounds.x1 - p.x);
            let y = (p.y - bounds.y0).min(bounds.y1 - p.y);
            corner = corner.max(x.min(y));
        }
    }
    if corner <= 1e-6 {
        bounds
    } else {
        bounds.inflate(-(corner * 2.5 + 1.0), -(corner * 2.5 + 1.0))
    }
}

/// Whether a path runs along its bounding box (a rectangle, a rounded one): straight
/// segments lie on its edges and curves join points on them, so a stroke of it inks
/// nothing in the middle. A diagonal or a shape inside it does not.
fn box_like(transform: Affine, path: &BezPath) -> bool {
    const EPSILON: f64 = 1e-3;
    let device = transform * path.clone();
    let b = device.bounding_box();
    let on_edge = |p: vello::kurbo::Point| {
        (p.x - b.x0).abs() < EPSILON
            || (p.x - b.x1).abs() < EPSILON
            || (p.y - b.y0).abs() < EPSILON
            || (p.y - b.y1).abs() < EPSILON
    };
    let same_edge = |p: vello::kurbo::Point, q: vello::kurbo::Point| {
        ((p.x - q.x).abs() < EPSILON
            && ((p.x - b.x0).abs() < EPSILON || (p.x - b.x1).abs() < EPSILON))
            || ((p.y - q.y).abs() < EPSILON
                && ((p.y - b.y0).abs() < EPSILON || (p.y - b.y1).abs() < EPSILON))
    };
    let mut start = vello::kurbo::Point::ZERO;
    let mut current = vello::kurbo::Point::ZERO;
    for element in device.elements() {
        match *element {
            PathEl::MoveTo(p) => {
                if !on_edge(p) {
                    return false;
                }
                (start, current) = (p, p);
            }
            PathEl::LineTo(p) => {
                if !same_edge(current, p) {
                    return false;
                }
                current = p;
            }
            PathEl::QuadTo(_, p) | PathEl::CurveTo(_, _, p) => {
                if !on_edge(p) {
                    return false;
                }
                current = p;
            }
            PathEl::ClosePath => {
                if !same_edge(current, start) && current.distance(start) > EPSILON {
                    return false;
                }
                current = start;
            }
        }
    }
    true
}

/// Whether what the ops before `group` paint under `rect` looks the same wherever in it a
/// pixel is (a solid box covering it, layers holding the group), so its pixels can move.
fn movable(list: &DisplayList, group: &ScrollGroup, rect: Rect) -> bool {
    if list.ops[group.ops.clone()]
        .iter()
        .any(|op| matches!(op.op, Op::Glass { .. }))
    {
        return false;
    }
    let mut index = 0;
    while index < group.ops.start {
        let recorded = &list.ops[index];
        if !overlaps(recorded.bounds, rect) {
            index += 1;
            continue;
        }
        // A layer that clips everything it holds away from the rect draws nothing there.
        if let Op::PushClip {
            transform,
            path,
            close,
            ..
        }
        | Op::PushOpacity {
            transform,
            path,
            close,
            ..
        } = &recorded.op
            && index + close < group.ops.end
            && !overlaps((*transform * path.clone()).bounding_box(), rect)
        {
            index += close + 1;
            continue;
        }
        let ok = match &recorded.op {
            Op::Pop => true,
            // A clip, or a uniform fade, over the whole rect: what it holds is checked op
            // by op after it.
            Op::PushClip {
                transform, path, ..
            }
            | Op::PushOpacity {
                transform, path, ..
            } => contains(covered_box(*transform, path), rect),
            // A border around the content (a frameless window's edge) inks only along
            // its path: nothing inside, farther than the line reaches.
            Op::Stroke {
                stroke,
                transform,
                path,
                ..
            } => {
                let coeffs = transform.as_coeffs();
                let scale = (coeffs[0] * coeffs[3] - coeffs[1] * coeffs[2]).abs().sqrt();
                // Joins of a path along its box spike outward only: inward a line reaches
                // half its width, and pixels it does not cover get no coverage.
                let reach = stroke.width / 2.0 * scale;
                let inside = covered_box(*transform, path).inflate(-reach, -reach);
                box_like(*transform, path)
                    && inside.width() > 0.0
                    && inside.height() > 0.0
                    && contains(inside, rect)
            }
            Op::Fill {
                transform,
                paint: Paint::Solid(_),
                path,
                ..
            } => {
                let exact = match path {
                    FillShape::Rect(local) => transform.transform_rect_bbox(*local),
                    FillShape::RoundedRect(rounded) => {
                        transform.transform_rect_bbox(rounded.rect())
                    }
                    FillShape::Path(path) => (*transform * path.clone()).bounding_box(),
                };
                let covered = match path {
                    FillShape::Rect(_)
                        if transform.as_coeffs()[1] == 0.0 && transform.as_coeffs()[2] == 0.0 =>
                    {
                        exact
                    }
                    FillShape::Rect(local) => covered_box(*transform, &local.to_path(0.1)),
                    FillShape::RoundedRect(rounded) => {
                        covered_box(*transform, &rounded.to_path(0.1))
                    }
                    FillShape::Path(path) => covered_box(*transform, path),
                };
                !overlaps(exact, rect) || contains(covered, rect)
            }
            _ => false,
        };
        if !ok {
            return false;
        }
        index += 1;
    }
    true
}

/// Whether the op puts pixels down itself (not a layer opening or closing).
fn draws(op: &Recorded) -> bool {
    !matches!(
        op.op,
        Op::PushClip { .. } | Op::PushOpacity { .. } | Op::PushMask { .. } | Op::Pop
    )
}

/// Ops of `list` inside the given groups.
fn group_mask<'a>(list: &DisplayList, groups: impl Iterator<Item = &'a ScrollGroup>) -> Vec<bool> {
    let mut mask = vec![false; list.ops.len()];
    for group in groups {
        mask[group.ops.clone()].iter_mut().for_each(|op| *op = true);
    }
    mask
}

/// What changed in a moved group besides scrolling: ops matched by their unscrolled hash.
fn content_damage(
    previous: &DisplayList,
    before: &ScrollGroup,
    next: &DisplayList,
    group: &ScrollGroup,
    blit: ScrollBlit,
    out: &mut Vec<Rect>,
) {
    let mut available: HashMap<u64, VecDeque<usize>> = HashMap::new();
    for index in before.ops.clone() {
        available
            .entry(previous.ops[index].content)
            .or_default()
            .push_back(index);
    }
    // Content shows only inside its clip: what it changes outside is never seen.
    let touched = outer_pixels(group.clip);
    let mut matched = vec![false; previous.ops.len()];
    let mut last: Option<usize> = None;
    for op in &next.ops[group.ops.clone()] {
        match available.get_mut(&op.content).and_then(VecDeque::pop_front) {
            Some(index) => {
                matched[index] = true;
                if last.is_some_and(|last| index < last) {
                    out.push(op.bounds.intersect(touched));
                    out.extend(blit.carry(previous.ops[index].bounds));
                }
                last = Some(last.map_or(index, |last| last.max(index)));
            }
            None => out.push(op.bounds.intersect(touched)),
        }
    }
    for index in before.ops.clone() {
        if !matched[index] {
            // Its pixels moved with the rest: they are redrawn where they went.
            out.extend(blit.carry(previous.ops[index].bounds));
        }
    }
}

/// How the frame `previous` drew becomes `next` when `next` scrolls containers `previous`
/// had: pixel moves, then the regions to redraw. None when nothing scrolled, or when moving
/// pixels cannot give the frame (a clip that changed, a backdrop that differs from pixel to
/// pixel, glass): `damage` applies then.
pub(crate) fn scroll_damage(
    previous: &DisplayList,
    next: &DisplayList,
) -> Option<(Vec<ScrollBlit>, Vec<Rect>)> {
    let mut pairs = Vec::new();
    for group in &next.scroll_groups {
        let Some(before) = previous
            .scroll_groups
            .iter()
            .find(|before| before.key == group.key)
        else {
            continue;
        };
        if before.offset == group.offset {
            continue;
        }
        let same_clip = [
            (before.clip.x0, group.clip.x0),
            (before.clip.y0, group.clip.y0),
            (before.clip.x1, group.clip.x1),
            (before.clip.y1, group.clip.y1),
        ]
        .iter()
        .all(|(a, b)| (a - b).abs() < 1e-6);
        if !same_clip {
            return None;
        }
        let rect = inner_pixels(group.clip);
        let shift = before.offset - group.offset;
        if rect.width() <= 0.0
            || rect.height() <= 0.0
            || shift.x.abs() >= rect.width()
            || shift.y.abs() >= rect.height()
            || !movable(next, group, rect)
            || !movable(previous, before, rect)
        {
            return None;
        }
        pairs.push((
            before,
            group,
            ScrollBlit {
                rect,
                dx: shift.x,
                dy: shift.y,
            },
        ));
    }
    if pairs.is_empty() {
        return None;
    }
    let mut regions = Vec::new();
    // Outside the moved content, ops compare as `damage` compares them.
    let moved_before = group_mask(previous, pairs.iter().map(|pair| pair.0));
    let moved_next = group_mask(next, pairs.iter().map(|pair| pair.1));
    damage_into(
        previous,
        next,
        |index| !moved_before[index],
        |index| !moved_next[index],
        &mut regions,
    );
    for &(before, group, blit) in &pairs {
        let touched = outer_pixels(group.clip);
        // Pixels the clip covers only in part do not move: they are drawn again.
        regions.extend([
            Rect::new(touched.x0, touched.y0, blit.rect.x0, touched.y1),
            Rect::new(blit.rect.x1, touched.y0, touched.x1, touched.y1),
            Rect::new(touched.x0, touched.y0, touched.x1, blit.rect.y0),
            Rect::new(touched.x0, blit.rect.y1, touched.x1, touched.y1),
        ]);
        regions.extend(blit.exposed());
        content_damage(previous, before, next, group, blit, &mut regions);
        // What paints over the content moved with it: redrawn where it went and where it is.
        // Layers paint nothing themselves (what they hold follows them), and their bounds
        // span their whole shape: only what draws counts.
        for op in next.ops[group.ops.end..].iter().filter(|op| draws(op)) {
            if overlaps(op.bounds, touched) {
                regions.push(op.bounds.intersect(touched));
            }
        }
        for op in previous.ops[before.ops.end..].iter().filter(|op| draws(op)) {
            regions.extend(blit.carry(op.bounds));
        }
    }
    let blits = pairs.iter().map(|pair| pair.2).collect();
    regions.retain(|rect| rect.width() > 0.0 && rect.height() > 0.0);
    Some((blits, regions))
}

/// `regions` as a few rectangles: neighbours whose union wastes little are joined, and a
/// long list collapses into its bounding box.
pub(crate) fn merge_regions(mut regions: Vec<Rect>) -> Vec<Rect> {
    const SLACK: f64 = 64.0 * 64.0;
    regions.retain(|rect| rect.width() > 0.0 && rect.height() > 0.0);
    regions.sort_by(|a, b| a.y0.total_cmp(&b.y0).then(a.x0.total_cmp(&b.x0)));
    let mut merged: Vec<Rect> = Vec::with_capacity(regions.len());
    'regions: for rect in regions {
        for kept in merged.iter_mut() {
            let union = kept.union(rect);
            if union.area() <= kept.area() + rect.area() + SLACK {
                *kept = union;
                continue 'regions;
            }
        }
        merged.push(rect);
    }
    // Joining can make rectangles overlap new neighbours: settle until nothing joins.
    loop {
        let mut joined = false;
        let mut index = 0;
        while index < merged.len() {
            let mut other = index + 1;
            while other < merged.len() {
                let union = merged[index].union(merged[other]);
                if union.area() <= merged[index].area() + merged[other].area() + SLACK {
                    merged[index] = union;
                    merged.swap_remove(other);
                    joined = true;
                } else {
                    other += 1;
                }
            }
            index += 1;
        }
        if !joined {
            break;
        }
    }
    if merged.len() > 8 {
        let all = merged
            .iter()
            .skip(1)
            .fold(merged[0], |all, rect| all.union(*rect));
        return vec![all];
    }
    merged
}
