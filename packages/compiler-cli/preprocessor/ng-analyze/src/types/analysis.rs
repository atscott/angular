use super::metadata::{
    AngularFieldMetadata, DeclarationTuple, HostDirectiveMetadata, LegacyAnimationTriggerNames,
    SpanMetadata, TemplateGuardMetadata, TypeParameterMetadata,
};
use crate::query::{FileId, ReferenceId};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Tracks the effective import path during symbol resolution
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum ImportPath {
    /// Absolute/package import - use as-is (e.g., "@angular/common")
    Absolute(String),
    /// Resolved to a file path - convert to relative specifier at end
    ResolvedFile(PathBuf),
}

impl ImportPath {
    pub(crate) fn is_absolute_specifier(specifier: &str) -> bool {
        !specifier.starts_with('.') && !specifier.starts_with('/')
    }

    #[allow(dead_code)]
    pub(crate) fn to_specifier(&self, from_file: &Path) -> String {
        match self {
            ImportPath::Absolute(s) => s.clone(),
            ImportPath::ResolvedFile(path) => {
                let from_dir = from_file.parent().unwrap_or(Path::new("."));
                let to_dir = path.parent().unwrap_or(Path::new("."));

                let relative =
                    pathdiff::diff_paths(to_dir, from_dir).unwrap_or_else(|| to_dir.to_path_buf());

                let file_stem = path
                    .file_stem()
                    .and_then(|s| s.to_str())
                    .unwrap_or("")
                    .trim_end_matches(".d"); // Handle .d.ts

                let mut specifier = relative
                    .join(file_stem)
                    .to_string_lossy()
                    .replace('\\', "/");

                if !specifier.starts_with('.') {
                    specifier = format!("./{}", specifier);
                }
                specifier
            }
        }
    }
}

/// A symbol as published by the package it is reached through: the specifier to import from,
/// and the name that package exports it under.
///
/// Inseparable by construction: a barrel may rename on the way through
/// (`export {InternalX as X} from './deep'`), so knowing the specifier without knowing its name
/// for the symbol is not enough to write an import. Distinct from [`Reference::aliases`], which
/// records *bindings* — `X` is not bound inside the barrel and cannot be written there.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct OwningReference {
    /// Absolute/package specifier, e.g. `@angular/router`.
    pub specifier: String,
    pub export_name: String,
}

/// Internal Rust AST representation of a declaration reference
#[derive(Clone, Debug, Eq)]
pub struct Reference {
    pub file: FileId,
    pub name: String,
    /// How an external package publishes this symbol, if it was reached through one. `None`
    /// when it was declared locally or resolved to a relative workspace source file — the
    /// importer then uses `file` to look up the disk path and relative-resolve against it.
    pub owning_reference: Option<OwningReference>,
    /// The name this symbol can be written as in each file that can name it: the declaring
    /// file, plus every file the evaluation traversed that binds it (an import, or a
    /// re-export that also binds). A file *absent* from this map cannot name the symbol and
    /// must import it — so entries must only ever be real bindings, never invented names.
    pub aliases: std::collections::HashMap<FileId, String>,
    /// True when the declaring module exports this symbol under the reserved `default` key.
    /// Consumers that emit their own import reach it as `default`, not as [`Self::name`]
    /// (which stays the declared class name, since that is what the declaring file binds).
    pub is_default_export: bool,
}

impl PartialEq for Reference {
    fn eq(&self, other: &Self) -> bool {
        self.file == other.file && self.name == other.name
    }
}

impl std::hash::Hash for Reference {
    fn hash<H: std::hash::Hasher>(&self, state: &mut H) {
        self.file.hash(state);
        self.name.hash(state);
    }
}

impl Reference {
    pub fn name(&self) -> &str {
        self.name.as_str()
    }

    /// The name a generated import must use to reach this symbol — what a namespace import
    /// dereferences (`i1.Foo`, `i1.default`, or `i1.X` for a barrel that renamed it).
    ///
    /// Deliberately not [`Self::name`]: the declared name is only the right thing to write
    /// when the import targets the declaring file itself.
    pub fn export_name(&self) -> &str {
        if let Some(owning) = &self.owning_reference {
            return owning.export_name.as_str();
        }
        if self.is_default_export {
            return "default";
        }
        &self.name
    }

    /// The identifier `file_id` can write to reach this symbol, falling back to the export
    /// name for files that cannot name it directly.
    pub fn name_in_file(&self, file_id: FileId) -> &str {
        self.aliases
            .get(&file_id)
            .map(|alias| alias.as_str())
            .unwrap_or_else(|| self.export_name())
    }

    /// True when `file_id` already has a binding for this symbol, so it can be referenced
    /// by name instead of through a generated import.
    pub fn is_in_scope_of(&self, file_id: FileId) -> bool {
        self.aliases.contains_key(&file_id)
    }

    pub fn from_value_reference(r: &crate::evaluator::value::ValueReference) -> Self {
        // The declaring file always names the symbol by its declared name; the evaluation
        // supplies the rest of the chain.
        let mut aliases = std::collections::HashMap::new();
        aliases.insert(r.file, r.name.clone());
        aliases.extend(r.aliases.iter().cloned());
        Self {
            file: r.file,
            name: r.name.clone(),
            owning_reference: r.owning_reference.clone(),
            aliases,
            is_default_export: r.is_default_export,
        }
    }
}

#[derive(Clone, Debug)]
pub struct DeclarationData {
    pub reference: Reference,
    pub name_span: crate::types::metadata::SpanMetadata,
    pub declaration_type: ClassType,
    pub selector: Option<String>,
    pub pipe_name: Option<String>,
    pub is_standalone: Option<bool>,
    pub export_as: Option<Vec<String>>,
    pub host_directives: Option<Vec<crate::types::metadata::HostDirectiveMetadata>>,
    pub fields: Option<Vec<crate::types::metadata::AngularFieldMetadata>>,
    pub flattened_fields: Option<Vec<crate::types::metadata::AngularFieldMetadata>>,
    pub ng_content_selectors: Option<Vec<String>>,
    pub type_parameters: Option<Vec<crate::types::metadata::TypeParameterMetadata>>,
    pub has_ng_template_context_guard: bool,
    pub ng_template_guards: Vec<crate::types::metadata::TemplateGuardMetadata>,
    pub animation_trigger_names: Option<crate::types::metadata::LegacyAnimationTriggerNames>,
    pub has_ng_field_directive: bool,
    pub is_forward_ref: bool,
    pub is_structural: bool,
    /// How the file this declaration is being emitted into refers to it. Constructors project
    /// into the declaring file's own frame — the only one they know — and stage 2 re-projects
    /// into the consuming component's frame, since a scope entry is shared across consumers.
    pub ref_meta: crate::types::metadata::ReferenceMetadata,
    /// The same declaration as seen from the file of the NgModule that declares the consuming
    /// component. Remote scoping emits `ɵɵsetComponentScope` *there* rather than in the
    /// component's own file, and a binding or relative specifier that is valid in one is not
    /// generally valid in the other. `None` for a standalone component, which has no declaring
    /// NgModule and can never be remotely scoped.
    pub ref_in_declaring_module: Option<crate::types::metadata::ReferenceMetadata>,
    pub cycle_prone: Option<bool>,
    pub is_exported: bool,
    pub has_non_exported_bounds: bool,
    pub is_explicitly_deferred: bool,
    pub deferred_blocks: Option<Vec<String>>,
}

impl DeclarationData {
    pub fn deduplicate(decls: &mut Vec<Self>) {
        let mut seen = std::collections::HashSet::new();
        decls.retain(|d| seen.insert(d.reference.clone()));
    }

    pub(crate) fn from_class_info(
        reference: Reference,
        local_info: &ClassInfo,
        flattened_info: &ClassInfo,
        is_forward_ref: bool,
    ) -> Option<Self> {
        let ref_meta = crate::types::metadata::ReferenceMetadata::for_local_declaration(
            reference.name.clone(),
        );
        let declaration_type = match local_info.class_type {
            ClassType::Component => ClassType::Component,
            ClassType::Directive => ClassType::Directive,
            ClassType::Pipe => ClassType::Pipe,
            ClassType::NgModule => ClassType::NgModule,
            ClassType::Injectable | ClassType::Service => return None,
        };

        Some(Self {
            reference,
            name_span: local_info.name_span,
            declaration_type,
            selector: local_info.selector.clone(),
            export_as: local_info.export_as.clone(),
            pipe_name: local_info.pipe_name.clone(),
            is_standalone: local_info.is_standalone,
            host_directives: local_info.host_directives.clone(),
            fields: local_info.fields.clone(),
            flattened_fields: flattened_info.fields.clone(),
            ng_content_selectors: local_info.ng_content_selectors.clone(),
            type_parameters: local_info.type_parameters.clone(),
            has_ng_template_context_guard: local_info.has_ng_template_context_guard,
            ng_template_guards: local_info.ng_template_guards.clone(),
            animation_trigger_names: local_info.animation_trigger_names.clone(),
            has_ng_field_directive: local_info.has_ng_field_directive,
            is_forward_ref,
            is_structural: local_info.is_structural,
            ref_meta,
            ref_in_declaring_module: None,
            cycle_prone: None,
            is_exported: local_info.is_exported,
            has_non_exported_bounds: local_info.has_non_exported_bounds,
            is_explicitly_deferred: false,
            deferred_blocks: None,
        })
    }

    pub(crate) fn from_class_data(
        name: String,
        class: &crate::analyzer::ClassData,
        is_forward_ref: bool,
        source_text: &str,
        converter: &crate::utils::Utf8ToUtf16,
    ) -> Option<Self> {
        use crate::analyzer::DecoratorData;
        use crate::evaluator::Resolved;

        let (declaration_type, selector, pipe_name, is_standalone, export_as, host_directives) =
            match &class.decorator {
                DecoratorData::Component(c) => (
                    ClassType::Component,
                    c.directive
                        .selector
                        .as_ref()
                        .and_then(Resolved::get_optional),
                    None,
                    Some(c.directive.standalone),
                    c.directive.export_as.clone(),
                    c.directive.host_directives.clone(),
                ),
                DecoratorData::Directive(d) => (
                    ClassType::Directive,
                    d.selector.as_ref().and_then(Resolved::get_optional),
                    None,
                    Some(d.standalone),
                    d.export_as.clone(),
                    d.host_directives.clone(),
                ),
                DecoratorData::Pipe(p) => (
                    ClassType::Pipe,
                    None,
                    p.name.clone(),
                    p.standalone,
                    None,
                    None,
                ),
                DecoratorData::NgModule(_) => {
                    (ClassType::NgModule, None, None, Some(false), None, None)
                }
                _ => return None,
            };

        let animation_trigger_names = match &class.decorator {
            DecoratorData::Component(c) => c.animation_trigger_names.clone(),
            _ => None,
        };
        let members = match &class.decorator {
            DecoratorData::Component(c) => Some(&c.directive),
            DecoratorData::Directive(d) => Some(d),
            _ => None,
        };
        let is_structural = match &class.decorator {
            DecoratorData::Directive(d) => d.is_structural,
            _ => false,
        };

        let fields_metadata = members.map(|m| {
            m.fields
                .iter()
                .map(|f| f.to_wire(source_text, converter))
                .collect::<Vec<_>>()
        });

        let mut aliases = std::collections::HashMap::new();
        aliases.insert(class.reference_id.file, name.clone());
        let reference = Reference {
            file: class.reference_id.file,
            name: name.clone(),
            owning_reference: None,
            aliases,
            is_default_export: false,
        };
        let ref_meta = crate::types::metadata::ReferenceMetadata::for_local_declaration(
            reference.name.clone(),
        );

        Some(Self {
            reference,
            name_span: crate::types::metadata::SpanMetadata::new(
                class.name_span.unwrap_or_default(),
                converter,
            ),
            declaration_type,
            selector,
            pipe_name,
            is_standalone,
            export_as,
            host_directives,
            fields: fields_metadata.clone(),
            flattened_fields: fields_metadata,
            ng_content_selectors: None,
            type_parameters: class.type_parameters.clone().map(|params| {
                params
                    .into_iter()
                    .map(|p| p.into_wire(source_text, converter))
                    .collect()
            }),
            has_ng_template_context_guard: class.has_ng_template_context_guard,
            ng_template_guards: class.ng_template_guards.clone(),
            animation_trigger_names,
            has_ng_field_directive: class.has_ng_field_directive,
            is_forward_ref,
            is_structural,
            ref_meta,
            ref_in_declaring_module: None,
            cycle_prone: None,
            is_exported: class.is_exported,
            has_non_exported_bounds: class.has_non_exported_bounds,
            is_explicitly_deferred: false,
            deferred_blocks: None,
        })
    }
}

// Internal types for optimize mode
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum ClassType {
    Component,
    Directive,
    Injectable,
    NgModule,
    Pipe,
    Service,
}

#[derive(Clone, Debug)]
pub struct ClassInfo {
    pub reference_id: ReferenceId,
    #[allow(dead_code)]
    pub(crate) file_path: PathBuf,
    pub class_name: String,
    pub name_span: SpanMetadata,
    pub(crate) class_type: ClassType,
    pub(crate) selector: Option<String>,
    /// For pipes: the template binding name (e.g., "upcase")
    pub(crate) pipe_name: Option<String>,
    pub(crate) is_standalone: Option<bool>,
    pub is_structural: bool,
    pub export_as: Option<Vec<String>>,
    pub host_directives: Option<Vec<HostDirectiveMetadata>>,
    pub fields: Option<Vec<AngularFieldMetadata>>,
    pub exports: Option<Vec<String>>,
    pub ng_content_selectors: Option<Vec<String>>,
    pub type_parameters: Option<Vec<TypeParameterMetadata>>,

    pub has_ng_template_context_guard: bool,
    pub ng_template_guards: Vec<TemplateGuardMetadata>,
    pub schemas: Option<Vec<String>>,
    pub animation_trigger_names: Option<LegacyAnimationTriggerNames>,
    pub has_ng_field_directive: bool,
    pub raw_imports: Option<Vec<DeclarationTuple>>,
    /// ngtsc's `mayDeclareProviders`: the NgModule literal carries a non-empty `providers`.
    pub may_declare_providers: bool,
    pub super_class: Option<DeclarationTuple>,
    pub is_exported: bool,
    pub has_non_exported_bounds: bool,
}

pub struct NgModuleComponentMap {
    pub component_to_module: HashMap<FileId, HashMap<String, ReferenceId>>,
}

impl NgModuleComponentMap {
    pub fn get(&self, file_id: FileId, class_name: &str) -> Option<ReferenceId> {
        self.component_to_module
            .get(&file_id)?
            .get(class_name)
            .copied()
    }
}

/// A file's analysis: the single shape produced by both per-file queries.
///
/// The syntactic query ([`crate::QueryKey::AnalyzeFileSyntax`]) produces it from one file
/// alone (for both `.ts` and `.d.ts`); the semantic query
/// ([`crate::QueryKey::AnalyzeFileSemantic`]) starts from a clone of the syntactic result and
/// completes it — resolving each class's metadata in place across files. *Semantic is a more
/// resolved Syntax*, so there is one data type with two production modes, not two types.
///
/// `class_index` and `file_exports` form this file's **symbol table** — the cross-file lookup
/// that other files' semantic resolution reads by querying this file's `AnalyzeFileSyntax`
/// directly (no shared index). The symbol-table fields are `Arc`-wrapped so the plain pipeline
/// (which ignores them) clones cheaply.
///
/// The query engine speaks this internal type only — the serialized
/// [`crate::AnalysisResult`] is a projection produced at the engine boundary by
/// [`FileData::to_wire_syntax`] / [`FileData::to_wire_semantic`], so new internal analysis
/// state never threatens the wire format.
#[derive(Clone)]
pub struct FileData {
    pub(crate) file_id: FileId,
    pub(crate) file_path: PathBuf,
    pub(crate) converter: Arc<crate::utils::Utf8ToUtf16>,

    pub(crate) imports_end: u32,
    pub(crate) classes: Vec<crate::analyzer::ClassData>,
    /// The file's static `import` declarations, in source order.
    pub(crate) import_declarations: Vec<crate::analyzer::ImportDeclarationInfo>,
    pub(crate) type_only_exports: Vec<String>,
    /// The file's static import specifiers resolved to on-disk TS sources (single-file
    /// resolution; no other file is *read*). Drives the streaming coordinator's traversal.
    pub(crate) resolved_dependencies: Vec<PathBuf>,
    /// This file's declared classes, keyed by name — the symbol-table half consumed cross-file.
    pub(crate) class_index: Arc<HashMap<String, ClassInfo>>,
    /// This file's declared classes, keyed by SymbolId — the O(1) lookup consumed cross-file.
    pub(crate) symbol_index: Arc<HashMap<ReferenceId, ClassInfo>>,
    /// This file's re-export table (`export … from …`).
    pub(crate) file_exports: Arc<crate::analyzer::FileExportInfo>,
    pub(crate) errors: Vec<String>,
    pub(crate) diagnostics: Vec<crate::NgDiagnostic>,
}

impl FileData {
    /// Project analysis into the serialized wire shape using the provided `WireContext`.
    pub fn to_wire(
        &self,
        cx: &crate::analyzer::WireContext,
    ) -> Result<crate::AnalysisResult, crate::analyzer::WireError> {
        let classes = self
            .classes
            .iter()
            .map(|c| c.to_wire(cx))
            .collect::<Result<Vec<_>, _>>()?;

        Ok(crate::AnalysisResult {
            file_id: self.file_id,
            file_path: self.file_path.to_string_lossy().into(),
            imports_end: self.imports_end,
            classes,
            imports: self.wire_imports(),
            type_only_exports: self.type_only_exports.clone(),
            diagnostics: self.diagnostics.clone(),
        })
    }

    /// The import table is single-file syntactic data, identical in both projections.
    fn wire_imports(&self) -> Vec<crate::types::metadata::ImportDeclarationMetadata> {
        self.import_declarations
            .iter()
            .map(|info| {
                crate::types::metadata::ImportDeclarationMetadata::to_wire(info, &self.converter)
            })
            .collect()
    }

    /// Every `(declaring file, declared name)` a wire projection of this file asks the emit
    /// strategy about. Resolving them is a query, so it happens before projection.
    pub(crate) fn wire_reference_decls(&self) -> std::collections::HashSet<(FileId, String)> {
        let mut out = std::collections::HashSet::new();
        for class in &self.classes {
            if let Some(name) = &class.class_name {
                out.insert((class.reference_id.file, name.clone()));
            }
            for slot in class.wire_reference_slots() {
                let Some(refs) = slot.as_ref().and_then(|s| s.get_optional()) else {
                    continue;
                };
                for r in refs {
                    out.insert((r.file, r.name.clone()));
                }
            }
        }
        out
    }

    /// The name this file publishes a symbol it declares under, or `None` when it publishes
    /// none — the rule behind `findExportedNameOfNode`. A non-alias export wins over an alias.
    pub(crate) fn exported_name_of(&self, declared: &str) -> Option<String> {
        // `import {X} from './y'; export {X}` republishes `./y`'s declaration, not one of ours.
        if self
            .import_declarations
            .iter()
            .any(|d| d.bindings.iter().any(|b| b.local == declared))
        {
            return None;
        }
        let mut aliased = None;
        for a in self.file_exports.local_aliases.iter() {
            // Deliberate divergence: upstream's `findExportedNameOfNode` accepts type-only
            // exports, emitting value imports a consumer's tsc rejects; we decline instead.
            if a.is_type || a.local_name != declared {
                continue;
            }
            if a.exported_name == declared {
                return Some(a.exported_name.clone());
            }
            aliased = Some(a.exported_name.clone());
        }
        aliased
    }

    /// Validates metadata values across all classes in this file.
    pub fn validate(&mut self) {
        for class in &self.classes {
            class.validate(&self.file_path, &self.converter, &mut self.diagnostics);
        }
    }
}
