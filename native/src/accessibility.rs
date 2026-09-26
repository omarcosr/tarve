use crate::{
    protocol::{Command, Control, Node as TarveNode},
    tree::Tree,
};
use accesskit::{
    Action, Affine, Invalid, Live, Node as AccessNode, NodeId, Orientation, Rect, Role,
    SortDirection, TextDirection, TextPosition, TextSelection, Toggled, TreeId, TreeInfo,
    TreeUpdate,
};
use accesskit_winit::Adapter;
use std::collections::HashMap;
use unicode_segmentation::UnicodeSegmentation;
use winit::{
    event::WindowEvent,
    event_loop::{ActiveEventLoop, EventLoopProxy},
    window::Window,
};

#[derive(Default)]
struct AccessibilityTree {
    ids: HashMap<String, NodeId>,
    text_ids: HashMap<String, Vec<NodeId>>,
    reverse: HashMap<NodeId, String>,
    text_run_starts: HashMap<NodeId, usize>,
    next_id: u64,
}

#[derive(Clone)]
struct FieldContext {
    label: Option<NodeId>,
    description: Option<NodeId>,
    error: Option<NodeId>,
    description_text: Option<String>,
    error_text: Option<String>,
    required: bool,
}

struct BuiltTextRun {
    id: NodeId,
    node: AccessNode,
    line_index: usize,
    start_character: usize,
    end_character: usize,
}

impl AccessibilityTree {
    fn next_id(&mut self) -> NodeId {
        let id = NodeId(self.next_id);
        self.next_id = self.next_id.saturating_add(1);
        id
    }

    fn native_id_for(&mut self, key: &str) -> NodeId {
        if let Some(id) = self.ids.get(key).copied() {
            self.reverse.insert(id, key.to_string());
            return id;
        }
        let id = self.next_id();
        self.ids.insert(key.to_string(), id);
        self.reverse.insert(id, key.to_string());
        id
    }

    fn text_id_for(&mut self, native_id: &str, line_index: usize) -> NodeId {
        if let Some(id) = self
            .text_ids
            .get(native_id)
            .and_then(|ids| ids.get(line_index))
            .copied()
        {
            self.reverse.insert(id, native_id.to_string());
            return id;
        }
        let id = self.next_id();
        let ids = self.text_ids.entry(native_id.to_string()).or_default();
        while ids.len() < line_index {
            ids.push(NodeId(u64::MAX));
        }
        if ids.len() == line_index {
            ids.push(id);
        } else {
            ids[line_index] = id;
        }
        self.reverse.insert(id, native_id.to_string());
        id
    }

    fn resolve(&self, id: NodeId) -> Option<&str> {
        self.reverse.get(&id).map(String::as_str)
    }

    fn role(node: &TarveNode) -> Role {
        if node.kind == "window" {
            return Role::Window;
        }
        if node.modal {
            return Role::Dialog;
        }
        if let Some(control) = &node.control {
            return match control.role.as_str() {
                "button" => Role::Button,
                "link" => Role::Link,
                "checkbox" => Role::CheckBox,
                "switch" => Role::Switch,
                "radio" => Role::RadioButton,
                "radiogroup" => Role::RadioGroup,
                "tab" => Role::Tab,
                "tablist" => Role::TabList,
                "navigation" => Role::Navigation,
                "menuitem" if control.checked.is_some() => Role::MenuItemCheckBox,
                "menuitem" => Role::MenuItem,
                "tree" => Role::Tree,
                "treeitem" => Role::TreeItem,
                "grid" => Role::Grid,
                "row" => Role::Row,
                "toggle" => Role::Button,
                "togglegroup" => Role::Group,
                "slider" => Role::Slider,
                "progress" => Role::ProgressIndicator,
                "virtualList" => Role::List,
                "select" => Role::ComboBox,
                "group" => Role::Group,
                "field" => Role::Group,
                "alert" => Role::Alert,
                "status" => Role::Status,
                "label" => Role::Label,
                "option" => Role::ListBoxOption,
                "otpSlot" => Role::GenericContainer,
                _ => Role::Unknown,
            };
        }
        match node.kind.as_str() {
            "titlebar" => Role::TitleBar,
            "text" | "markdown" | "code" | "diff" => Role::Label,
            "image" => Role::Image,
            "button" => Role::Button,
            "input" => match node.input_type.as_str() {
                "password" => Role::PasswordInput,
                "email" => Role::EmailInput,
                "number" => Role::NumberInput,
                "search" => Role::SearchInput,
                "tel" => Role::PhoneNumberInput,
                "url" => Role::UrlInput,
                _ => Role::TextInput,
            },
            "textarea" => Role::MultilineTextInput,
            "pressable" if node.focusable => Role::Button,
            "pressable" => Role::GenericContainer,
            "slider" => Role::Slider,
            "splitter" => Role::Splitter,
            "scroll" => Role::ScrollView,
            _ => Role::GenericContainer,
        }
    }

    fn effectively_disabled(tree: &Tree, id: &str) -> bool {
        let mut current = Some(id);
        while let Some(current_id) = current {
            let entry = &tree.entries[current_id];
            if entry.node.disabled {
                return true;
            }
            current = entry.parent.as_deref();
        }
        false
    }

    fn hidden(tree: &Tree, id: &str, modal: Option<&str>) -> bool {
        if tree.is_virtual_parked(id) {
            return true;
        }
        let mut current = Some(id);
        while let Some(current_id) = current {
            let entry = &tree.entries[current_id];
            if entry.node.string("display", "flex") == "none" {
                return true;
            }
            current = entry.parent.as_deref();
        }
        modal.is_some_and(|modal_id| {
            id != tree.root
                && !tree.is_descendant_of(id, modal_id)
                && !tree.is_descendant_of(modal_id, id)
        })
    }

    fn has_scroll_ancestor(tree: &Tree, id: &str) -> bool {
        let mut parent = tree.entries[id].parent.as_deref();
        while let Some(parent_id) = parent {
            let entry = &tree.entries[parent_id];
            if matches!(entry.node.kind.as_str(), "scroll" | "textarea")
                && (entry.scroll_max > 0.0 || entry.scroll_max_x > 0.0)
            {
                return true;
            }
            parent = entry.parent.as_deref();
        }
        false
    }

    fn field_context(&self, tree: &Tree, id: &str) -> Option<FieldContext> {
        let mut parent = tree.entries[id].parent.as_deref();
        while let Some(parent_id) = parent {
            let entry = &tree.entries[parent_id];
            if let Some(control) = &entry.node.control
                && control.role == "field"
                && (control.required
                    || !control.label.is_empty()
                    || !control.description.is_empty()
                    || entry.children.iter().any(|child| {
                        tree.entries[child]
                            .node
                            .control
                            .as_ref()
                            .is_some_and(|child_control| child_control.role == "alert")
                    }))
            {
                let mut label = None;
                let mut description = None;
                let mut error = None;
                let mut description_text = None;
                let mut error_text = None;
                for child in &entry.children {
                    let child_entry = &tree.entries[child];
                    match child_entry
                        .node
                        .control
                        .as_ref()
                        .map(|candidate| candidate.role.as_str())
                    {
                        Some("label") => label = self.ids.get(child).copied(),
                        Some("alert") => {
                            error = self.ids.get(child).copied();
                            error_text = child_entry
                                .node
                                .control
                                .as_ref()
                                .map(|control| control.label.as_str())
                                .filter(|value| !value.is_empty())
                                .or_else(|| {
                                    (!child_entry.node.text.is_empty())
                                        .then_some(child_entry.node.text.as_str())
                                })
                                .map(str::to_string);
                        }
                        None if child_entry.node.kind == "text"
                            && !child_entry.node.text.is_empty() =>
                        {
                            description = self.ids.get(child).copied();
                            description_text = Some(child_entry.node.text.clone());
                        }
                        _ => {}
                    }
                }
                return Some(FieldContext {
                    label,
                    description,
                    error,
                    description_text: description_text.or_else(|| {
                        (!control.description.is_empty()).then(|| control.description.clone())
                    }),
                    error_text,
                    required: control.required,
                });
            }
            parent = entry.parent.as_deref();
        }
        None
    }

    fn is_form_target(node: &TarveNode) -> bool {
        if matches!(node.kind.as_str(), "input" | "textarea" | "slider") {
            return true;
        }
        node.control.as_ref().is_some_and(|control| {
            matches!(
                control.role.as_str(),
                "checkbox"
                    | "switch"
                    | "radio"
                    | "radiogroup"
                    | "select"
                    | "toggle"
                    | "togglegroup"
                    | "slider"
            )
        })
    }

    fn apply_control_state(node: &mut AccessNode, control: &Control) {
        match control.role.as_str() {
            "checkbox" | "switch" | "radio" | "toggle" => {
                if let Some(checked) = control.checked {
                    node.set_toggled(Toggled::from(checked));
                }
            }
            "menuitem" => {
                if let Some(checked) = control.checked {
                    node.set_toggled(Toggled::from(checked));
                }
            }
            _ => {}
        }
        if let Some(selected) = control.selected {
            node.set_selected(selected);
        }
        if let Some(expanded) = control.expanded {
            node.set_expanded(expanded);
        }
        match control.sort_direction.as_str() {
            "ascending" => node.set_sort_direction(SortDirection::Ascending),
            "descending" => node.set_sort_direction(SortDirection::Descending),
            "other" => node.set_sort_direction(SortDirection::Other),
            _ => {}
        }
        match control.orientation.as_str() {
            "horizontal" => node.set_orientation(Orientation::Horizontal),
            "vertical" => node.set_orientation(Orientation::Vertical),
            _ => {}
        }
        if matches!(control.role.as_str(), "slider" | "progress") {
            node.set_numeric_value(control.value);
            node.set_min_numeric_value(control.min);
            node.set_max_numeric_value(control.max);
            node.set_numeric_value_step(control.step);
        }
    }

    fn text_value(node: &TarveNode) -> Option<String> {
        match node.kind.as_str() {
            "input" if node.input_type == "password" => {
                let value = node.value.as_deref().unwrap_or("");
                Some("•".repeat(value.graphemes(true).count()))
            }
            "input" | "textarea" => Some(node.value.clone().unwrap_or_default()),
            _ => None,
        }
    }

    fn character_lengths(value: &str) -> Option<Vec<u8>> {
        value
            .graphemes(true)
            .map(|grapheme| u8::try_from(grapheme.len()).ok())
            .collect()
    }

    fn byte_to_character(value: &str, byte: usize) -> usize {
        let byte = byte.min(value.len());
        value[..byte].grapheme_indices(true).count()
    }

    fn build_text_runs(
        &mut self,
        tree: &mut Tree,
        native_id: &str,
        value: &str,
    ) -> Vec<BuiltTextRun> {
        let lines = tree.accessibility_text_lines(native_id, value);
        let mut runs = Vec::with_capacity(lines.len());
        let mut start_character = 0;
        let word_start_bytes: std::collections::HashSet<usize> =
            value.unicode_word_indices().map(|(byte, _)| byte).collect();

        for line in lines {
            let Some(line_value) = value.get(line.byte_range.clone()) else {
                continue;
            };
            let Some(lengths) = Self::character_lengths(line_value) else {
                continue;
            };
            if lengths.len() != line.character_positions.len()
                || lengths.len() != line.character_widths.len()
            {
                continue;
            }
            let run_id = self.text_id_for(native_id, runs.len());
            let mut run = AccessNode::new(Role::TextRun);
            run.set_value(line_value);
            run.set_character_lengths(lengths.clone());
            run.set_character_positions(line.character_positions);
            run.set_character_widths(line.character_widths);
            run.set_text_direction(if line.right_to_left {
                TextDirection::RightToLeft
            } else {
                TextDirection::LeftToRight
            });
            let word_starts: Option<Vec<u8>> = line_value
                .grapheme_indices(true)
                .enumerate()
                .filter(|(_, (byte, _))| {
                    word_start_bytes.contains(&(line.byte_range.start + *byte))
                })
                .map(|(character, _)| u8::try_from(character).ok())
                .collect();
            if let Some(word_starts) = word_starts.filter(|starts| !starts.is_empty()) {
                run.set_word_starts(word_starts);
            }
            if [line.x0, line.y0, line.x1, line.y1]
                .iter()
                .all(|value| value.is_finite())
            {
                run.set_bounds(Rect {
                    x0: line.x0,
                    y0: line.y0,
                    x1: line.x1,
                    y1: line.y1,
                });
            }
            let end_character = start_character + lengths.len();
            self.text_run_starts.insert(run_id, start_character);
            runs.push(BuiltTextRun {
                id: run_id,
                node: run,
                line_index: line.line_index,
                start_character,
                end_character,
            });
            start_character = end_character;
        }

        for index in 0..runs.len() {
            if index > 0 && runs[index - 1].line_index == runs[index].line_index {
                let previous = runs[index - 1].id;
                runs[index].node.set_previous_on_line(previous);
            }
            if index + 1 < runs.len() && runs[index + 1].line_index == runs[index].line_index {
                let next = runs[index + 1].id;
                runs[index].node.set_next_on_line(next);
            }
        }

        runs
    }

    fn text_position(runs: &[BuiltTextRun], character: usize) -> Option<TextPosition> {
        let last = runs.last()?;
        for (index, run) in runs.iter().enumerate() {
            if character < run.end_character
                || (character == run.end_character
                    && (index + 1 == runs.len() || runs[index + 1].start_character != character))
            {
                return Some(TextPosition {
                    node: run.id,
                    character_index: character
                        .saturating_sub(run.start_character)
                        .min(run.end_character - run.start_character),
                });
            }
        }
        Some(TextPosition {
            node: last.id,
            character_index: last.end_character - last.start_character,
        })
    }

    fn build(&mut self, tree: &mut Tree, title: &str, scale_factor: f64) -> TreeUpdate {
        self.reverse.clear();
        self.text_run_starts.clear();
        let order = tree.order.clone();
        for native_id in &order {
            self.native_id_for(native_id);
        }

        let modal = tree.active_modal().map(str::to_string);
        let root_id = self.ids[&tree.root];
        let mut nodes = Vec::with_capacity(tree.entries.len() * 2);

        for native_id in &order {
            let (
                tarve_node,
                entry_children,
                entry_scroll_x,
                entry_scroll,
                entry_scroll_max_x,
                entry_scroll_max,
            ) = {
                let entry = &tree.entries[native_id];
                (
                    entry.node.clone(),
                    entry.children.clone(),
                    entry.scroll_x,
                    entry.scroll,
                    entry.scroll_max_x,
                    entry.scroll_max,
                )
            };
            let role = Self::role(&tarve_node);
            let id = self.ids[native_id];
            let mut node = AccessNode::new(role);

            if native_id == &tree.root {
                node.set_label(title);
                node.set_transform(Affine::scale(scale_factor));
            }
            if let Some(rect) = tree.visible_rect(native_id)
                && [rect.x0, rect.y0, rect.x1, rect.y1]
                    .iter()
                    .all(|value| value.is_finite())
            {
                node.set_bounds(Rect {
                    x0: rect.x0,
                    y0: rect.y0,
                    x1: rect.x1,
                    y1: rect.y1,
                });
            }

            let mut children: Vec<NodeId> = entry_children
                .iter()
                .filter_map(|child| self.ids.get(child).copied())
                .collect();

            if let Some(control) = &tarve_node.control {
                if !control.label.is_empty() {
                    if control.role == "label" {
                        node.set_value(&control.label);
                    } else {
                        node.set_label(&control.label);
                    }
                }
                if !control.description.is_empty() {
                    node.set_description(&control.description);
                }
                Self::apply_control_state(&mut node, control);
                if !control.group.is_empty()
                    && let Some(group) = self.ids.get(&control.group).copied()
                {
                    node.set_member_of(group);
                    if control.role == "radio" {
                        let radio_group: Vec<NodeId> = order
                            .iter()
                            .filter(|candidate| {
                                tree.entries[*candidate].node.control.as_ref().is_some_and(
                                    |candidate_control| {
                                        candidate_control.role == "radio"
                                            && candidate_control.group == control.group
                                    },
                                )
                            })
                            .filter_map(|candidate| self.ids.get(candidate).copied())
                            .collect();
                        node.set_radio_group(radio_group);
                    }
                }
            }

            if !tarve_node.labelled_by.is_empty() {
                let labels: Vec<NodeId> = tarve_node
                    .labelled_by
                    .iter()
                    .filter_map(|label| self.ids.get(label).copied())
                    .collect();
                if !labels.is_empty() {
                    node.set_labelled_by(labels);
                }
            }

            match tarve_node.kind.as_str() {
                "markdown" if !tarve_node.text.is_empty() => {
                    let value = tarve_node
                        .rich
                        .as_ref()
                        .and_then(|rich| {
                            rich.accessibility_text(&tarve_node.text, 0..tarve_node.text.len())
                        })
                        .unwrap_or_else(|| tarve_node.text.clone());
                    node.set_value(value);
                }
                "text" | "code" | "diff" if !tarve_node.text.is_empty() => {
                    node.set_value(&tarve_node.text)
                }
                "button"
                    if tarve_node
                        .control
                        .as_ref()
                        .is_none_or(|control| control.label.is_empty())
                        && !tarve_node.text.is_empty() =>
                {
                    node.set_label(&tarve_node.text)
                }
                "input" | "textarea" => {
                    if !tarve_node.placeholder.is_empty() {
                        node.set_placeholder(&tarve_node.placeholder);
                    }
                    if let Some(value) = Self::text_value(&tarve_node) {
                        node.set_value(&value);
                        let runs = self.build_text_runs(tree, native_id, &value);
                        children.extend(runs.iter().map(|run| run.id));
                        if !runs.is_empty() {
                            if let Some((anchor, focus)) =
                                tree.accessibility_text_selection(native_id)
                            {
                                let original = tarve_node.value.as_deref().unwrap_or("");
                                let anchor_character = Self::byte_to_character(original, anchor);
                                let focus_character = Self::byte_to_character(original, focus);
                                if let (Some(anchor), Some(focus)) = (
                                    Self::text_position(&runs, anchor_character),
                                    Self::text_position(&runs, focus_character),
                                ) {
                                    node.set_text_selection(TextSelection { anchor, focus });
                                }
                            }
                            nodes.extend(runs.into_iter().map(|run| (run.id, run.node)));
                        }
                    }
                }
                _ => {}
            }

            if !children.is_empty() {
                node.set_children(children);
            }

            if Self::effectively_disabled(tree, native_id) {
                node.set_disabled();
            }
            if Self::hidden(tree, native_id, modal.as_deref())
                || tarve_node
                    .control
                    .as_ref()
                    .is_some_and(|control| control.role == "otpSlot")
            {
                node.set_hidden();
            }
            if tarve_node.modal {
                node.set_modal();
            }
            if matches!(tarve_node.kind.as_str(), "scroll" | "textarea") {
                node.set_clips_children();
                if entry_scroll_max_x > 0.0 {
                    node.set_scroll_x(entry_scroll_x);
                    node.set_scroll_x_min(0.0);
                    node.set_scroll_x_max(entry_scroll_max_x);
                }
                if entry_scroll_max > 0.0 {
                    node.set_scroll_y(entry_scroll);
                    node.set_scroll_y_min(0.0);
                    node.set_scroll_y_max(entry_scroll_max);
                }
            }

            if let Some(control) = &tarve_node.control {
                match control.role.as_str() {
                    "alert" => node.set_live(Live::Assertive),
                    "status" => node.set_live(Live::Polite),
                    _ => {}
                }
            }

            if Self::is_form_target(&tarve_node)
                && let Some(field) = self.field_context(tree, native_id)
            {
                if let Some(label) = field.label {
                    node.set_labelled_by([label]);
                }
                if let Some(description) = field.description {
                    node.set_described_by([description]);
                }
                if let Some(error) = field.error {
                    node.set_error_message(error);
                    node.set_invalid(Invalid::True);
                }
                let fallback_description = field.error_text.or(field.description_text);
                if let Some(field_description) = fallback_description {
                    let existing = tarve_node
                        .control
                        .as_ref()
                        .map(|control| control.description.as_str())
                        .filter(|value| !value.is_empty());
                    if existing != Some(field_description.as_str()) {
                        let combined = existing
                            .map(|value| format!("{value}. {field_description}"))
                            .unwrap_or(field_description);
                        node.set_description(combined);
                    } else {
                        node.set_description(field_description);
                    }
                }
                if field.required {
                    node.set_required();
                }
            }

            if !Self::effectively_disabled(tree, native_id) {
                if tarve_node.focusable && tarve_node.interactive() {
                    node.add_action(Action::Focus);
                }
                let invokable = tarve_node.kind == "button"
                    || (tarve_node.kind == "pressable"
                        && (tarve_node.focusable || tarve_node.control.is_some()));
                if !tarve_node.modal && invokable {
                    node.add_action(Action::Click);
                }
                if matches!(tarve_node.kind.as_str(), "input" | "textarea") {
                    node.add_action(Action::SetValue);
                    node.add_action(Action::ReplaceSelectedText);
                    if tree.user_select_mode(native_id) != crate::tree::UserSelectMode::None {
                        node.add_action(Action::SetTextSelection);
                    }
                }
                if matches!(tarve_node.kind.as_str(), "slider" | "splitter") {
                    node.add_action(Action::SetValue);
                    node.add_action(Action::Increment);
                    node.add_action(Action::Decrement);
                }
                if let Some(expanded) = tarve_node
                    .control
                    .as_ref()
                    .and_then(|control| control.expanded)
                {
                    if expanded {
                        node.add_action(Action::Collapse);
                    } else {
                        node.add_action(Action::Expand);
                    }
                }
                if matches!(tarve_node.kind.as_str(), "scroll" | "textarea")
                    && (entry_scroll_max > 0.0 || entry_scroll_max_x > 0.0)
                {
                    if entry_scroll_max_x > 0.0 {
                        node.add_action(Action::ScrollLeft);
                        node.add_action(Action::ScrollRight);
                    }
                    if entry_scroll_max > 0.0 {
                        node.add_action(Action::ScrollUp);
                        node.add_action(Action::ScrollDown);
                    }
                    node.add_action(Action::SetScrollOffset);
                }
                if Self::has_scroll_ancestor(tree, native_id) {
                    node.add_action(Action::ScrollIntoView);
                }
            }

            nodes.push((id, node));
        }

        let focus = tree
            .focused
            .as_ref()
            .and_then(|focused| self.ids.get(focused).copied())
            .or_else(|| {
                tree.active_modal()
                    .and_then(|modal| self.ids.get(modal).copied())
            })
            .unwrap_or(root_id);
        let mut info = TreeInfo::new(root_id);
        info.toolkit_name = Some("Tarve".into());
        info.toolkit_version = Some(env!("CARGO_PKG_VERSION").into());
        TreeUpdate {
            nodes,
            tree: Some(info),
            tree_id: TreeId::ROOT,
            focus,
        }
    }
}

pub(crate) struct AccessibilityBridge {
    adapter: Adapter,
    tree: AccessibilityTree,
    active: bool,
}

impl AccessibilityBridge {
    pub(crate) fn new(
        event_loop: &ActiveEventLoop,
        window: &Window,
        proxy: EventLoopProxy<Command>,
    ) -> Self {
        let adapter = Adapter::with_event_loop_proxy(event_loop, window, proxy);
        Self {
            adapter,
            tree: AccessibilityTree::default(),
            active: false,
        }
    }

    pub(crate) fn process_event(&mut self, window: &Window, event: &WindowEvent) {
        self.adapter.process_event(window, event);
    }

    pub(crate) fn set_active(&mut self, active: bool) {
        self.active = active;
    }

    pub(crate) fn is_active(&self) -> bool {
        self.active
    }

    pub(crate) fn sync(&mut self, tree: &mut Tree, title: &str, scale_factor: f64) {
        let accessibility_tree = &mut self.tree;
        // Keep the full-tree projection inside this closure: AccessKit only invokes it while
        // a platform accessibility client is active. Building it eagerly makes ordinary input
        // and scroll events O(tree size) even when no UIA client is connected.
        self.adapter
            .update_if_active(|| accessibility_tree.build(tree, title, scale_factor));
    }

    pub(crate) fn resolve(&self, id: NodeId) -> Option<&str> {
        self.tree.resolve(id)
    }

    pub(crate) fn resolve_text_position(&self, position: TextPosition) -> Option<(String, usize)> {
        let native_id = self.tree.resolve(position.node)?.to_string();
        let start = self
            .tree
            .text_run_starts
            .get(&position.node)
            .copied()
            .unwrap_or(0);
        Some((native_id, start.saturating_add(position.character_index)))
    }

    pub(crate) fn text_run_start(&self, id: NodeId) -> Option<usize> {
        self.tree.text_run_starts.get(&id).copied()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::Node as TarveNode;
    use crate::tree::AccessibilityScrollAlignment;
    use serde_json::json;

    fn node(value: serde_json::Value) -> TarveNode {
        serde_json::from_value(value).unwrap()
    }

    #[test]
    fn projects_roles_states_ranges_and_field_relations() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"field","kind":"column","control":{"role":"field","label":"Name","required":true},"children":[
                    {"id":"field-label","kind":"view","control":{"role":"label","label":"Name"},"children":[]},
                    {"id":"name","kind":"input","value":"Marco","placeholder":"Your name","children":[]},
                    {"id":"field-error","kind":"text","text":"Required","control":{"role":"alert","label":"Required"},"children":[]}
                ]},
                {"id":"notes-field","kind":"column","control":{"role":"field","label":"Notes","description":"Extra context"},"children":[
                    {"id":"notes-label","kind":"view","control":{"role":"label","label":"Notes"},"children":[]},
                    {"id":"notes","kind":"textarea","value":"hello","children":[]},
                    {"id":"notes-description","kind":"text","text":"Extra context","children":[]}
                ]},
                {"id":"volume","kind":"slider","control":{"role":"slider","label":"Volume","value":50,"min":0,"max":100,"step":5},"children":[]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(640.0, 480.0).unwrap();
        let _ = tree.focus("name");
        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.5);

        let by_id: HashMap<_, _> = update.nodes.into_iter().collect();
        let input = &by_id[&builder.ids["name"]];
        assert_eq!(input.role(), Role::TextInput);
        assert_eq!(input.labelled_by(), &[builder.ids["field-label"]]);
        assert_eq!(input.error_message(), Some(builder.ids["field-error"]));
        assert_eq!(input.invalid(), Some(Invalid::True));
        assert_eq!(input.description(), Some("Required"));
        assert!(input.is_required());
        assert_eq!(input.placeholder(), Some("Your name"));
        assert!(input.supports_action(Action::SetValue));
        assert!(input.supports_action(Action::SetTextSelection));
        assert!(
            builder.text_ids["name"]
                .iter()
                .any(|id| input.children().contains(id))
        );
        assert_eq!(update.focus, builder.ids["name"]);

        let notes = &by_id[&builder.ids["notes"]];
        assert_eq!(notes.role(), Role::MultilineTextInput);
        assert_eq!(notes.labelled_by(), &[builder.ids["notes-label"]]);
        assert_eq!(notes.described_by(), &[builder.ids["notes-description"]]);
        assert_eq!(notes.description(), Some("Extra context"));

        let slider = &by_id[&builder.ids["volume"]];
        assert_eq!(slider.role(), Role::Slider);
        assert_eq!(slider.numeric_value(), Some(50.0));
        assert_eq!(slider.min_numeric_value(), Some(0.0));
        assert_eq!(slider.max_numeric_value(), Some(100.0));
        assert_eq!(slider.numeric_value_step(), Some(5.0));
    }

    #[test]
    fn user_select_none_removes_accessibility_text_selection_action() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"locked","kind":"input","value":"hello","style":{"userSelect":"none"},"children":[]},
                {"id":"normal","kind":"input","value":"world","style":{"userSelect":"text"},"children":[]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(320.0, 120.0).unwrap();
        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.0);
        let by_id: HashMap<_, _> = update.nodes.into_iter().collect();

        let locked = &by_id[&builder.ids["locked"]];
        assert!(locked.supports_action(Action::SetValue));
        assert!(!locked.supports_action(Action::SetTextSelection));
        let normal = &by_id[&builder.ids["normal"]];
        assert!(normal.supports_action(Action::SetTextSelection));
    }

    #[test]
    fn semantic_link_projects_as_uia_hyperlink_and_is_invokable() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {
                    "id":"docs","kind":"pressable","style":{},"children":[],
                    "control":{"role":"link","label":"Documentation"}
                }
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(320.0, 120.0).unwrap();
        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.0);
        let by_id: HashMap<_, _> = update.nodes.into_iter().collect();
        let link = &by_id[&builder.ids["docs"]];
        assert_eq!(link.role(), Role::Link);
        assert_eq!(link.label(), Some("Documentation"));
        assert!(link.supports_action(Action::Click));
    }

    #[test]
    fn projects_horizontal_scroll_range_and_actions() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"scroll","kind":"scroll","scrollOrientation":"horizontal","style":{"width":100,"height":60},"children":[
                    {"id":"content","kind":"view","style":{"width":400,"height":50,"shrink":0},"children":[]}
                ]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(240.0, 120.0).unwrap();
        tree.pointer_move(20.0, 20.0);
        tree.wheel_2d(32.0, 0.0);

        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.0);
        let by_id: HashMap<_, _> = update.nodes.into_iter().collect();
        let scroll = &by_id[&builder.ids["scroll"]];
        assert_eq!(scroll.role(), Role::ScrollView);
        assert!(scroll.supports_action(Action::ScrollLeft));
        assert!(scroll.supports_action(Action::ScrollRight));
        assert!(!scroll.supports_action(Action::ScrollUp));
        assert!(!scroll.supports_action(Action::ScrollDown));
        assert!(scroll.supports_action(Action::SetScrollOffset));
    }

    #[test]
    fn projects_selected_expanded_sorted_and_checkable_menu_states_without_overloading_checked() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"tab","kind":"pressable","control":{"role":"tab","label":"General","selected":true},"children":[]},
                {"id":"disclosure","kind":"pressable","control":{"role":"button","label":"Details","expanded":false},"children":[]},
                {"id":"sort","kind":"pressable","control":{"role":"button","label":"Sort by name","sortDirection":"descending"},"children":[]},
                {"id":"checked-menu","kind":"pressable","control":{"role":"menuitem","label":"Word wrap","checked":true},"children":[]},
                {"id":"plain-menu","kind":"pressable","control":{"role":"menuitem","label":"Save"},"children":[]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(640.0, 480.0).unwrap();
        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.0);
        let by_id: HashMap<_, _> = update.nodes.into_iter().collect();

        assert_eq!(by_id[&builder.ids["tab"]].is_selected(), Some(true));
        assert_eq!(by_id[&builder.ids["disclosure"]].is_expanded(), Some(false));
        assert_eq!(
            by_id[&builder.ids["sort"]].sort_direction(),
            Some(SortDirection::Descending)
        );
        let checked = &by_id[&builder.ids["checked-menu"]];
        assert_eq!(checked.role(), Role::MenuItemCheckBox);
        assert_eq!(checked.toggled(), Some(Toggled::True));
        assert_eq!(by_id[&builder.ids["plain-menu"]].role(), Role::MenuItem);
    }

    #[test]
    fn modal_scope_hides_background_and_password_never_exposes_plaintext() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"background","kind":"button","text":"Background","children":[]},
                {"id":"dialog","kind":"view","modal":true,"children":[
                    {"id":"secret","kind":"input","inputType":"password","value":"sëcret","children":[]}
                ]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(640.0, 480.0).unwrap();
        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.0);
        assert!(!format!("{update:?}").contains("sëcret"));
        let by_id: HashMap<_, _> = update.nodes.into_iter().collect();
        let background = &by_id[&builder.ids["background"]];
        assert!(background.is_hidden());
        let dialog = &by_id[&builder.ids["dialog"]];
        assert_eq!(dialog.role(), Role::Dialog);
        assert!(dialog.is_modal());
        let secret = &by_id[&builder.ids["secret"]];
        assert_eq!(secret.role(), Role::PasswordInput);
        assert_eq!(secret.value(), Some("••••••"));
        assert!(!format!("{secret:?}").contains("sëcret"));
        assert!(tree.accessibility_click("background").is_empty());
        assert_eq!(update.focus, builder.ids["secret"]);
    }

    #[test]
    fn multiline_text_runs_expose_geometry_and_global_character_offsets() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"notes","kind":"textarea","value":"first\nsecond🙂","style":{"width":120,"height":80},"children":[]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(320.0, 200.0).unwrap();
        let _ = tree.focus("notes");
        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.0);
        let by_id: HashMap<_, _> = update.nodes.into_iter().collect();
        let runs = &builder.text_ids["notes"];
        assert!(
            runs.len() >= 2,
            "hard line break must produce multiple text runs"
        );

        for run_id in runs {
            let run = &by_id[run_id];
            assert_eq!(run.role(), Role::TextRun);
            assert_eq!(
                run.character_lengths().len(),
                run.character_positions().unwrap().len()
            );
            assert_eq!(
                run.character_lengths().len(),
                run.character_widths().unwrap().len()
            );
            assert!(run.text_direction().is_some());
            assert!(run.bounds().is_some());
            assert_eq!(builder.resolve(*run_id), Some("notes"));
        }

        let second = runs[1];
        let second_start = builder.text_run_starts[&second];
        assert!(second_start > 0);
        let local = TextPosition {
            node: second,
            character_index: 2,
        };
        assert_eq!(
            builder.text_run_starts[&local.node] + local.character_index,
            second_start + 2
        );
        tree.accessibility_set_text_selection("notes", second_start + 1, second_start + 3);
        let (anchor, focus) = tree.accessibility_text_selection("notes").unwrap();
        let value = tree.entries["notes"].node.value.as_deref().unwrap();
        assert_eq!(
            AccessibilityTree::byte_to_character(value, anchor),
            second_start + 1
        );
        assert_eq!(
            AccessibilityTree::byte_to_character(value, focus),
            second_start + 3
        );
    }

    #[test]
    fn mixed_bidi_text_uses_directional_runs_linked_on_the_same_visual_line() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"mixed","kind":"input","value":"abc אבג def","style":{"width":260},"children":[]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(320.0, 120.0).unwrap();
        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.0);
        let by_id: HashMap<_, _> = update.nodes.into_iter().collect();
        let runs = &builder.text_ids["mixed"];
        assert!(
            runs.len() >= 3,
            "mixed bidi text should be split into directional runs"
        );
        assert!(
            runs.iter()
                .any(|id| { by_id[id].text_direction() == Some(TextDirection::LeftToRight) })
        );
        assert!(
            runs.iter()
                .any(|id| { by_id[id].text_direction() == Some(TextDirection::RightToLeft) })
        );
        for pair in runs.windows(2) {
            assert_eq!(by_id[&pair[0]].next_on_line(), Some(pair[1]));
            assert_eq!(by_id[&pair[1]].previous_on_line(), Some(pair[0]));
        }
    }

    #[test]
    fn modal_without_focusable_children_is_accessibility_focus_and_blocks_cached_actions() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"background","kind":"button","text":"Background","children":[]},
                {"id":"dialog","kind":"column","modal":true,"control":{"role":"group","label":"Information"},"children":[
                    {"id":"message","kind":"text","text":"Read only","children":[]}
                ]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(320.0, 200.0).unwrap();
        assert!(tree.focused.is_none());
        assert!(tree.accessibility_click("background").is_empty());
        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.0);
        assert_eq!(update.focus, builder.ids["dialog"]);
    }

    #[test]
    fn modal_fallback_focus_uses_normal_text_focus_initialization() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"dialog","kind":"column","modal":true,"children":[
                    {"id":"name","kind":"input","value":"A🙂","children":[]}
                ]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(320.0, 160.0).unwrap();

        assert_eq!(tree.focused.as_deref(), Some("name"));
        let value = tree.entries["name"].node.value.as_deref().unwrap();
        assert_eq!(
            tree.accessibility_text_selection("name"),
            Some((value.len(), value.len()))
        );

        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.0);
        let by_id: HashMap<_, _> = update.nodes.into_iter().collect();
        let selection = by_id[&builder.ids["name"]].text_selection().unwrap();
        assert_eq!(
            builder.text_run_starts[&selection.anchor.node] + selection.anchor.character_index,
            2
        );
        assert_eq!(
            builder.text_run_starts[&selection.focus.node] + selection.focus.character_index,
            2
        );
    }

    #[test]
    fn text_range_scroll_alignment_honors_top_and_bottom_edges() {
        let value = "one\ntwo\nthree\nfour\nfive\nsix";
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"notes","kind":"textarea","value":value,"style":{"width":180,"height":48},"children":[]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(240.0, 120.0).unwrap();
        let byte = value.find("five").unwrap();
        let character = value[..byte].graphemes(true).count();

        tree.accessibility_set_scroll("notes", 0.0, 0.0);
        let top_events = tree.accessibility_scroll_text_position_into_view(
            "notes",
            character,
            Some(AccessibilityScrollAlignment::Top),
        );
        let top = tree.entries["notes"].scroll;
        assert!(!top_events.is_empty());

        tree.accessibility_set_scroll("notes", 0.0, 0.0);
        let bottom_events = tree.accessibility_scroll_text_position_into_view(
            "notes",
            character,
            Some(AccessibilityScrollAlignment::Bottom),
        );
        let bottom = tree.entries["notes"].scroll;
        assert!(!bottom_events.is_empty());
        assert!(
            top > bottom,
            "top alignment must scroll farther than bottom alignment"
        );

        tree.accessibility_set_scroll("notes", 0.0, 0.0);
        tree.accessibility_scroll_text_position_into_view("notes", character, None);
        let minimal = tree.entries["notes"].scroll;
        assert!((minimal - bottom).abs() < 1e-6);
    }

    #[test]
    fn generic_scroll_into_view_keeps_minimal_reveal_behavior() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"scroll","kind":"scroll","style":{"width":180,"height":80},"children":[
                    {"id":"spacer","kind":"view","style":{"height":120,"shrink":0},"children":[]},
                    {"id":"target","kind":"button","text":"Target","style":{"height":30,"shrink":0},"children":[]},
                    {"id":"after","kind":"view","style":{"height":100,"shrink":0},"children":[]}
                ]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(240.0, 160.0).unwrap();

        let before = tree.visible_rect("target").unwrap();
        let viewport = tree.visible_rect("scroll").unwrap();
        assert!(before.y1 > viewport.y1);

        let events = tree.accessibility_scroll_into_view("target");
        assert!(!events.is_empty());
        let target = tree.visible_rect("target").unwrap();
        let viewport = tree.visible_rect("scroll").unwrap();
        assert!((target.y1 - viewport.y1).abs() < 1e-6);
        assert!(target.y0 > viewport.y0);
    }

    #[test]
    fn generic_groups_do_not_create_field_relations() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"dialog","kind":"column","control":{"role":"group","label":"Account","description":"Dialog help"},"children":[
                    {"id":"name","kind":"input","value":"Marco","children":[]}
                ]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(320.0, 160.0).unwrap();
        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.0);
        let by_id: HashMap<_, _> = update.nodes.into_iter().collect();
        let input = &by_id[&builder.ids["name"]];
        assert!(input.labelled_by().is_empty());
        assert!(input.described_by().is_empty());
        assert_eq!(input.description(), None);
    }

    #[test]
    fn explicit_labelled_by_projects_intrinsic_label_relations() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"email-label","kind":"view","control":{"role":"label","label":"Email address"},"children":[]},
                {"id":"email","kind":"input","inputType":"email","labelledBy":["email-label"],"children":[]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(320.0, 160.0).unwrap();
        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.0);
        let by_id: HashMap<_, _> = update.nodes.into_iter().collect();
        let input = &by_id[&builder.ids["email"]];
        assert_eq!(input.role(), Role::EmailInput);
        assert_eq!(input.labelled_by(), &[builder.ids["email-label"]]);
    }

    #[test]
    fn accessibility_value_changes_remain_controlled_by_reconciliation() {
        let root = |value: &str| {
            node(json!({
                "id":"root","kind":"window","children":[
                    {"id":"field","kind":"input","value":value,"children":[]}
                ]
            }))
        };
        let mut tree = Tree::new(root("before"));
        tree.compute(320.0, 120.0).unwrap();
        let events = tree.accessibility_set_text_value("field", "requested");
        assert_eq!(events[0]["value"], "requested");
        assert_eq!(
            tree.entries["field"].node.value.as_deref(),
            Some("requested")
        );

        tree.update(root("controlled"));
        assert_eq!(
            tree.entries["field"].node.value.as_deref(),
            Some("controlled")
        );
    }

    #[test]
    fn synthetic_text_ids_cannot_collide_with_user_node_ids() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"field","kind":"input","value":"text","children":[]},
                {"id":"field::accesskit-text","kind":"button","text":"Real node","children":[]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(640.0, 480.0).unwrap();
        let mut builder = AccessibilityTree::default();
        let update = builder.build(&mut tree, "Example", 1.0);
        let real = builder.ids["field::accesskit-text"];
        let synthetic = builder.text_ids["field"][0];
        assert_ne!(real, synthetic);
        let mut ids: Vec<_> = update.nodes.iter().map(|(id, _)| *id).collect();
        ids.sort_by_key(|id| id.0);
        ids.dedup();
        assert_eq!(ids.len(), update.nodes.len());
    }

    #[test]
    fn accessibility_edit_actions_use_grapheme_selection_and_native_validation() {
        let root = node(json!({
            "id":"root","kind":"window","children":[
                {"id":"text","kind":"input","value":"A🙂B","children":[]},
                {"id":"number","kind":"input","inputType":"number","value":"12","children":[]},
                {"id":"volume","kind":"slider","control":{"role":"slider","value":5,"min":0,"max":10,"step":1},"children":[]}
            ]
        }));
        let mut tree = Tree::new(root);
        tree.compute(640.0, 480.0).unwrap();
        let _ = tree.focus("text");
        assert!(
            tree.accessibility_set_text_selection("text", 1, 2)
                .is_empty()
        );
        let events = tree.accessibility_replace_selected_text("text", "é");
        assert_eq!(tree.entries["text"].node.value.as_deref(), Some("AéB"));
        assert_eq!(events[0]["type"], "change");
        assert_eq!(events[0]["value"], "AéB");

        assert!(
            tree.accessibility_set_text_value("number", "12x")
                .is_empty()
        );
        assert_eq!(tree.entries["number"].node.value.as_deref(), Some("12"));

        let events = tree.accessibility_set_numeric_value("volume", 8.0);
        assert_eq!(events[0]["type"], "valueChange");
        assert_eq!(events[0]["value"], 8.0);
    }
}
