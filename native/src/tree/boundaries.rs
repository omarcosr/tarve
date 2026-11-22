//! Layout inside layout boundaries (boxes whose size nothing inside them changes), text
//! changes left offscreen until a frame is presented, and shaped text given back far offscreen.
use super::*;

impl Tree {
    /// Texts whose new content measures exactly as the box they have (a counter going from
    /// "12" to "13" in tabular digits) need no layout: they keep their box. Only single words
    /// laid out at their natural size qualify, whose min- and max-content are that size, so
    /// no line of the flex algorithm can come out differently.
    pub(super) fn settle_same_size_texts(&mut self) {
        let (entries, text, layout, deferred) = (
            &mut self.entries,
            &mut self.text,
            &self.layout,
            &self.deferred_texts,
        );
        for (id, entry) in entries.iter_mut() {
            let candidate =
                !deferred.contains(id.as_str())
                    && entry.measure_dirty
                    && !entry.layout_dirty
                    && !entry.structure_dirty
                    && entry.node.kind == "text"
                    && entry.node.rich.is_none()
                    && entry.node.runs.is_null()
                    && !entry.node.text.is_empty()
                    && entry.node.text.chars().all(|c| {
                        c.is_ascii_alphanumeric() || matches!(c, '.' | ',' | ':' | '%' | '#')
                    });
            let Some(layout_id) = entry.layout_id.filter(|_| candidate) else {
                continue;
            };
            let (width, height) = text.measure(id, None);
            let laid = layout.unrounded_layout(layout_id).size;
            if (width - laid.width.ceil()).abs() < 0.01
                && (height - laid.height.ceil()).abs() < 0.01
                && (laid.width - laid.width.ceil()).abs() < 0.01
                && (laid.height - laid.height.ceil()).abs() < 0.01
            {
                entry.measure_dirty = false;
            }
        }
    }

    /// A box with a fixed size, inside a flex container: its parent sizes and places it the
    /// same whatever it holds, so a change inside it needs no layout outside it.
    pub(super) fn layout_boundary(&self, id: &str) -> bool {
        let entry = &self.entries[id];
        if entry.layout_dirty || entry.structure_dirty || entry.measure_dirty {
            return false;
        }
        let (Some(layout_id), Some(parent)) = (entry.layout_id, entry.parent.as_deref()) else {
            return false;
        };
        let Some(parent_layout) = self.entries.get(parent).and_then(|parent| parent.layout_id)
        else {
            return false;
        };
        let (Ok(style), Ok(parent_style)) = (
            self.layout.style(layout_id),
            self.layout.style(parent_layout),
        ) else {
            return false;
        };
        let Some(height) = style.size.height.into_option() else {
            return false;
        };
        // No width of its own: a column stretching it across a width its content cannot change
        // (a list row of fixed height) places and sizes it the same too.
        let width = style.size.width.into_option();
        if width.is_none() && !self.stretched_across_fixed_width(style, parent) {
            return false;
        }
        // Block parents collapse a first child's margin through it; baseline alignment and
        // min/max sizes read its content. A flex basis of its own would size it instead of
        // its height, down to its content.
        if !style.flex_basis.is_auto()
            || parent_style.display != Display::Flex
            || style.display == Display::None
            || style.box_sizing != BoxSizing::BorderBox
            || style.aspect_ratio.is_some()
            || !(style.min_size.width.is_auto()
                && style.min_size.height.is_auto()
                && style.max_size.width.is_auto()
                && style.max_size.height.is_auto())
            || parent_style
                .align_items
                .is_some_and(|align| align.keyword == taffy::AlignItemsKeyword::Baseline)
            || style
                .align_self
                .is_some_and(|align| align.keyword == taffy::AlignItemsKeyword::Baseline)
        {
            return false;
        }
        // It came out at its specified size: neither grown nor shrunk by its line.
        let size = self.layout.unrounded_layout(layout_id).size;
        width.is_none_or(|width| size.width == width) && size.height == height
    }

    /// A box with an automatic width that a single-line flex column `parent` stretches across
    /// itself, where the column's own width depends on nothing it holds (see `width_independent`).
    pub(super) fn stretched_across_fixed_width(&self, style: &taffy::Style, parent: &str) -> bool {
        let Some(parent_style) = self
            .entries
            .get(parent)
            .and_then(|entry| entry.layout_id)
            .and_then(|layout_id| self.layout.style(layout_id).ok())
        else {
            return false;
        };
        let stretched = style
            .align_self
            .or(parent_style.align_items)
            .is_none_or(|align| align.keyword == taffy::AlignItemsKeyword::Stretch);
        parent_style.display == Display::Flex
            && matches!(
                parent_style.flex_direction,
                taffy::FlexDirection::Column | taffy::FlexDirection::ColumnReverse
            )
            && parent_style.flex_wrap == taffy::FlexWrap::NoWrap
            && stretched
            && style.size.width.is_auto()
            && style.min_size.width.is_auto()
            && style.max_size.width.is_auto()
            && !style.margin.left.is_auto()
            && !style.margin.right.is_auto()
            && self.width_independent(parent)
    }

    /// The width of `id` follows from the window and fixed widths alone, never from content:
    /// a fixed width, the window itself, or a box stretched across such a column.
    pub(super) fn width_independent(&self, id: &str) -> bool {
        if let Some(known) = self
            .width_independent_memo
            .borrow()
            .as_ref()
            .and_then(|memo| memo.get(id).copied())
        {
            return known;
        }
        let independent = self.width_independent_uncached(id);
        if let Some(memo) = self.width_independent_memo.borrow_mut().as_mut() {
            memo.insert(id.to_string(), independent);
        }
        independent
    }

    pub(super) fn width_independent_uncached(&self, id: &str) -> bool {
        let Some(entry) = self.entries.get(id) else {
            return false;
        };
        let Some(style) = entry
            .layout_id
            .and_then(|layout_id| self.layout.style(layout_id).ok())
        else {
            return false;
        };
        if style.size.width.into_option().is_some()
            && style.min_size.width.is_auto()
            && style.max_size.width.is_auto()
        {
            return true;
        }
        match entry.parent.as_deref() {
            None => true,
            Some(parent) => self.stretched_across_fixed_width(style, parent),
        }
    }

    /// Lays out again only inside the layout boundaries that hold every change (see
    /// `layout_boundary`), when there are such. False when the tree needs a full layout.
    pub(super) fn compute_within_boundaries(&mut self) -> Result<bool, String> {
        // Rows of one list ask `width_independent` about the same column: once per pass.
        *self.width_independent_memo.borrow_mut() = Some(HashMap::default());
        let result = self.compute_within_boundaries_memoized();
        *self.width_independent_memo.borrow_mut() = None;
        result
    }

    pub(super) fn compute_within_boundaries_memoized(&mut self) -> Result<bool, String> {
        let mut boundaries: Vec<String> = Vec::new();
        let mut seen: HashSet<String> = HashSet::default();
        for (id, entry) in &self.entries {
            if entry.node.virtual_list.is_some() || entry.node.report_size {
                return Ok(false);
            }
            if !(entry.layout_dirty
                || entry.structure_dirty
                || entry.measure_dirty
                || entry.layout_id.is_none())
                // Left for after the frame (`defer_offscreen_texts`).
                || self.deferred_texts.contains(id.as_str())
            {
                continue;
            }
            let mut ancestor = entry.parent.as_deref();
            let found = loop {
                let Some(candidate) = ancestor else {
                    return Ok(false);
                };
                if self.layout_boundary(candidate) {
                    break candidate;
                }
                ancestor = self.entries[candidate].parent.as_deref();
            };
            if seen.insert(found.to_string()) {
                boundaries.push(found.to_string());
            }
        }
        // A deferred boundary inside one that lays out now would lay out with stale texts:
        // nothing is deferred then.
        let deferred_inside = self.deferred_boundaries.iter().any(|id| {
            let mut ancestor = Some(id.as_str());
            while let Some(candidate) = ancestor {
                if seen.contains(candidate) {
                    return true;
                }
                ancestor = self.entries[candidate].parent.as_deref();
            }
            false
        });
        if deferred_inside {
            for id in self.prepare_deferred_texts() {
                if seen.insert(id.clone()) {
                    boundaries.push(id);
                }
            }
        }
        // Nothing an entry records needs layout (texts that kept their size, say): done.
        if boundaries.is_empty() {
            self.ensure_focused_textarea_caret_visible();
            self.resolve_highlights();
            self.highlight_dirty = false;
            return Ok(true);
        }
        // A boundary inside another one is laid out with it.
        let boundaries: Vec<String> = boundaries
            .into_iter()
            .filter(|id| {
                let mut ancestor = self.entries[id].parent.as_deref();
                while let Some(candidate) = ancestor {
                    if seen.contains(candidate) {
                        return false;
                    }
                    ancestor = self.entries[candidate].parent.as_deref();
                }
                true
            })
            .collect();
        if !self.lay_out_boundaries(&boundaries)? {
            return Ok(false);
        }
        self.ensure_focused_textarea_caret_visible();
        self.resolve_highlights();
        self.highlight_dirty = false;
        Ok(true)
    }

    /// Lays out each boundary's subtree at the size it has and places it; false (nothing
    /// placed) when one came out at another size, and the whole tree has to lay out.
    pub(super) fn lay_out_boundaries(&mut self, boundaries: &[String]) -> Result<bool, String> {
        for id in boundaries {
            let layout_id = self.build_layout(id, None)?;
            let text = &mut self.text;
            let nodes = &self.entries;
            let images = &self.images;
            let videos = &self.video_frames;
            let measure_calls = &mut self.measure_calls;
            let same_size = self
                .layout
                .compute_subtree_layout_with_measure(layout_id, |inputs, _, context, style| {
                    *measure_calls += 1;
                    measure_leaf(text, nodes, images, videos, inputs, context, style)
                })
                .map_err(|e| e.to_string())?;
            if !same_size {
                return Ok(false);
            }
        }
        for id in boundaries {
            self.mark_paint_changed(id);
            let parent_origin = self.absolute_origin(self.entries[id].parent.as_deref())?;
            let bounds = self.positions(id, parent_origin)?;
            // Ancestors paint (and are culled) within their descendants' bounds.
            let mut ancestor = self.entries[id].parent.clone();
            while let Some(current) = ancestor {
                let entry = self.entries.get_mut(&current).unwrap();
                if !clips_overflow(&entry.node) {
                    entry.bounds = entry.bounds.union(bounds);
                }
                ancestor = entry.parent.clone();
            }
        }
        Ok(true)
    }

    /// Defers the texts that changed inside offscreen layout boundaries (see `layout_boundary`),
    /// where nothing else changed: such a boundary keeps its size, so nothing outside it moves,
    /// and none of it shows. `finish_deferred_layout` shapes and lays them out once the frame
    /// with what shows is presented: a list whose every row changed paints its visible rows first.
    pub(super) fn defer_offscreen_texts(&mut self, width: f32, height: f32) {
        *self.width_independent_memo.borrow_mut() = Some(HashMap::default());
        self.defer_offscreen_texts_memoized(width, height);
        *self.width_independent_memo.borrow_mut() = None;
    }

    pub(super) fn defer_offscreen_texts_memoized(&mut self, width: f32, height: f32) {
        self.deferred_boundaries.clear();
        self.deferred_texts.clear();
        let (x0, y0) = (f64::from(self.viewport.0), f64::from(self.viewport.1));
        let window = BoxRect::new(x0, y0, x0 + f64::from(width), y0 + f64::from(height));
        // Boundary → whether it qualifies; the texts each one would defer.
        let mut verdicts: HashMap<String, bool> = HashMap::default();
        let mut texts: Vec<(String, String)> = Vec::new();
        for (id, entry) in &self.entries {
            if entry.node.virtual_list.is_some() || entry.node.report_size {
                return;
            }
            if !(entry.layout_dirty
                || entry.structure_dirty
                || entry.measure_dirty
                || entry.layout_id.is_none())
            {
                continue;
            }
            let mut ancestor = entry.parent.as_deref();
            let boundary = loop {
                let Some(candidate) = ancestor else {
                    // The whole tree lays out: nothing to defer.
                    return;
                };
                if self.layout_boundary(candidate) {
                    break candidate;
                }
                ancestor = self.entries[candidate].parent.as_deref();
            };
            let plain_text = entry.measure_dirty
                && !entry.layout_dirty
                && !entry.structure_dirty
                && entry.layout_id.is_some()
                && matches!(entry.node.kind.as_str(), "text" | "button");
            if !plain_text {
                verdicts.insert(boundary.to_string(), false);
                continue;
            }
            verdicts.entry(boundary.to_string()).or_insert(true);
            texts.push((id.clone(), boundary.to_string()));
        }
        // A list's rows share their parent's scroll offset: found once.
        let mut offsets: HashMap<String, Vec2> = HashMap::default();
        for (boundary, verdict) in verdicts.iter_mut() {
            if *verdict {
                *verdict = self.offscreen_and_plain(boundary, window, &mut offsets);
            }
        }
        for (text, boundary) in texts {
            if verdicts[&boundary] {
                self.deferred_texts.insert(text);
            }
        }
        self.deferred_boundaries = verdicts
            .into_iter()
            .filter_map(|(boundary, verdict)| verdict.then_some(boundary))
            .collect();
    }

    /// Nothing of the boundary shows in the window, and it holds nothing placed outside the
    /// tree's own painting (a video, a native surface, a text field's caret and IME box).
    pub(super) fn offscreen_and_plain(
        &self,
        boundary: &str,
        window: BoxRect,
        offsets: &mut HashMap<String, Vec2>,
    ) -> bool {
        let Some(entry) = self.entries.get(boundary) else {
            return false;
        };
        // Neither it nor its parent scrolls or is a portal: it shows where its parent's
        // offset puts it (`ancestor_scroll_offset`), which its siblings share.
        let offset = match entry.parent.as_deref() {
            Some(parent)
                if !entry.node.portal
                    && entry.scroll == 0.0
                    && entry.scroll_x == 0.0
                    && self.entries[parent].scroll == 0.0
                    && self.entries[parent].scroll_x == 0.0 =>
            {
                *offsets
                    .entry(parent.to_string())
                    .or_insert_with(|| self.ancestor_scroll_offset(parent))
            }
            _ => self.ancestor_scroll_offset(boundary),
        };
        let rect = entry.rect - offset;
        if rect.x1 > window.x0 && rect.x0 < window.x1 && rect.y1 > window.y0 && rect.y0 < window.y1
        {
            return false;
        }
        // A list row is a handful of nodes; a large subtree is not worth walking.
        let mut stack = vec![boundary];
        let mut walked = 0;
        while let Some(id) = stack.pop() {
            walked += 1;
            let Some(entry) = self.entries.get(id) else {
                return false;
            };
            if walked > 64
                || matches!(
                    entry.node.kind.as_str(),
                    "video" | "surface" | "input" | "textarea"
                )
                || self.focused.as_deref() == Some(id)
            {
                return false;
            }
            stack.extend(entry.children.iter().map(String::as_str));
        }
        true
    }

    /// Shapes the deferred texts now and gives back their boundaries, deferring nothing.
    pub(super) fn prepare_deferred_texts(&mut self) -> Vec<String> {
        let texts = std::mem::take(&mut self.deferred_texts);
        let (text, entries) = (&mut self.text, &self.entries);
        text.prepare_dirty(
            texts
                .iter()
                .filter_map(|id| entries.get(id))
                .filter(|entry| entry.measure_dirty)
                .map(|entry| &*entry.node),
        );
        std::mem::take(&mut self.deferred_boundaries)
    }

    /// Shapes a text again if its layout was dropped offscreen (`TextEngine::evict`).
    pub(crate) fn ensure_text(&mut self, id: &str) {
        if self.text.evicted.contains_key(id)
            && let Some(entry) = self.entries.get(id)
        {
            let node = entry.node.clone();
            self.text.prepare(&node);
        }
    }

    /// Drops the layouts of plain texts far outside the window (more than a window's height
    /// away), keeping their sizes: a long list keeps a few rows' worth of shaped text instead
    /// of all of it (~4.7 KB per label). They are shaped again before they paint, or when a
    /// layout asks for a width they were never measured at. Runs only when texts were shaped
    /// since the last time.
    pub(crate) fn evict_offscreen_texts(&mut self) -> bool {
        if self.text.shapes == self.shapes_at_eviction || self.static_selection.is_some() {
            return false;
        }
        self.shapes_at_eviction = self.text.shapes;
        let Some((width, height)) = self.laid_out_size else {
            return false;
        };
        let (x0, y0) = (f64::from(self.viewport.0), f64::from(self.viewport.1));
        let (w, h) = (f64::from(width), f64::from(height));
        let near = BoxRect::new(x0 - w, y0 - h, x0 + 2.0 * w, y0 + 2.0 * h);
        let mut offsets: HashMap<String, Vec2> = HashMap::default();
        let mut far: Vec<String> = Vec::new();
        for (id, entry) in &self.entries {
            let node = &entry.node;
            if !matches!(node.kind.as_str(), "text" | "button")
                || node.rich.is_some()
                || !node.runs.is_null()
                || node.highlight.is_some()
                || entry.measure_dirty
                || self.focused.as_deref() == Some(id.as_str())
                || !self.text.layouts.contains_key(id)
                || self.text.truncated.contains_key(id)
                || self.text.clamps.contains_key(id)
            {
                continue;
            }
            let offset = match entry.parent.as_deref() {
                Some(parent) => *offsets
                    .entry(parent.to_string())
                    .or_insert_with(|| self.ancestor_scroll_offset(parent)),
                None => Vec2::ZERO,
            };
            let rect = entry.rect - offset;
            if rect.x1 < near.x0 || rect.x0 > near.x1 || rect.y1 < near.y0 || rect.y0 > near.y1 {
                far.push(id.clone());
            }
        }
        let mut evicted = false;
        for id in far {
            evicted |= self.text.evict(&id);
        }
        evicted
    }

    /// Frees the layouts of texts set in place since the last frame (`TextEngine::retired`).
    pub(crate) fn release_retired_text(&mut self) {
        self.text.retired = Vec::new();
    }

    /// Lays out what the last layout left offscreen (`defer_offscreen_texts`), for the frame
    /// after the one that left it: the window loop calls it once that frame is presented, and
    /// every `compute` before laying out anything else.
    pub(crate) fn finish_deferred_layout(&mut self) -> Result<bool, String> {
        if self.deferred_boundaries.is_empty() {
            return Ok(false);
        }
        let boundaries = self.prepare_deferred_texts();
        if !self.lay_out_boundaries(&boundaries)? {
            // A text that measured unlike its box after all: the next layout is a whole one.
            self.dirty.full = true;
            self.dirty.layout = true;
        }
        self.dirty.paint = true;
        Ok(true)
    }
}
