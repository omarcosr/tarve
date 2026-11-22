//! Node styles as the protocol carries them: interned (equal styles are one allocation), and
//! the first document's style table (each style written once, nodes naming theirs by index).
use super::*;

/// A node's style from its JSON: a style object, or an index into the document's style table.
pub(super) fn node_style(value: Value) -> Result<NodeStyle, String> {
    match value.as_u64() {
        Some(index) => STYLE_TABLE.with(|table| {
            table
                .borrow()
                .get(index as usize)
                .cloned()
                .ok_or_else(|| format!("style {index} is not in the document's style table"))
        }),
        None => Ok(NodeStyle::new(value)),
    }
}

/// The document's root, then the style table let go: it serves only this document's nodes.
pub(super) fn root_then_clear<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Node, D::Error> {
    let root = Node::deserialize(deserializer);
    clear_style_table();
    root
}

thread_local! {
    /// The style table of the document being parsed (`Document::styles`), for its nodes'
    /// numeric styles. JSON writes it before the root, so it is filled before any node.
    static STYLE_TABLE: std::cell::RefCell<Vec<NodeStyle>> = const { std::cell::RefCell::new(Vec::new()) };
}

/// Fills the style table from a document's `styles` (see `STYLE_TABLE`).
pub(super) fn install_style_table<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<(), D::Error> {
    let styles = Vec::<Value>::deserialize(deserializer)?;
    STYLE_TABLE
        .with(|table| *table.borrow_mut() = styles.into_iter().map(NodeStyle::new).collect());
    Ok(())
}

/// Lets go of the last document's style table once it is parsed.
pub(crate) fn clear_style_table() {
    STYLE_TABLE.with(|table| *table.borrow_mut() = Vec::new());
}

/// Live styles by content hash. Entries are weak: a style no node uses any
/// more is freed, and its slot is swept once the table doubles.
struct StyleInterner {
    styles: std::collections::HashMap<u64, (std::sync::Weak<Value>, u128)>,
    sweep_at: usize,
}

/// The shared style equal to `value`, and the Bloom filter of its keys.
pub(super) fn intern_style(value: Value) -> (Arc<Value>, u128) {
    if !value.as_object().is_some_and(|map| !map.is_empty()) {
        return (Arc::new(value), 0);
    }
    static STYLES: std::sync::Mutex<Option<StyleInterner>> = std::sync::Mutex::new(None);
    let hash = {
        let mut hasher = std::hash::DefaultHasher::new();
        hash_value(&value, &mut hasher);
        std::hash::Hasher::finish(&hasher)
    };
    let Ok(mut guard) = STYLES.lock() else {
        let bits = style_bits(&value);
        return (Arc::new(value), bits);
    };
    let interner = guard.get_or_insert_with(|| StyleInterner {
        styles: std::collections::HashMap::new(),
        sweep_at: 1024,
    });
    if let Some((shared, bits)) = interner
        .styles
        .get(&hash)
        .and_then(|(style, bits)| Some((style.upgrade()?, *bits)))
        && *shared == value
    {
        return (shared, bits);
    }
    let bits = style_bits(&value);
    let shared = Arc::new(value);
    interner
        .styles
        .insert(hash, (Arc::downgrade(&shared), bits));
    if interner.styles.len() >= interner.sweep_at {
        interner
            .styles
            .retain(|_, (style, _)| style.strong_count() > 0);
        interner.sweep_at = (interner.styles.len() * 2).max(1024);
    }
    (shared, bits)
}
