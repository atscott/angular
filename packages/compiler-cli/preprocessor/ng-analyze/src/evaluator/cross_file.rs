use crate::query::FileId;
use crate::types::analysis::OwningReference;
use crate::ImportPath;
use crate::ResourceResolverFs;
use futures::future::{BoxFuture, FutureExt};
use oxc_resolver::ResolverGeneric;
use oxc_semantic::SymbolId;
use oxc_syntax::module_record::{ExportExportName, ExportImportName, ImportImportName};
use oxc_syntax::symbol::SymbolFlags;
use std::collections::HashSet;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ChaseSymbolError {
    DepthLimitExceeded,
    CycleDetected,
}

#[derive(Clone, Debug)]
pub struct DeclaredSymbol {
    pub file_path: PathBuf,
    pub symbol_id: SymbolId,
    pub flags: SymbolFlags,
    pub owning_reference: Option<OwningReference>,
    /// The name this symbol is bound to in each file the chase passed through, declaration
    /// file first. Only files that actually *bind* the name are recorded: a bare
    /// `export { X } from './x'` forwards the symbol without introducing a binding, so
    /// nothing there can name it. Consumers rely on that — an entry means "this file can
    /// write this identifier today", and its absence means "emit an import".
    pub aliases: Vec<(FileId, String)>,
    /// True when `file_path` exports this symbol under the reserved `default` key rather
    /// than under [`Self::symbol_id`]'s own name, i.e. importers reach it as `m.default`.
    pub exported_as_default: bool,
}

impl DeclaredSymbol {
    pub fn is_type_only(&self) -> bool {
        self.flags.intersects(SymbolFlags::Type) && !self.flags.intersects(SymbolFlags::Value)
    }
}

/// Resolve an import specifier relative to a file using oxc_resolver's standard resolution logic.
pub fn resolve_specifier<Fs: ResourceResolverFs>(
    resolver: &ResolverGeneric<Fs>,
    file_path: &Path,
    specifier: &str,
) -> Option<PathBuf> {
    let file_dir = file_path.parent().unwrap_or(Path::new("."));
    resolver
        .resolve(file_dir, specifier)
        .ok()
        .map(|res| res.into_path_buf())
}

/// Resolve `export_name` from `specifier` relative to `file_path`, chasing re-exports across file boundaries.
///
/// If `specifier` is provided, it first resolves the specifier to a target file. Then it traces the symbol
/// through import and re-export chains to locate its underlying declaration.
pub fn cross_file_resolve<'a, Fs: ResourceResolverFs + Clone + 'static>(
    ctx: &'a crate::QueryCtx<Fs>,
    file_path: &'a Path,
    specifier: Option<&'a str>,
    export_name: String,
    visited: &'a mut HashSet<(PathBuf, String)>,
) -> BoxFuture<'a, Result<Option<DeclaredSymbol>, ChaseSymbolError>> {
    async move {
        let (target_file, initial_owning) = match specifier {
            Some(spec) if !spec.is_empty() => {
                let Some(resolved) =
                    resolve_specifier(ctx.engine.resolver.as_ref(), file_path, spec)
                else {
                    return Ok(None);
                };
                // `export_name` is what this specifier is being asked for, which is exactly
                // the name it exports the symbol under.
                let owning = ImportPath::is_absolute_specifier(spec).then(|| OwningReference {
                    specifier: spec.to_string(),
                    export_name: export_name.clone(),
                });
                (resolved, owning)
            }
            _ => (file_path.to_path_buf(), None),
        };

        chase_symbol_declaration(ctx, target_file, export_name, initial_owning, visited, 0).await
    }
    .boxed()
}

const MAX_SYMBOL_CHASE_DEPTH: usize = 32;

/// Whenever an absolute specifier is encountered along the export resolution chain it
/// overwrites the current owning module with the deeper one — paired with `name_in_target`,
/// the name that specifier exports the symbol under.
fn update_owning_reference(
    current: Option<&OwningReference>,
    specifier: &str,
    name_in_target: &str,
) -> Option<OwningReference> {
    if ImportPath::is_absolute_specifier(specifier) {
        return Some(OwningReference {
            specifier: specifier.to_string(),
            export_name: name_in_target.to_string(),
        });
    }
    current.cloned()
}

/// Target resolution metadata extracted synchronously under mutex lock from a parsed AST.
enum ChaseTarget {
    /// The symbol is exported or imported from another module (`export { A } from 'spec'` or `import { A } from 'spec'`).
    /// Points to `(original_name, source_specifier)`.
    Exported {
        original_name: String,
        source: String,
        /// True when this file also *binds* the name being chased, so code here can write it
        /// directly. An `import` binds; a bare re-export does not.
        binds_locally: bool,
    },

    /// The symbol is an alias for a distinct local identifier in the same file (`export { localName as exportedName }`).
    LocalAlias(String),

    /// The symbol is not explicitly exported/imported directly, but the file has wildcard re-exports (`export * from 'spec'`).
    Wildcards(Vec<String>),

    /// The symbol is declared locally in this file's root scope.
    LocalBinding(SymbolId, SymbolFlags),

    /// The symbol was not found in this file.
    NotFound,
}

/// Synchronously inspect a parsed AST's module record and semantic model to extract the primary chase target for `name`.
fn chase_symbol_in_file_inner(
    dep: &crate::parsed::ParsedFileDependent<'_>,
    name: &str,
) -> ChaseTarget {
    let module_record = &dep.module_record;

    // 1. Indirect exports (`export { A as B } from 'source'`)
    for entry in &module_record.indirect_export_entries {
        // A type-only re-export cannot back a value reference.
        if entry.is_type {
            continue;
        }
        let Some(ref source) = entry.module_request else {
            continue;
        };
        let exported_name = match &entry.export_name {
            ExportExportName::Name(ns) => ns.name.as_str(),
            ExportExportName::Default(_) => "default",
            ExportExportName::Null => continue,
        };
        if exported_name == name {
            let local_name = match &entry.import_name {
                ExportImportName::Name(ns) => ns.name.to_string(),
                ExportImportName::All => "*".to_string(),
                _ => continue,
            };
            return ChaseTarget::Exported {
                original_name: local_name,
                source: source.name.to_string(),
                // The spec folds `import { X } from './x'; export { X };` into an indirect
                // export entry, and there `X` *is* bound here.
                binds_locally: module_record
                    .import_entries
                    .iter()
                    .any(|import| import.local_name.name.as_str() == name),
            };
        }
    }

    // 2. Local export aliases (`export { localName as exportedName }`)
    for entry in &module_record.local_export_entries {
        let Some(local_name) = entry.local_name.name() else {
            continue;
        };
        let exported_name = match &entry.export_name {
            ExportExportName::Name(ns) => ns.name.as_str(),
            ExportExportName::Default(_) => "default",
            ExportExportName::Null => continue,
        };
        if exported_name == name && local_name.as_str() != name {
            return ChaseTarget::LocalAlias(local_name.to_string());
        }
    }

    // 3. Local imports (`import { A as B } from 'source'`)
    for entry in &module_record.import_entries {
        if entry.local_name.name.as_str() == name {
            let original_name = match &entry.import_name {
                ImportImportName::Name(ns) => ns.name.to_string(),
                ImportImportName::Default(_) => "default".to_string(),
                ImportImportName::NamespaceObject => name.to_string(),
            };
            return ChaseTarget::Exported {
                original_name,
                source: entry.module_request.name.to_string(),
                binds_locally: true,
            };
        }
    }

    // 4. Local symbol binding in root scope
    if let Some(symbol_id) = dep.semantic.scoping().get_root_binding(name.into()) {
        let flags = dep.semantic.scoping().symbol_flags(symbol_id);
        return ChaseTarget::LocalBinding(symbol_id, flags);
    }

    // 5. Wildcard / star exports (`export * from 'source'`)
    let mut wildcards = Vec::new();
    for entry in &module_record.star_export_entries {
        // `export type * from 'source'` forwards no values.
        if entry.is_type {
            continue;
        }
        let Some(ref source) = entry.module_request else {
            continue;
        };
        wildcards.push(source.name.to_string());
    }
    if !wildcards.is_empty() {
        return ChaseTarget::Wildcards(wildcards);
    }

    ChaseTarget::NotFound
}

/// Asynchronously inspect a file's cached `AnalyzeFileSyntax` exports and semantic model to extract the primary chase target for `name`.
async fn chase_symbol_in_file<Fs: ResourceResolverFs + Clone + 'static>(
    ctx: &crate::QueryCtx<Fs>,
    file_path: &Path,
    name: &str,
) -> ChaseTarget {
    // Step 1: Check memoized single-file syntax exports cache (QueryKey::AnalyzeFileSyntax)
    let file_id = ctx.engine.intern_path(file_path);
    let syntax = ctx.analyze_file_syntax(file_id).await;
    let exports = &syntax.file_exports;

    // 1. Indirect / named re-exports (`export { A as B } from 'source'`)
    for entry in &exports.named {
        if entry.is_type {
            continue;
        }
        if entry.exported_name == name {
            return ChaseTarget::Exported {
                original_name: entry.local_name.clone(),
                source: entry.source.clone(),
                binds_locally: entry.binds_locally,
            };
        }
    }

    // 2. Local export aliases (`export { localName as exportedName }`)
    for entry in &exports.local_aliases {
        if entry.exported_name == name && entry.local_name != name {
            return ChaseTarget::LocalAlias(entry.local_name.clone());
        }
    }

    // Step 2: Fall back to parsed AST for local import, root binding, or wildcard lookup
    let parsed_file_arc = ctx.parse_file(file_id).await;
    let guard = parsed_file_arc.lock().unwrap();
    let inner_target = chase_symbol_in_file_inner(guard.borrow_dependent(), name);
    if !matches!(inner_target, ChaseTarget::NotFound) {
        return inner_target;
    }

    // 3. Wildcard / star exports (`export * from 'source'`)
    let value_wildcards: Vec<String> = exports
        .wildcards
        .iter()
        .filter(|w| !w.is_type)
        .map(|w| w.source.clone())
        .collect();
    if !value_wildcards.is_empty() {
        return ChaseTarget::Wildcards(value_wildcards);
    }

    ChaseTarget::NotFound
}

/// Trace a symbol through import and re-export chains starting from `file_path` and `name`.
fn chase_symbol_declaration<'a, Fs: ResourceResolverFs + Clone + 'static>(
    ctx: &'a crate::QueryCtx<Fs>,
    file_path: PathBuf,
    name: String,
    owning_reference: Option<OwningReference>,
    visited: &'a mut HashSet<(PathBuf, String)>,
    depth: usize,
) -> BoxFuture<'a, Result<Option<DeclaredSymbol>, ChaseSymbolError>> {
    async move {
        // Depth limit detection
        if depth >= MAX_SYMBOL_CHASE_DEPTH {
            return Err(ChaseSymbolError::DepthLimitExceeded);
        }

        // Cycle detection on active call stack
        let key = (file_path.clone(), name.clone());
        if !visited.insert(key.clone()) {
            return Err(ChaseSymbolError::CycleDetected);
        }

        // Record file dependency in query context
        let file_id = ctx.engine.intern_path(&file_path);
        ctx.record_file(file_id);

        let res = async {
            let target = chase_symbol_in_file(ctx, &file_path, &name).await;

            match target {
                // Branch 1: Exported or imported from another file (`export { A } from 'spec'` or `import { A } from 'spec'`).
                ChaseTarget::Exported {
                    original_name,
                    source,
                    binds_locally,
                } => {
                    if let Some(resolved_path) =
                        resolve_specifier(ctx.engine.resolver.as_ref(), &file_path, &source)
                    {
                        let next_owning = update_owning_reference(
                            owning_reference.as_ref(),
                            &source,
                            &original_name,
                        );
                        let mut resolved = chase_symbol_declaration(
                            ctx,
                            resolved_path,
                            original_name,
                            next_owning,
                            visited,
                            depth + 1,
                        )
                        .await?;
                        // Recorded on the way back up, so only the chain that actually reached
                        // a declaration contributes — abandoned wildcard branches do not.
                        if let (Some(symbol), true) = (resolved.as_mut(), binds_locally) {
                            symbol.aliases.push((file_id, name.clone()));
                        }
                        return Ok(resolved);
                    }
                }

                // Branch 2: Local export alias (`export { localName as exportedName }`).
                ChaseTarget::LocalAlias(alias_target) => {
                    match chase_symbol_declaration(
                        ctx,
                        file_path.clone(),
                        alias_target,
                        owning_reference.clone(),
                        visited,
                        depth + 1,
                    )
                    .await
                    {
                        Ok(Some(mut res)) => {
                            // `export default class Foo {}` binds `Foo` locally but exports it
                            // under the reserved `default` key. Only claim that when the alias
                            // resolved within this same file — `import {X} from './a'; export
                            // {X as default}` declares nothing here, and `./a` still exports it
                            // as `X`.
                            if name == "default" && res.file_path == file_path {
                                res.exported_as_default = true;
                            }
                            return Ok(Some(res));
                        }
                        Err(err) => return Err(err),
                        Ok(None) => {}
                    }
                }

                // Branch 3: Wildcard re-exports (`export * from 'source'`).
                ChaseTarget::Wildcards(wildcards) => {
                    for wildcard_source in &wildcards {
                        let Some(resolved_path) = resolve_specifier(
                            ctx.engine.resolver.as_ref(),
                            &file_path,
                            wildcard_source,
                        ) else {
                            continue;
                        };

                        // `export *` forwards the name unchanged.
                        let next_owning = update_owning_reference(
                            owning_reference.as_ref(),
                            wildcard_source,
                            &name,
                        );
                        match chase_symbol_declaration(
                            ctx,
                            resolved_path,
                            name.clone(),
                            next_owning,
                            visited,
                            depth + 1,
                        )
                        .await
                        {
                            Ok(Some(result)) => return Ok(Some(result)),
                            Err(err) => return Err(err),
                            Ok(None) => {}
                        }
                    }
                }

                // Branch 4: Terminal local symbol binding.
                ChaseTarget::LocalBinding(symbol_id, flags) => {
                    return Ok(Some(DeclaredSymbol {
                        file_path,
                        symbol_id,
                        flags,
                        owning_reference,
                        aliases: vec![(file_id, name.clone())],
                        exported_as_default: false,
                    }));
                }

                // Branch 5: Not found in this file.
                ChaseTarget::NotFound => {}
            }

            Ok(None)
        }
        .await;

        visited.remove(&key);
        res
    }
    .boxed()
}
