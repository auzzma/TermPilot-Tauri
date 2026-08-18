use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;

use flate2::read::DeflateDecoder;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, State};

#[derive(Deserialize)]
struct Entry {
    offset: usize,
    length: usize,
}

#[derive(Deserialize)]
struct Header {
    commands: Vec<String>,
    entries: HashMap<String, Entry>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutocompleteSuggestion {
    text: String,
    display_text: String,
    detail: Option<String>,
    source: &'static str,
    score: f64,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AutocompleteSpecResult {
    suggestions: Vec<AutocompleteSuggestion>,
    path_requirement: Option<&'static str>,
}

pub struct AutocompleteCatalog {
    data: Vec<u8>,
    payload_offset: usize,
    header: Header,
    cache: Mutex<HashMap<String, Value>>,
}

impl AutocompleteCatalog {
    pub fn load(app: &AppHandle) -> Self {
        let resource_directory = app.path().resource_dir().ok();
        let candidates = resource_directory
            .as_ref()
            .map(|root| root.join("AutocompleteSpecs.bundledata"))
            .into_iter()
            .chain(
                development_source_root()
                    .map(|root| root.join("public/AutocompleteSpecs.bundledata")),
            );
        let path = candidates.into_iter().find(|candidate| candidate.is_file());
        let Some(path) = path else {
            return Self::empty();
        };
        let Ok(data) = fs::read(path) else {
            return Self::empty();
        };
        Self::from_data(data).unwrap_or_else(Self::empty)
    }

    fn from_data(data: Vec<u8>) -> Option<Self> {
        if data.len() < 4 {
            return None;
        }
        let header_length = u32::from_be_bytes([data[0], data[1], data[2], data[3]]) as usize;
        let payload_offset = 4 + header_length;
        if payload_offset > data.len() {
            return None;
        }
        let header = serde_json::from_slice(&data[4..payload_offset]).ok()?;
        Some(Self {
            data,
            payload_offset,
            header,
            cache: Mutex::new(HashMap::new()),
        })
    }

    fn empty() -> Self {
        Self {
            data: Vec::new(),
            payload_offset: 0,
            header: Header {
                commands: Vec::new(),
                entries: HashMap::new(),
            },
            cache: Mutex::new(HashMap::new()),
        }
    }

    fn suggestions(&self, input: &str, maximum: usize) -> AutocompleteSpecResult {
        let context = CommandLine::parse(input);
        if context.word_index == 0 {
            if self.header.commands.contains(&context.command_name) {
                let Some(spec) = self.spec(&context.command_name) else {
                    return AutocompleteSpecResult::default();
                };
                return AutocompleteSpecResult {
                    suggestions: preview_suggestions(&spec, &context.input, maximum),
                    path_requirement: path_requirement(arguments(&spec)),
                };
            }
            let suggestions = self
                .header
                .commands
                .iter()
                .filter(|command| {
                    command.starts_with(&context.current_word) && *command != &context.current_word
                })
                .take(maximum)
                .map(|command| AutocompleteSuggestion {
                    text: context.replacing_current_word(command),
                    display_text: command.clone(),
                    detail: None,
                    source: "command",
                    score: 600.0,
                })
                .collect();
            return AutocompleteSpecResult {
                suggestions,
                path_requirement: None,
            };
        }
        let Some(spec) = self.spec(&context.command_name) else {
            return AutocompleteSpecResult::default();
        };
        let consumed_end = context.tokens.len().saturating_sub(1);
        let resolved = resolve_context(spec, &context.tokens[1..consumed_end]);
        let mut result = AutocompleteSpecResult {
            suggestions: Vec::new(),
            path_requirement: path_requirement(resolved.arguments.as_deref()),
        };

        if !context.current_word.is_empty() {
            if let Some(exact) = array(&resolved.node, "subcommands")
                .iter()
                .find(|candidate| names(candidate).contains(&context.current_word))
            {
                result.suggestions = preview_suggestions(exact, &context.input, maximum);
                result.path_requirement = path_requirement(arguments(exact));
                return result;
            }
        }

        for subcommand in array(&resolved.node, "subcommands") {
            for name in names(subcommand) {
                if name.starts_with(&context.current_word) && name != context.current_word {
                    result.suggestions.push(AutocompleteSuggestion {
                        text: context.replacing_current_word(&name),
                        display_text: name,
                        detail: description(subcommand),
                        source: "subcommand",
                        score: 800.0,
                    });
                }
            }
        }

        let direct_count = result.suggestions.len();
        append_option_suggestions(
            array(&resolved.node, "options"),
            &context,
            &mut result.suggestions,
        );
        if result.suggestions.len() == direct_count {
            append_option_suggestions(
                &resolved.inherited_options,
                &context,
                &mut result.suggestions,
            );
        }
        for argument in resolved.arguments.as_deref().unwrap_or_default() {
            for suggestion in array(argument, "suggestions") {
                for name in names(suggestion) {
                    if name.starts_with(&context.current_word) && name != context.current_word {
                        result.suggestions.push(AutocompleteSuggestion {
                            text: context.replacing_current_word(&name),
                            display_text: name,
                            detail: description(suggestion),
                            source: "argument",
                            score: 600.0,
                        });
                    }
                }
            }
        }
        result.suggestions.truncate(maximum);
        result
    }

    fn spec(&self, command: &str) -> Option<Value> {
        if let Some(cached) = self.cache.lock().get(command).cloned() {
            return Some(cached);
        }
        let entry = self.header.entries.get(command)?;
        let start = self.payload_offset.checked_add(entry.offset)?;
        let end = start.checked_add(entry.length)?;
        let compressed = self.data.get(start..end)?;
        let mut decoder = DeflateDecoder::new(compressed);
        let mut expanded = Vec::new();
        decoder.read_to_end(&mut expanded).ok()?;
        let value: Value = serde_json::from_slice(&expanded).ok()?;
        self.cache.lock().insert(command.to_string(), value.clone());
        Some(value)
    }
}

fn development_source_root() -> Option<PathBuf> {
    #[cfg(debug_assertions)]
    {
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .map(PathBuf::from)
    }
    #[cfg(not(debug_assertions))]
    {
        None
    }
}

#[derive(Default)]
struct CommandLine {
    input: String,
    tokens: Vec<String>,
    current_word: String,
    word_index: usize,
    command_name: String,
}

impl CommandLine {
    fn parse(input: &str) -> Self {
        let mut tokens = Vec::new();
        let mut current = String::new();
        let mut single_quoted = false;
        let mut double_quoted = false;
        let mut escaped = false;
        for character in input.chars() {
            if escaped {
                current.push(character);
                escaped = false;
            } else if character == '\\' {
                current.push(character);
                escaped = true;
            } else if character == '\'' && !double_quoted {
                current.push(character);
                single_quoted = !single_quoted;
            } else if character == '"' && !single_quoted {
                current.push(character);
                double_quoted = !double_quoted;
            } else if character == ' ' && !single_quoted && !double_quoted {
                if !current.is_empty() {
                    tokens.push(std::mem::take(&mut current));
                }
            } else {
                current.push(character);
            }
        }
        tokens.push(current.clone());
        let command_name = tokens
            .first()
            .and_then(|token| token.rsplit(['/', '\\']).next())
            .unwrap_or_default()
            .to_lowercase();
        let command_name = strip_command_extension(&command_name).to_string();
        Self {
            input: input.to_string(),
            current_word: current,
            word_index: tokens.len().saturating_sub(1),
            command_name,
            tokens,
        }
    }

    fn replacing_current_word(&self, replacement: &str) -> String {
        let prefix_length = self.input.len().saturating_sub(self.current_word.len());
        format!("{}{replacement}", &self.input[..prefix_length])
    }
}

fn strip_command_extension(command: &str) -> &str {
    [".exe", ".cmd", ".bat", ".sh"]
        .iter()
        .find_map(|extension| command.strip_suffix(extension))
        .unwrap_or(command)
}

fn array<'a>(value: &'a Value, key: &str) -> &'a [Value] {
    value
        .get(key)
        .and_then(Value::as_array)
        .map(Vec::as_slice)
        .unwrap_or_default()
}

struct ResolvedContext {
    node: Value,
    inherited_options: Vec<Value>,
    arguments: Option<Vec<Value>>,
}

fn resolve_context(spec: Value, consumed_tokens: &[String]) -> ResolvedContext {
    let mut current = spec;
    let mut inherited_options = Vec::new();
    let mut skips_next = false;
    let mut option_arguments = None;

    for token in consumed_tokens {
        if skips_next {
            skips_next = false;
            option_arguments = None;
            continue;
        }
        if token.starts_with('-') {
            let mut options = array(&current, "options").to_vec();
            options.extend(inherited_options.iter().cloned());
            if let Some(option) = options.iter().find(|option| names(option).contains(token)) {
                let values = arguments(option).unwrap_or_default().to_vec();
                let optional = values
                    .first()
                    .and_then(|argument| argument.get("isOptional"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if !values.is_empty() && !optional {
                    skips_next = true;
                    option_arguments = Some(values);
                }
            }
            continue;
        }
        let Some(next) = array(&current, "subcommands")
            .iter()
            .find(|candidate| names(candidate).contains(token))
            .cloned()
        else {
            break;
        };
        inherited_options = merge_options(inherited_options, array(&current, "options").to_vec());
        current = next;
    }

    let resolved_arguments = if skips_next {
        option_arguments
    } else {
        arguments(&current).map(ToOwned::to_owned)
    };
    ResolvedContext {
        node: current,
        inherited_options,
        arguments: resolved_arguments,
    }
}

fn merge_options(first: Vec<Value>, second: Vec<Value>) -> Vec<Value> {
    let mut seen = std::collections::HashSet::new();
    first
        .into_iter()
        .chain(second)
        .filter(|option| {
            let mut option_names = names(option);
            option_names.sort();
            seen.insert(option_names.join("\0"))
        })
        .collect()
}

fn preview_suggestions(
    node: &Value,
    command_line: &str,
    maximum: usize,
) -> Vec<AutocompleteSuggestion> {
    let mut suggestions = Vec::new();
    for subcommand in array(node, "subcommands") {
        let Some(name) = names(subcommand).first().cloned() else {
            continue;
        };
        suggestions.push(AutocompleteSuggestion {
            text: format!("{command_line} {name}"),
            display_text: name,
            detail: description(subcommand),
            source: "subcommand",
            score: 800.0,
        });
        if suggestions.len() >= maximum.min(10) {
            return suggestions;
        }
    }
    for option in array(node, "options") {
        if suggestions.len() >= maximum.min(15) {
            break;
        }
        let Some(name) = names(option).first().cloned() else {
            continue;
        };
        suggestions.push(AutocompleteSuggestion {
            text: format!("{command_line} {name}"),
            display_text: name,
            detail: description(option),
            source: "option",
            score: 700.0,
        });
    }
    suggestions
}

fn append_option_suggestions(
    options: &[Value],
    context: &CommandLine,
    suggestions: &mut Vec<AutocompleteSuggestion>,
) {
    for option in options {
        for name in names(option) {
            if name.starts_with(&context.current_word) && name != context.current_word {
                suggestions.push(AutocompleteSuggestion {
                    text: context.replacing_current_word(&name),
                    display_text: name,
                    detail: description(option),
                    source: "option",
                    score: 700.0,
                });
            }
        }
    }
}

fn arguments(value: &Value) -> Option<&[Value]> {
    match value.get("args") {
        Some(Value::Array(values)) => Some(values),
        Some(value) => Some(std::slice::from_ref(value)),
        None => None,
    }
}

fn path_requirement(arguments: Option<&[Value]>) -> Option<&'static str> {
    let templates: Vec<String> = arguments
        .unwrap_or_default()
        .iter()
        .flat_map(|argument| string_values(argument.get("template")))
        .collect();
    let folders = templates.iter().any(|template| template == "folders");
    let files = templates.iter().any(|template| template == "filepaths");
    if folders && !files {
        Some("folders")
    } else if folders || files {
        Some("files")
    } else {
        None
    }
}

fn description(value: &Value) -> Option<String> {
    value
        .get("description")
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn string_values(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) => vec![value.clone()],
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn names(value: &Value) -> Vec<String> {
    let Some(name) = value.get("name") else {
        return value
            .as_str()
            .map(|name| vec![name.to_string()])
            .unwrap_or_default();
    };
    match name {
        Value::String(name) => vec![name.clone()],
        Value::Array(names) => names
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

#[tauri::command]
pub fn autocomplete_suggestions(
    catalog: State<'_, AutocompleteCatalog>,
    input: String,
    maximum: Option<usize>,
) -> AutocompleteSpecResult {
    catalog.suggestions(&input, maximum.unwrap_or(12).clamp(1, 50))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_quoted_command_line() {
        let context = CommandLine::parse("git commit -m \"hello world\" --a");
        assert_eq!(context.command_name, "git");
        assert_eq!(context.current_word, "--a");
        assert_eq!(context.word_index, 4);
    }

    #[test]
    fn loads_real_bundle_and_suggests_commands_subcommands_and_options() {
        let data = include_bytes!("../../public/AutocompleteSpecs.bundledata").to_vec();
        let catalog = AutocompleteCatalog::from_data(data).expect("load autocomplete bundle");

        assert!(catalog
            .suggestions("gi", 20)
            .suggestions
            .iter()
            .any(|suggestion| suggestion.text == "git"));
        assert!(catalog
            .suggestions("git", 20)
            .suggestions
            .iter()
            .any(|suggestion| suggestion.text.starts_with("git ")));
        assert!(catalog
            .suggestions("git ch", 20)
            .suggestions
            .iter()
            .any(|suggestion| {
                suggestion.text == "git checkout"
                    && suggestion.source == "subcommand"
                    && suggestion.detail.is_some()
            }));
        assert!(catalog
            .suggestions("git commit --a", 50)
            .suggestions
            .iter()
            .any(|suggestion| {
                suggestion.text.starts_with("git commit --a")
                    && suggestion.source == "option"
                    && suggestion.detail.is_some()
            }));
    }

    #[test]
    fn rejects_malformed_bundle_and_strips_windows_extensions() {
        assert!(AutocompleteCatalog::from_data(vec![0, 0, 0, 9]).is_none());
        assert_eq!(
            CommandLine::parse(r"C:\Tools\GIT.EXE status").command_name,
            "git"
        );
    }
}
