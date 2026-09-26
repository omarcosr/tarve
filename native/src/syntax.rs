use std::{
    collections::{HashMap, VecDeque},
    hash::{Hash, Hasher},
    ops::Range,
    path::Path,
    sync::{Arc, Mutex, OnceLock},
};

use syntect::{
    easy::ScopeRangeIterator,
    parsing::{ParseState, ScopeStack, SyntaxReference, SyntaxSet},
};

pub const DEFAULT_MAX_SOURCE_BYTES: usize = 512 * 1024;
pub const DEFAULT_MAX_SPANS: usize = 200_000;
const MAX_CACHE_DOCUMENTS: usize = 96;
const MAX_CACHE_BYTES: usize = 24 * 1024 * 1024;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum LanguageId {
    Rust,
    JavaScript,
    Jsx,
    TypeScript,
    Tsx,
    Python,
    Go,
    Json,
    Jsonc,
    Bash,
    Toml,
    Markdown,
    Html,
    Css,
    Yaml,
    C,
    Cpp,
    CSharp,
    Java,
    Kotlin,
    Swift,
    Sql,
    Xml,
    Dockerfile,
    PowerShell,
    Lua,
    Ruby,
    Php,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum HighlightKind {
    Comment,
    Keyword,
    String,
    StringSpecial,
    Escape,
    Number,
    Boolean,
    Type,
    TypeBuiltin,
    Constructor,
    Function,
    FunctionBuiltin,
    Macro,
    Property,
    Constant,
    Variable,
    VariableSpecial,
    Parameter,
    Operator,
    Punctuation,
    Tag,
    Attribute,
    Label,
    Embedded,
    Invalid,
}

impl HighlightKind {
    fn precedence(self) -> u8 {
        match self {
            Self::Invalid => 100,
            Self::Escape => 95,
            Self::Macro => 90,
            Self::Property | Self::Attribute => 85,
            Self::FunctionBuiltin | Self::TypeBuiltin | Self::VariableSpecial => 80,
            Self::StringSpecial | Self::Constructor | Self::Parameter => 75,
            Self::Function | Self::Type | Self::Constant | Self::Tag | Self::Label => 70,
            Self::Comment | Self::Keyword | Self::String | Self::Number | Self::Boolean => 60,
            Self::Variable | Self::Operator => 50,
            Self::Punctuation | Self::Embedded => 40,
        }
    }

    pub fn key(self) -> &'static str {
        match self {
            Self::Comment => "comment",
            Self::Keyword => "keyword",
            Self::String => "string",
            Self::StringSpecial => "stringSpecial",
            Self::Escape => "escape",
            Self::Number => "number",
            Self::Boolean => "boolean",
            Self::Type => "typeName",
            Self::TypeBuiltin => "typeBuiltin",
            Self::Constructor => "constructor",
            Self::Function => "function",
            Self::FunctionBuiltin => "functionBuiltin",
            Self::Macro => "macro",
            Self::Property => "property",
            Self::Constant => "constant",
            Self::Variable => "variable",
            Self::VariableSpecial => "variableSpecial",
            Self::Parameter => "parameter",
            Self::Operator => "operator",
            Self::Punctuation => "punctuation",
            Self::Tag => "tag",
            Self::Attribute => "attribute",
            Self::Label => "label",
            Self::Embedded => "embedded",
            Self::Invalid => "invalid",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HighlightSpan {
    pub range: Range<usize>,
    pub kind: HighlightKind,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HighlightedDocument {
    pub language: LanguageId,
    pub lines: Vec<Vec<HighlightSpan>>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
struct CacheKey {
    language: LanguageId,
    source_hash: u64,
    source_len: usize,
}

struct CachedDocument {
    retained_bytes: usize,
    document: Arc<HighlightedDocument>,
}

#[derive(Default)]
struct SyntaxCache {
    documents: HashMap<CacheKey, CachedDocument>,
    recency: VecDeque<CacheKey>,
    retained_bytes: usize,
}

impl SyntaxCache {
    fn get(&mut self, key: CacheKey) -> Option<Arc<HighlightedDocument>> {
        let document = self.documents.get(&key)?.document.clone();
        self.touch(key);
        Some(document)
    }

    fn insert(&mut self, key: CacheKey, document: Arc<HighlightedDocument>) {
        if let Some(previous) = self.documents.remove(&key) {
            self.retained_bytes = self.retained_bytes.saturating_sub(previous.retained_bytes);
        }
        let spans = document.lines.iter().map(Vec::len).sum::<usize>();
        let retained_bytes = std::mem::size_of::<HighlightedDocument>()
            + document.lines.len() * std::mem::size_of::<Vec<HighlightSpan>>()
            + spans * std::mem::size_of::<HighlightSpan>();
        if retained_bytes > MAX_CACHE_BYTES {
            return;
        }
        self.retained_bytes = self.retained_bytes.saturating_add(retained_bytes);
        self.documents.insert(
            key,
            CachedDocument {
                retained_bytes,
                document,
            },
        );
        self.touch(key);
        while self.documents.len() > MAX_CACHE_DOCUMENTS || self.retained_bytes > MAX_CACHE_BYTES {
            let Some(oldest) = self.recency.pop_front() else {
                break;
            };
            if let Some(removed) = self.documents.remove(&oldest) {
                self.retained_bytes = self.retained_bytes.saturating_sub(removed.retained_bytes);
            }
        }
    }

    fn touch(&mut self, key: CacheKey) {
        self.recency.retain(|candidate| *candidate != key);
        self.recency.push_back(key);
    }
}

fn global_cache() -> &'static Mutex<SyntaxCache> {
    static CACHE: OnceLock<Mutex<SyntaxCache>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(SyntaxCache::default()))
}

fn hash64(value: &str) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    value.hash(&mut hasher);
    hasher.finish()
}

fn syntax_set() -> &'static SyntaxSet {
    static SYNTAXES: OnceLock<SyntaxSet> = OnceLock::new();
    SYNTAXES.get_or_init(two_face::syntax::extra_newlines)
}

pub fn detect_language(
    explicit: Option<&str>,
    path: Option<&str>,
    first_line: Option<&str>,
) -> Option<LanguageId> {
    explicit
        .and_then(language_for_alias)
        .or_else(|| path.and_then(language_for_path))
        .or_else(|| first_line.and_then(language_for_shebang))
}

pub fn language_for_alias(alias: &str) -> Option<LanguageId> {
    let alias = alias
        .trim()
        .split_ascii_whitespace()
        .next()?
        .trim_start_matches('.')
        .to_ascii_lowercase();
    Some(match alias.as_str() {
        "rust" | "rs" => LanguageId::Rust,
        "javascript" | "js" | "mjs" | "cjs" => LanguageId::JavaScript,
        "jsx" => LanguageId::Jsx,
        "typescript" | "ts" | "mts" | "cts" => LanguageId::TypeScript,
        "tsx" => LanguageId::Tsx,
        "python" | "py" | "python3" => LanguageId::Python,
        "go" | "golang" => LanguageId::Go,
        "json" => LanguageId::Json,
        "jsonc" => LanguageId::Jsonc,
        "bash" | "sh" | "shell" | "zsh" | "console" => LanguageId::Bash,
        "toml" => LanguageId::Toml,
        "markdown" | "md" => LanguageId::Markdown,
        "html" | "htm" => LanguageId::Html,
        "css" => LanguageId::Css,
        "yaml" | "yml" => LanguageId::Yaml,
        "c" | "h" => LanguageId::C,
        "cpp" | "c++" | "cc" | "cxx" | "hpp" => LanguageId::Cpp,
        "csharp" | "c#" | "cs" => LanguageId::CSharp,
        "java" => LanguageId::Java,
        "kotlin" | "kt" | "kts" => LanguageId::Kotlin,
        "swift" => LanguageId::Swift,
        "sql" => LanguageId::Sql,
        "xml" => LanguageId::Xml,
        "docker" | "dockerfile" => LanguageId::Dockerfile,
        "powershell" | "ps1" | "pwsh" => LanguageId::PowerShell,
        "lua" => LanguageId::Lua,
        "ruby" | "rb" => LanguageId::Ruby,
        "php" => LanguageId::Php,
        _ => return None,
    })
}

fn language_for_path(path: &str) -> Option<LanguageId> {
    let path = Path::new(path);
    let file_name = path.file_name()?.to_str()?.to_ascii_lowercase();
    if file_name == "dockerfile" {
        return Some(LanguageId::Dockerfile);
    }
    if matches!(
        file_name.as_str(),
        "cargo.toml" | "cargo.lock" | "pyproject.toml"
    ) {
        return Some(LanguageId::Toml);
    }
    language_for_alias(path.extension()?.to_str()?)
}

fn language_for_shebang(line: &str) -> Option<LanguageId> {
    let line = line.strip_prefix("#!")?.to_ascii_lowercase();
    if line.contains("python") {
        Some(LanguageId::Python)
    } else if line.contains("node") || line.contains("deno") || line.contains("bun") {
        Some(LanguageId::JavaScript)
    } else if line.contains("ruby") {
        Some(LanguageId::Ruby)
    } else if line.contains("php") {
        Some(LanguageId::Php)
    } else if line.contains("pwsh") || line.contains("powershell") {
        Some(LanguageId::PowerShell)
    } else if ["bash", "zsh", "/sh", " sh"]
        .iter()
        .any(|name| line.contains(name))
    {
        Some(LanguageId::Bash)
    } else {
        None
    }
}

fn syntax_for_language(language: LanguageId) -> Option<&'static SyntaxReference> {
    let set = syntax_set();
    let (names, extensions): (&[&str], &[&str]) = match language {
        LanguageId::Rust => (&["Rust"], &["rs"]),
        LanguageId::JavaScript => (&["JavaScript", "JavaScript (Babel)"], &["js"]),
        LanguageId::Jsx => (&["TypeScriptReact", "JavaScript (Babel)"], &["jsx", "tsx"]),
        LanguageId::TypeScript => (&["TypeScript"], &["ts"]),
        LanguageId::Tsx => (&["TypeScriptReact"], &["tsx"]),
        LanguageId::Python => (&["Python"], &["py"]),
        LanguageId::Go => (&["Go"], &["go"]),
        LanguageId::Json => (&["JSON"], &["json"]),
        LanguageId::Jsonc => (&["JSON with Comments", "JSONC", "JSON"], &["jsonc", "json"]),
        LanguageId::Bash => (&["Bourne Again Shell (bash)", "Bash"], &["sh", "bash"]),
        LanguageId::Toml => (&["TOML"], &["toml"]),
        LanguageId::Markdown => (&["Markdown"], &["md"]),
        LanguageId::Html => (&["HTML"], &["html"]),
        LanguageId::Css => (&["CSS"], &["css"]),
        LanguageId::Yaml => (&["YAML"], &["yaml", "yml"]),
        LanguageId::C => (&["C"], &["c"]),
        LanguageId::Cpp => (&["C++"], &["cpp", "cc", "cxx"]),
        LanguageId::CSharp => (&["C#"], &["cs"]),
        LanguageId::Java => (&["Java"], &["java"]),
        LanguageId::Kotlin => (&["Kotlin"], &["kt"]),
        LanguageId::Swift => (&["Swift"], &["swift"]),
        LanguageId::Sql => (&["SQL"], &["sql"]),
        LanguageId::Xml => (&["XML"], &["xml"]),
        LanguageId::Dockerfile => (&["Dockerfile"], &["dockerfile"]),
        LanguageId::PowerShell => (&["PowerShell"], &["ps1"]),
        LanguageId::Lua => (&["Lua"], &["lua"]),
        LanguageId::Ruby => (&["Ruby", "Ruby on Rails"], &["rb"]),
        LanguageId::Php => (&["PHP"], &["php"]),
    };
    names
        .iter()
        .find_map(|name| set.find_syntax_by_name(name))
        .or_else(|| {
            extensions
                .iter()
                .find_map(|ext| set.find_syntax_by_extension(ext))
        })
}

const SCOPE_PREFIXES: &[(&str, HighlightKind)] = &[
    ("entity.other.attribute-name", HighlightKind::Attribute),
    ("support.type.property-name", HighlightKind::Property),
    ("constant.character.escape", HighlightKind::Escape),
    ("entity.name.function.macro", HighlightKind::Macro),
    ("constant.language.boolean", HighlightKind::Boolean),
    ("entity.name.constructor", HighlightKind::Constructor),
    ("meta.object-literal.key", HighlightKind::Property),
    ("support.function.builtin", HighlightKind::FunctionBuiltin),
    ("variable.other.property", HighlightKind::Property),
    ("variable.other.constant", HighlightKind::Constant),
    ("support.class.builtin", HighlightKind::TypeBuiltin),
    ("entity.name.interface", HighlightKind::Type),
    ("entity.name.namespace", HighlightKind::Type),
    ("entity.name.function", HighlightKind::Function),
    ("variable.other.member", HighlightKind::Property),
    ("string.interpolated", HighlightKind::StringSpecial),
    ("constant.character", HighlightKind::Escape),
    ("variable.parameter", HighlightKind::Parameter),
    ("constant.language", HighlightKind::Boolean),
    ("entity.name.struct", HighlightKind::Type),
    ("variable.language", HighlightKind::VariableSpecial),
    ("constant.numeric", HighlightKind::Number),
    ("entity.name.class", HighlightKind::Type),
    ("entity.name.label", HighlightKind::Label),
    ("entity.name.macro", HighlightKind::Macro),
    ("entity.name.trait", HighlightKind::Type),
    ("keyword.operator", HighlightKind::Operator),
    ("meta.mapping.key", HighlightKind::Property),
    ("storage.modifier", HighlightKind::Keyword),
    ("string.quoted.other", HighlightKind::StringSpecial),
    ("support.constant", HighlightKind::Constant),
    ("support.function", HighlightKind::FunctionBuiltin),
    ("constant.other", HighlightKind::Constant),
    ("entity.name.enum", HighlightKind::Type),
    ("entity.name.tag", HighlightKind::Tag),
    ("entity.name.type", HighlightKind::Type),
    ("keyword.control", HighlightKind::Keyword),
    ("string.unquoted", HighlightKind::StringSpecial),
    ("meta.embedded", HighlightKind::Embedded),
    ("string.escape", HighlightKind::Escape),
    ("string.regexp", HighlightKind::StringSpecial),
    ("support.class", HighlightKind::TypeBuiltin),
    ("support.macro", HighlightKind::Macro),
    ("storage.type", HighlightKind::Keyword),
    ("support.type", HighlightKind::TypeBuiltin),
    ("punctuation", HighlightKind::Punctuation),
    ("variable", HighlightKind::Variable),
    ("function", HighlightKind::Function),
    ("operator", HighlightKind::Operator),
    ("property", HighlightKind::Property),
    ("constant", HighlightKind::Constant),
    ("keyword", HighlightKind::Keyword),
    ("storage", HighlightKind::Keyword),
    ("boolean", HighlightKind::Boolean),
    ("comment", HighlightKind::Comment),
    ("invalid", HighlightKind::Invalid),
    ("string", HighlightKind::String),
    ("markup", HighlightKind::Embedded),
    ("number", HighlightKind::Number),
    ("label", HighlightKind::Label),
    ("type", HighlightKind::Type),
];

fn scope_matches(name: &str, prefix: &str) -> bool {
    name == prefix
        || (name.len() > prefix.len()
            && name.starts_with(prefix)
            && name.as_bytes()[prefix.len()] == b'.')
}

fn kind_for_scope_name(name: &str) -> Option<HighlightKind> {
    SCOPE_PREFIXES
        .iter()
        .find(|(prefix, _)| scope_matches(name, prefix))
        .map(|(_, kind)| *kind)
}

fn kind_for_stack(stack: &ScopeStack) -> Option<HighlightKind> {
    let mut best = None;
    for scope in stack.as_slice() {
        let Some(kind) = kind_for_scope_name(&scope.build_string()) else {
            continue;
        };
        if best.is_none_or(|previous: HighlightKind| kind.precedence() >= previous.precedence()) {
            best = Some(kind);
        }
    }
    best
}

fn highlight(language: LanguageId, source: &str) -> Option<HighlightedDocument> {
    if source.len() > DEFAULT_MAX_SOURCE_BYTES {
        return None;
    }
    let syntax = syntax_for_language(language)?;
    let set = syntax_set();
    let mut parse_state = ParseState::new(syntax);
    let mut stack = ScopeStack::new();
    let mut lines = Vec::with_capacity(source.lines().count().max(1));
    let mut total_spans = 0usize;

    if source.is_empty() {
        lines.push(Vec::new());
        return Some(HighlightedDocument { language, lines });
    }

    for line in source.split_inclusive('\n') {
        let operations = parse_state.parse_line(line, set).ok()?;
        let mut spans = Vec::new();
        for (range, operation) in ScopeRangeIterator::new(&operations, line) {
            stack.apply(operation).ok()?;
            if range.is_empty() {
                continue;
            }
            let Some(kind) = kind_for_stack(&stack) else {
                continue;
            };
            spans.push(HighlightSpan { range, kind });
            total_spans += 1;
            if total_spans > DEFAULT_MAX_SPANS {
                return None;
            }
        }
        lines.push(spans);
    }
    Some(HighlightedDocument { language, lines })
}

pub fn highlight_cached(
    source: &str,
    explicit_language: Option<&str>,
    path: Option<&str>,
) -> Option<Arc<HighlightedDocument>> {
    let language = detect_language(explicit_language, path, source.lines().next())?;
    let key = CacheKey {
        language,
        source_hash: hash64(source),
        source_len: source.len(),
    };
    if let Ok(mut cache) = global_cache().lock()
        && let Some(document) = cache.get(key)
    {
        return Some(document);
    }
    let document = Arc::new(highlight(language, source)?);
    if let Ok(mut cache) = global_cache().lock() {
        cache.insert(key, document.clone());
    }
    Some(document)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_explicit_path_and_shebang_languages() {
        assert_eq!(
            detect_language(Some("tsx"), Some("a.rs"), None),
            Some(LanguageId::Tsx)
        );
        assert_eq!(
            detect_language(None, Some("Cargo.toml"), None),
            Some(LanguageId::Toml)
        );
        assert_eq!(
            detect_language(None, None, Some("#!/usr/bin/env python3")),
            Some(LanguageId::Python)
        );
    }

    #[test]
    fn typescript_and_tsx_are_available_in_the_extended_syntax_set() {
        let ts = highlight_cached("const value: string = 'ok';", Some("ts"), None).unwrap();
        assert_eq!(ts.language, LanguageId::TypeScript);
        assert!(
            ts.lines
                .iter()
                .flatten()
                .any(|span| span.kind == HighlightKind::Keyword)
        );

        let tsx = highlight_cached("const el = <Button value={1} />;", Some("tsx"), None).unwrap();
        assert_eq!(tsx.language, LanguageId::Tsx);
        assert!(!tsx.lines.is_empty());
    }

    #[test]
    fn pathological_sources_fall_back_to_plain_text() {
        let source = "x".repeat(DEFAULT_MAX_SOURCE_BYTES + 1);
        assert!(highlight_cached(&source, Some("js"), None).is_none());
    }

    #[test]
    fn repeated_documents_reuse_the_same_cached_arc() {
        let source = "fn cache_probe() -> u32 { 7 }";
        let first = highlight_cached(source, Some("rust"), None).unwrap();
        let second = highlight_cached(source, Some("rust"), None).unwrap();
        assert!(Arc::ptr_eq(&first, &second));
    }
}
