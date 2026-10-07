use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use crate::query::{FileId, ReferenceId};
use crate::{types::analysis::DeclarationData, FileData, NgModuleComponentMap, ParsedFile};

#[derive(Clone, Debug)]
pub struct CachedResult {
    pub value: Arc<QueryValue>,
    pub dependencies: HashSet<FileId>,
}

/// Identity of a single analyzer query.
///
/// This is plain data and deliberately carries **no `Fs` type parameter**, so that every query —
/// regardless of which filesystem backend the engine runs on — keys a single shared cache
/// (`QueryCache<QueryKey, QueryValue>`). Each variant corresponds to one "question" the analyzer
/// answers; a query may, while executing, request other queries (forming an acyclic graph).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum QueryKey {
    /// Semantic single-file analysis: builds on [`QueryKey::AnalyzeFileSyntax`] and additionally
    /// publishes the file's `ClassInfo`/exports records into the shared cross-file index. Returns
    /// the same `FileData` the syntactic query produced; drives the optimized pipeline and is the
    /// Stage-1 input every other query builds on.
    AnalyzeFileSemantic(FileId),
    /// Syntactic single-file analysis (`analyzer::analyze_file`): the complete single-file
    /// extraction — every decorated class plus registrations, re-exports, and per-component imports
    /// — and resource registration, with no cross-file work. The base the semantic query builds on;
    /// also drives the plain `analyze` pipeline directly.
    AnalyzeFileSyntax(FileId),
    /// Complete parsed AST and semantic index for a source file, managed in a self-contained arena.
    ParseFile(FileId),
    /// All declarations (components/directives/pipes) transitively exported by an NgModule.
    NgModuleExportsScope(ReferenceId),
    /// Full compilation scope (imports + declarations) visible to templates inside an NgModule.
    NgModuleImportsScope(ReferenceId),
    /// Which name a package entry point publishes each declaration under. Keyed by the
    /// resolved entry point, mirroring upstream's `moduleExportsCache`.
    ModuleExportMap(FileId),
    /// Singleton: the component → owning-NgModule mapping over all entrypoints.
    ComponentMapping,
}

/// `enumerateExportsOfModule`'s `exportMap`, keyed by `(declaring file, declared name)` — the
/// closest stand-in oxc gives us for its `DeclarationNode` key.
pub type ModuleExportMap = std::collections::HashMap<(FileId, String), String>;

#[derive(Clone, Debug)]
pub struct NgModuleImportsScopeData {
    pub declarations: Vec<DeclarationData>,
    /// Every entry of the module's `imports`/`declarations` evaluated to a static `Reference`.
    ///
    /// `false` is ngtsc's NG1010: `resolveTypeList` throws the moment an entry is not a
    /// `Reference`, so the NgModule never registers, and its components get a **null** scope —
    /// an *empty* one, not a partial one. Outside local compilation mode that means an empty
    /// `declarations` list here, so template type checking reproduces ngtsc's cascade.
    /// https://github.com/angular/angular/blob/main/packages/compiler-cli/src/ngtsc/annotations/ng_module/src/handler.ts#L1190-L1197
    pub all_entries_static: bool,
    /// Every `Reference` that was collected also resolved to a class this analyzer could read.
    ///
    /// `false` has **no ngtsc analogue**: ngtsc reaches these through the program's `.d.ts`
    /// files and computes a complete scope. It records a limitation of this analyzer, not
    /// something the user wrote, so there is no diagnostic to reproduce and nothing is gained
    /// by discarding what did resolve — the scope stays best-effort so the type-check block
    /// keeps the declarations it could see.
    pub all_references_resolved: bool,
}

impl NgModuleImportsScopeData {
    /// Whether the scope is exactly what ngtsc would have computed. Callers deciding whether a
    /// static `dependencies` list may be emitted want this; callers reproducing a specific
    /// ngtsc behaviour should branch on the individual flags instead.
    pub fn is_complete(&self) -> bool {
        self.all_entries_static && self.all_references_resolved
    }
}

/// The result of a query, tagged by kind.
///
/// Variants hold `Arc<…>` so the engine's typed accessors can hand back the inner value cheaply
/// (a refcount bump, not a deep clone). The cache stores `Arc<QueryValue>`, so the outer tag is
/// itself shared across all awaiters of a given key.
pub enum QueryValue {
    /// Single-file analysis ([`QueryKey::AnalyzeFileSyntax`]).
    Syntax(Arc<FileData>),
    /// Cross-file resolved analysis ([`QueryKey::AnalyzeFileSemantic`]). Internal facts; the
    /// serialized `AnalysisResult` is projected from this at the engine boundary
    /// (`compiler::lower`).
    Semantic(Arc<FileData>),
    /// Parsed source file ([`QueryKey::ParseFile`]).
    ParsedFile(Arc<Mutex<ParsedFile>>),
    /// An NgModule exports scope.
    Scope(Arc<Vec<DeclarationData>>),
    /// An NgModule imports compilation scope.
    ImportsScope(Arc<NgModuleImportsScopeData>),
    /// A package entry point's export map.
    ExportMap(Arc<ModuleExportMap>),
    /// The component → NgModule mapping singleton.
    ComponentMap(Arc<NgModuleComponentMap>),
}

impl std::fmt::Debug for QueryValue {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Syntax(v) => write!(f, "Syntax({})", v.file_path.display()),
            Self::Semantic(v) => write!(f, "Semantic({})", v.file_path.display()),
            Self::ParsedFile(_) => write!(f, "ParsedFile"),
            Self::Scope(v) => write!(f, "Scope({} decls)", v.len()),
            Self::ImportsScope(v) => {
                write!(
                    f,
                    "ImportsScope({} decls, static={}, resolved={})",
                    v.declarations.len(),
                    v.all_entries_static,
                    v.all_references_resolved
                )
            }
            Self::ExportMap(v) => write!(f, "ExportMap({} decls)", v.len()),
            Self::ComponentMap(v) => {
                write!(f, "ComponentMap({} entries)", v.component_to_module.len())
            }
        }
    }
}
