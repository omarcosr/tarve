//! CSS inheritance the tree resolves: `currentColor` and `pointer-events`.
use super::*;

impl Tree {
    /// `own`, the node's foreground; CSS `currentColor` takes the nearest ancestor's
    /// (in its hover / group-hover state), so an icon follows its button.
    pub(crate) fn current_foreground(&self, id: &str, own: &str) -> String {
        if !own.eq_ignore_ascii_case("currentColor") {
            return own.to_string();
        }
        let mut current = self
            .entries
            .get(id)
            .and_then(|entry| entry.parent.as_deref());
        while let Some(key) = current {
            let Some(entry) = self.entries.get(key) else {
                break;
            };
            let state = self.visual_state_for(key, &entry.node);
            let value = visual_string(&entry.node, "foreground", "", state);
            if !value.is_empty() && !value.eq_ignore_ascii_case("currentColor") {
                return value.to_string();
            }
            current = entry.parent.as_deref();
        }
        "#18181b".to_string()
    }

    /// CSS `pointer-events` inherits: a box without its own value takes its parent's, so
    /// `none` mutes a subtree except descendants that set `auto` (or another value).
    pub(super) fn pointer_muted(node: &Node, inherited: bool) -> bool {
        match node.style.get("pointerEvents").and_then(Value::as_str) {
            Some(value) => value == "none",
            None => inherited,
        }
    }

    /// Whether `id`'s parent chain leaves it muted (a portal hit-tested on its own).
    pub(super) fn pointer_muted_above(&self, id: &str) -> bool {
        let mut chain = Vec::new();
        let mut current = self
            .entries
            .get(id)
            .and_then(|entry| entry.parent.as_deref());
        while let Some(key) = current {
            chain.push(key);
            current = self
                .entries
                .get(key)
                .and_then(|entry| entry.parent.as_deref());
        }
        chain.iter().rev().fold(false, |muted, key| {
            Self::pointer_muted(&self.entries[*key].node, muted)
        })
    }
}
