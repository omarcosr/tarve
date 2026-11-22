//! What TextEngine keeps per text across updates: dropping the state of texts gone from
//! the tree, and the shaped layouts of texts far offscreen (kept sizes answer layout).
use super::*;

impl TextEngine {
    pub fn retain(&mut self, mut keep: impl FnMut(&str) -> bool) {
        self.layouts.retain(|id, _| keep(id));
        self.measure_cache.retain(|id, _| keep(id));
        self.markdown_lines.retain(|id, _| keep(id));
        self.markdown_styles.retain(|id, _| keep(id));
        self.markdown_scroll.retain(|(id, _), _| keep(id));
        self.markdown_metrics.retain(|id, _| keep(id));
        self.markdown_block_widths.retain(|id, _| keep(id));
        self.signatures
            .retain(|id, _| self.layouts.contains_key(id));
        self.alignments
            .retain(|id, _| self.layouts.contains_key(id));
        self.shaped_by.retain(|_, id| self.layouts.contains_key(id));
        self.diff_layouts.retain(|id, _| keep(id));
        self.code_gutter_layouts.retain(|id, _| keep(id));
        self.code_gutter_widths.retain(|id, _| keep(id));
        self.code_gutter_styles.retain(|id, _| keep(id));
        self.unwrapped_code.retain(|id| keep(id));
        self.diff_column_widths.retain(|id, _| keep(id));
        self.chunked.retain(|id, _| keep(id));
        self.evicted.retain(|id, _| keep(id));
    }

    /// Drops a plain text's layout, keeping its measured sizes and first baseline (`evicted`).
    /// The layout is shaped again when it is needed. False when there is none to drop.
    pub(crate) fn evict(&mut self, id: &str) -> bool {
        let baseline = self.first_baseline(id);
        let Some(layout) = self.layouts.remove(id) else {
            return false;
        };
        // The recent-shapes cache would keep it alive: dropped there too unless shared.
        if let Some(&(content, style)) = self.signatures.get(id) {
            for button in [false, true] {
                let key = (content, style, button);
                if self.recent.peek(&key).is_some_and(|recent| {
                    Arc::ptr_eq(recent, &layout) && Arc::strong_count(&layout) == 2
                }) {
                    self.recent.pop(&key);
                }
            }
        }
        drop(layout);
        self.drawn.remove(id);
        self.unwrapped.remove(id);
        self.prealigned.remove(id);
        self.evicted.insert(id.to_string(), baseline);
        true
    }

    /// A size `measure` would give without a layout: the cached one, if any.
    pub(crate) fn cached_size(&self, id: &str, width: Option<f32>) -> Option<(f32, f32)> {
        let wrap = if self.nowrap.contains(id) {
            None
        } else {
            width.map(|w| w.max(0.0))
        };
        let cache = self.measure_cache.get(id)?;
        let key = wrap.map(f32::to_bits);
        if let Some((_, size)) = cache.sizes.iter().find(|(width, _)| *width == key) {
            return Some(*size);
        }
        match (wrap, cache.natural) {
            (Some(w), Some((natural, size))) if w >= natural => Some(size),
            (None, Some((_, size))) => Some(size),
            _ => None,
        }
    }
}
