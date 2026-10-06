//! The Semantic-mode driver: resolves [`IncompleteValue`] holes across files and re-runs the
//! sync interpreter until a value is complete or genuinely dynamic.
//!
//! Deliberately a plain recursive async fn (the `dts::resolver::resolve_symbol` precedent),
//! NOT a cached query: `QueryKey::EvaluateExport` would deadlock on cyclic imports (two
//! `SharedQuery` tasks awaiting each other park forever — barrel-file cycles are common, and
//! on WASM's single-threaded pump a deadlock hangs the whole compiler). The expensive parts
//! (parse, semantic build, re-export tables) are already cached queries, so per-export caching
//! buys little.
// TODO(query-caching): promote to QueryKey::EvaluateExport(FileId, ExportAtom) once the engine
// grows query-level cycle detection (per-task in-flight key stack or Salsa-style recovery).
//!
//! Locking discipline: the interpreter runs inside one file's `ParsedFile` lock; the lock is
//! always dropped before any `.await` (the interpreter's outputs are owned values), and no two
//! file locks are ever held at once.

use crate::analyzer::{extract_import_map, ImportKind};
use crate::evaluator::cross_file::resolve_specifier;
use crate::evaluator::foreign::ForeignFunctionResolver;
use crate::evaluator::interpreter::{
    evaluate_expression, evaluate_function_call, evaluate_static_member,
    evaluate_symbol_declaration, EvalInput, EvalMode,
};
use crate::evaluator::value::{
    collect_holes, demote_incomplete_to_dynamic, fingerprint_args, stamp_owning_reference,
    substitute, DeclKind, DynamicReason, IncompleteDep, IncompleteValue, ResolvedEnv,
    ResolvedValue, UnresolvedReference, ValueReference,
};
use crate::query::ReferenceId;
use crate::query::{FileId, QueryContext};
use crate::types::{ImportPath, ParsedFile};
use crate::ResourceResolverFs;
use futures::future::{BoxFuture, FutureExt};
use oxc_ast::ast::Expression;
use oxc_ast::AstKind;
use oxc_span::Span;
use oxc_syntax::module_record::ExportExportName;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Cross-file recursion depth cap (matches ngtsc's defense against pathological chains).
const MAX_FILE_DEPTH: usize = 64;
/// Per-value fixpoint iteration cap. Each productive iteration strictly grows the env, and the
/// hole-key space of one expression is finite, so this is a belt-and-braces backstop.
const MAX_FIXPOINT_ITERS: usize = 16;

async fn reevaluate_ast_expression<Fs: ResourceResolverFs + Clone + 'static>(
    ctx: &QueryContext<Fs>,
    file_id: FileId,
    node_id: Option<oxc_semantic::NodeId>,
    env: &ResolvedEnv,
    foreign: &[&dyn ForeignFunctionResolver],
) -> Option<ResolvedValue> {
    let node_id = node_id?;
    let parsed = ctx.parse_file(file_id).await;
    let guard = parsed.lock().expect("ParsedFile lock poisoned");
    let dep = guard.borrow_dependent();
    let import_map = crate::analyzer::extract_import_map(&dep.module_record);
    let input = EvalInput {
        semantic: &dep.semantic,
        file: file_id,
        import_map: &import_map,
        mode: EvalMode::Semantic,
        env,
        foreign,
    };

    crate::evaluator::interpreter::evaluate_node_id(node_id, &input)
}

/// Completely resolve a `ResolvedValue` by filling all its holes from `ctx` directly.
/// Remaining unresolvable holes are demoted to `Dynamic`.
pub async fn evaluate_value_completely<Fs: ResourceResolverFs + Clone + 'static>(
    ctx: &QueryContext<Fs>,
    value: &ResolvedValue,
    foreign: &[&dyn ForeignFunctionResolver],
) -> ResolvedValue {
    if !value.contains_incomplete() {
        return value.clone();
    }
    let mut visited = HashSet::new();
    let mut env = ResolvedEnv::new();
    let mut ast_results = std::collections::HashMap::new();
    let mut current = value.clone();

    for _ in 0..MAX_FIXPOINT_ITERS {
        if !current.contains_incomplete() {
            return current;
        }
        let holes = collect_holes(&current);
        let mut progressed = false;
        let mut postponed_calls = Vec::new();
        for hole in &holes {
            let key = hole.key();
            if env.contains_key(&key) {
                continue;
            }
            if let IncompleteDep::Call { args, .. } = &hole.dep {
                if args.iter().any(|arg| arg.contains_incomplete()) {
                    postponed_calls.push(hole.clone());
                    continue;
                }
            }
            let resolved = resolve_hole(ctx, hole.clone(), &mut visited, 0, foreign).await;
            env.insert(key, resolved);
            progressed = true;
        }
        if !progressed && !postponed_calls.is_empty() {
            for hole in postponed_calls {
                let key = hole.key();
                let resolved = resolve_hole(ctx, hole, &mut visited, 0, foreign).await;
                env.insert(key, resolved);
            }
            progressed = true;
        }
        if !progressed {
            break;
        }
        current = substitute(current, &env, &ast_results);

        if current.contains_incomplete() {
            let surviving_holes = collect_holes(&current);
            let mut new_ast_results = false;
            for hole in surviving_holes {
                if !hole.transparent {
                    if let Some(reevaluated) =
                        reevaluate_ast_expression(ctx, hole.file, hole.node_id, &env, foreign).await
                    {
                        ast_results.insert(hole.span, reevaluated);
                        new_ast_results = true;
                    }
                }
            }
            if new_ast_results {
                current = substitute(current, &env, &ast_results);
            }
        }
    }
    demote_incomplete_to_dynamic(current)
}

// ==================================================================== fixpoint core

/// How to (re-)produce a value inside one file's arena. Each task is re-runnable with a
/// growing env, which is what lets non-transparent holes (spreads, operators, call argument
/// refreshes) complete without any access-path bookkeeping.
enum EvalTask {
    /// A named export's declaration.
    Export { name: String },
    /// A static member access on a class of this file.
    Member {
        base: ValueReference,
        member: String,
    },
    /// A call of a function-like declaration of this file, with pre-resolved arguments.
    Call {
        callee: ValueReference,
        args: Vec<ResolvedValue>,
        call_span: Span,
    },
}

/// Run `task` to a hole-free value in `file_id`'s frame: evaluate under the file's
/// `ParseFile` lock, resolve the resulting holes across files (recursively), and re-run with
/// the env until complete; demote whatever still isn't.
fn complete_value<'a, Fs: ResourceResolverFs + Clone + 'static>(
    ctx: &'a QueryContext<Fs>,
    file_id: FileId,
    task: EvalTask,
    initial: Option<ResolvedValue>,
    visited: &'a mut HashSet<(FileId, String)>,
    depth: usize,
    foreign: &'a [&'a dyn ForeignFunctionResolver],
) -> BoxFuture<'a, ResolvedValue> {
    async move {
        let parsed = ctx.parse_file(file_id).await; // cached query; records the dependency
        let mut env = ResolvedEnv::new();
        let mut value = match initial {
            Some(v) => v,
            None => {
                let Some(v) = run_task_locked(&parsed, file_id, &env, &task, foreign) else {
                    return ResolvedValue::dynamic(
                        file_id,
                        Span::default(),
                        DynamicReason::ExportNotFound,
                    );
                };
                v
            }
        };

        for _ in 0..MAX_FIXPOINT_ITERS {
            if !value.contains_incomplete() {
                return value;
            }
            let holes = collect_holes(&value);
            let mut progressed = false;
            let mut postponed_calls = Vec::new();
            for hole in &holes {
                let key = hole.key();
                if env.contains_key(&key) {
                    continue;
                }
                // A Call hole whose arguments still contain holes resolves on a later round:
                // the inner holes fill first, and the re-run emits a fresh Call hole with
                // resolved arguments (and therefore a stable fingerprint key).
                if let IncompleteDep::Call { args, .. } = &hole.dep {
                    if args.iter().any(|arg| arg.contains_incomplete()) {
                        postponed_calls.push(hole.clone());
                        continue;
                    }
                }
                // resolve_hole is total: it always returns a hole-free value (worst case
                // Dynamic), so every insertion is monotone progress.
                let resolved = resolve_hole(ctx, hole.clone(), visited, depth, foreign).await;
                env.insert(key, resolved);
                progressed = true;
            }
            if !progressed && !postponed_calls.is_empty() {
                // When inner arguments remain incomplete (e.g. unresolvable elements in route arrays),
                // do not abandon the outer Call hole. Foreign recognizers (like ModuleWithProviders)
                // inspect only return types, ignoring arguments, and can still succeed.
                for hole in postponed_calls {
                    let key = hole.key();
                    let resolved = resolve_hole(ctx, hole, visited, depth, foreign).await;
                    env.insert(key, resolved);
                }
                progressed = true;
            }
            if !progressed {
                break;
            }
            // Fast path: every hole sits in a plain value position and has an env entry —
            // owned-tree substitution completes the value with no arena access.
            if holes
                .iter()
                .all(|h| h.transparent && env.contains_key(&h.key()))
            {
                value = substitute(value, &env, &std::collections::HashMap::new());
            } else {
                let Some(v) = run_task_locked(&parsed, file_id, &env, &task, foreign) else {
                    break;
                };
                value = v;
            }
        }
        demote_incomplete_to_dynamic(value)
    }
    .boxed()
}

/// One sync evaluation pass under the file's `ParsedFile` lock. The guard never crosses an
/// `.await`; only owned values escape.
fn run_task_locked(
    parsed: &Arc<Mutex<ParsedFile>>,
    file_id: FileId,
    env: &ResolvedEnv,
    task: &EvalTask,
    foreign: &[&dyn ForeignFunctionResolver],
) -> Option<ResolvedValue> {
    let guard = parsed.lock().expect("ParsedFile lock poisoned");
    let dep = guard.borrow_dependent();
    let import_map = extract_import_map(&dep.module_record);
    let input = EvalInput {
        semantic: &dep.semantic,
        file: file_id,
        import_map: &import_map,
        mode: EvalMode::Semantic,
        env,
        foreign,
    };
    match task {
        EvalTask::Export { name } => {
            let export = find_export_binding(dep, file_id, name)?;
            match export {
                ExportBinding::Symbol(reference_id) => {
                    Some(evaluate_symbol_declaration(reference_id.symbol, &input))
                }
                ExportBinding::DefaultExpression(expr) => Some(evaluate_expression(expr, &input)),
            }
        }

        EvalTask::Member { base, member } => Some(evaluate_static_member(base, member, &input)),
        EvalTask::Call {
            callee,
            args,
            call_span,
        } => Some(evaluate_function_call(callee, args, *call_span, &input)),
    }
}

// ==================================================================== hole resolution

/// Resolve one hole to a hole-free value. Total: failures become `Dynamic` with a reason.
fn resolve_hole<'a, Fs: ResourceResolverFs + Clone + 'static>(
    ctx: &'a QueryContext<Fs>,
    hole: IncompleteValue,
    visited: &'a mut HashSet<(FileId, String)>,
    depth: usize,
    foreign: &'a [&'a dyn ForeignFunctionResolver],
) -> BoxFuture<'a, ResolvedValue> {
    async move {
        if depth >= MAX_FILE_DEPTH {
            return ResolvedValue::dynamic(hole.file, hole.span, DynamicReason::DepthLimit);
        }
        match hole.dep {
            IncompleteDep::Reference(unresolved) => {
                resolve_import(ctx, unresolved, hole.span, visited, depth + 1, foreign).await
            }
            IncompleteDep::Member { base, member } => {
                let guard_key = (base.file, format!("member:{}::{}", base.name, member));
                if !visited.insert(guard_key) {
                    return ResolvedValue::dynamic(
                        hole.file,
                        hole.span,
                        DynamicReason::ImportCycle,
                    );
                }
                let owning = base
                    .owning_reference
                    .as_ref()
                    .map(|o| ImportPath::Absolute(o.specifier.clone()));
                let base_file = base.file;
                let value = complete_value(
                    ctx,
                    base_file,
                    EvalTask::Member { base, member },
                    None,
                    visited,
                    depth + 1,
                    foreign,
                )
                .await;
                apply_owning_reference(value, base_file, owning)
            }
            IncompleteDep::Call { callee, args } => {
                let guard_key = (
                    callee.file,
                    format!(
                        "call:{}::{}#{:x}",
                        callee.name,
                        callee.member.as_deref().unwrap_or(""),
                        fingerprint_args(&args)
                    ),
                );
                if !visited.insert(guard_key) {
                    return ResolvedValue::dynamic(
                        hole.file,
                        hole.span,
                        DynamicReason::ImportCycle,
                    );
                }
                let owning = callee
                    .owning_reference
                    .as_ref()
                    .map(|o| ImportPath::Absolute(o.specifier.clone()));
                let callee_file = callee.file;
                let value = complete_value(
                    ctx,
                    callee_file,
                    EvalTask::Call {
                        callee,
                        args,
                        // NOTE: the span is the originating call in the *requesting* file;
                        // dynamics minted in the target frame carry it for traceability.
                        call_span: hole.span,
                    },
                    None,
                    visited,
                    depth + 1,
                    foreign,
                )
                .await;
                apply_owning_reference(value, callee_file, owning)
            }
        }
    }
    .boxed()
}

/// Propagate the chain's best-guess owning module onto references declared in the file the
/// value came from (e.g. the `ngModule` of `RouterModule.forRoot()` stays importable as
/// `@angular/router`).
fn apply_owning_reference(
    value: ResolvedValue,
    file: FileId,
    owning: Option<ImportPath>,
) -> ResolvedValue {
    let Some(owning) = owning else {
        return value;
    };
    stamp_owning_reference(value, file, &owning)
}

/// Resolve an import binding (the reference Syntax mode couldn't chase) to a value.
async fn resolve_import<Fs: ResourceResolverFs + Clone + 'static>(
    ctx: &QueryContext<Fs>,
    unresolved: UnresolvedReference,
    usage_span: Span,
    visited: &mut HashSet<(FileId, String)>,
    depth: usize,
    foreign: &[&dyn ForeignFunctionResolver],
) -> ResolvedValue {
    let export_name = match &unresolved.symbol {
        ImportKind::Named(name) => name.clone(),
        ImportKind::Default => "default".to_string(),
        ImportKind::Namespace => {
            // A namespace object used as a value (not refined by member access).
            // TODO(parity): materialize as a Map of the module's exports (upstream
            // ResolvedModule equivalent).
            return ResolvedValue::dynamic(
                unresolved.importer,
                usage_span,
                DynamicReason::UnresolvedImport(Box::new(unresolved)),
            );
        }
    };
    let importer_path = ctx.engine.lookup_path(unresolved.importer);
    let mut value = resolve_named_export(
        ctx,
        &importer_path,
        unresolved.specifier.clone(),
        export_name,
        unresolved.clone(),
        usage_span,
        visited,
        depth,
        foreign,
    )
    .await;

    // The import binding is the importing file's name for the symbol — the last hop of the
    // alias chain the chase built for the files between here and the declaration.
    if let ResolvedValue::Reference(ref_val) = &mut value {
        if !unresolved.is_namespace_member
            && !ref_val
                .aliases
                .iter()
                .any(|(file, _)| *file == unresolved.importer)
        {
            ref_val
                .aliases
                .push((unresolved.importer, unresolved.local_name.clone()));
        }
    }
    value
}

/// Resolve `export_name` of the module `specifier` (relative to `from_dir`), chasing
/// re-exports — but for *values*, not just classes.
#[allow(clippy::too_many_arguments)]
fn resolve_named_export<'a, Fs: ResourceResolverFs + Clone + 'static>(
    ctx: &'a QueryContext<Fs>,
    file_path: &'a Path,
    specifier: String,
    export_name: String,
    unresolved: UnresolvedReference,
    usage_span: Span,
    visited: &'a mut HashSet<(FileId, String)>,
    depth: usize,
    foreign: &'a [&'a dyn ForeignFunctionResolver],
) -> BoxFuture<'a, ResolvedValue> {
    async move {
        if depth >= MAX_FILE_DEPTH {
            return ResolvedValue::dynamic(
                unresolved.importer,
                usage_span,
                DynamicReason::DepthLimit,
            );
        }

        let mut chase_visited = HashSet::new();
        let chased_decl = crate::evaluator::cross_file::cross_file_resolve(
            ctx,
            file_path,
            Some(&specifier),
            export_name.clone(),
            &mut chase_visited,
        )
        .await;

        match chased_decl {
            Ok(Some(decl)) => {
                let decl_file_id = ctx.engine.intern_path(&decl.file_path);

                let syntax = ctx.analyze_file_syntax(decl_file_id).await;
                let parsed = ctx.parse_file(decl_file_id).await;
                let symbol_name = {
                    let guard = parsed.lock().unwrap();
                    let dep = guard.borrow_dependent();
                    dep.semantic
                        .scoping()
                        .symbol_name(decl.symbol_id)
                        .to_string()
                };

                if let Some(info) = syntax.class_index.get(&symbol_name) {
                    return ResolvedValue::Reference(ValueReference {
                        file: decl_file_id,
                        name: info.class_name.clone(),
                        member: None,
                        reference_id: Some(info.reference_id),
                        span: Span::new(info.name_span.start, info.name_span.end),
                        kind: DeclKind::Class,
                        owning_reference: decl.owning_reference.clone(),
                        synthetic: false,
                        aliases: decl.aliases,
                        is_default_export: decl.exported_as_default,
                    });
                }

                if !decl
                    .flags
                    .intersects(oxc_syntax::symbol::SymbolFlags::Value)
                {
                    return ResolvedValue::dynamic(
                        decl_file_id,
                        usage_span,
                        DynamicReason::ExportNotFound,
                    );
                }

                let probe = {
                    let guard = parsed.lock().unwrap();
                    let dep = guard.borrow_dependent();
                    let import_map = extract_import_map(&dep.module_record);
                    let input = EvalInput {
                        semantic: &dep.semantic,
                        file: decl_file_id,
                        import_map: &import_map,
                        mode: EvalMode::Semantic,
                        env: &ResolvedEnv::new(),
                        foreign,
                    };
                    evaluate_symbol_declaration(decl.symbol_id, &input)
                };

                let completed = complete_value(
                    ctx,
                    decl_file_id,
                    EvalTask::Export {
                        name: symbol_name.clone(),
                    },
                    Some(probe),
                    visited,
                    depth + 1,
                    foreign,
                )
                .await;
                apply_owning_reference(
                    completed,
                    decl_file_id,
                    decl.owning_reference
                        .map(|o| ImportPath::Absolute(o.specifier)),
                )
            }
            Err(crate::evaluator::cross_file::ChaseSymbolError::DepthLimitExceeded) => {
                ResolvedValue::dynamic(unresolved.importer, usage_span, DynamicReason::DepthLimit)
            }
            Err(crate::evaluator::cross_file::ChaseSymbolError::CycleDetected) => {
                let file_id =
                    resolve_specifier(ctx.engine.resolver.as_ref(), file_path, &specifier)
                        .map(|p| ctx.engine.intern_path(&p))
                        .unwrap_or(unresolved.importer);
                ResolvedValue::dynamic(file_id, usage_span, DynamicReason::ImportCycle)
            }
            Ok(None) => {
                let file_id =
                    resolve_specifier(ctx.engine.resolver.as_ref(), file_path, &specifier)
                        .map(|p| ctx.engine.intern_path(&p))
                        .unwrap_or(unresolved.importer);
                ResolvedValue::dynamic(
                    file_id,
                    usage_span,
                    DynamicReason::UnresolvedImport(Box::new(unresolved)),
                )
            }
        }
    }
    .boxed()
}

// ==================================================================== export bindings

enum ExportBinding<'r, 'a> {
    /// The export binds a top-level symbol (`export const X`, `export class X`,
    /// `export default class X`, …).
    Symbol(ReferenceId),
    /// `export default <expression>` with no binding.
    DefaultExpression(&'r Expression<'a>),
}

/// Find what a named export of this file binds to, using the module record.
fn find_export_binding<'r, 'a>(
    dep: &'r crate::types::ParsedFileDependent<'a>,
    file_id: FileId,
    export_name: &str,
) -> Option<ExportBinding<'r, 'a>> {
    let entry = dep
        .module_record
        .local_export_entries
        .iter()
        .find(|entry| match &entry.export_name {
            ExportExportName::Name(name) => name.name == export_name,
            ExportExportName::Default(_) => export_name == "default",
            ExportExportName::Null => false,
        })?;

    if let Some(local_name) = entry.local_name.name() {
        let symbol_id = dep
            .semantic
            .scoping()
            .get_root_binding(local_name.as_str().into())?;
        let reference_id = ReferenceId::new(file_id, symbol_id);
        return Some(ExportBinding::Symbol(reference_id));
    }

    // `export default <expression>`: no local binding; find the declaration node.
    for node in dep.semantic.nodes() {
        let AstKind::ExportDefaultDeclaration(decl) = node.kind() else {
            continue;
        };
        let Some(expr) = decl.declaration.as_expression() else {
            continue;
        };
        return Some(ExportBinding::DefaultExpression(expr));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fs::OverlayFileSystem;
    use crate::query::{QueryEngine, QueryKey};
    use crate::resource_registry::ResourceRegistry;
    use oxc_resolver::{ResolveOptions, ResolverGeneric};
    use std::path::PathBuf;
    use std::sync::Arc;
    use std::time::Duration;

    fn build_engine(
        files: &[(&str, &str)],
        entrypoints: &[&str],
    ) -> Arc<QueryEngine<OverlayFileSystem>> {
        let fs = crate::test_utils::create_test_fs(files);
        let resolver = Arc::new(ResolverGeneric::new_with_file_system(
            fs.clone(),
            ResolveOptions {
                extensions: vec![".ts".into(), ".tsx".into(), ".d.ts".into(), ".js".into()],
                ..ResolveOptions::default()
            },
        ));
        let registry = Arc::new(ResourceRegistry::default());
        let entrypoints = Arc::new(std::sync::RwLock::new(
            entrypoints.iter().map(PathBuf::from).collect::<Vec<_>>(),
        ));
        QueryEngine::new_default(fs, resolver, registry, entrypoints)
    }

    /// Run a future on a worker thread with a deadline, so a regression toward deadlock (the
    /// reason the driver is NOT a cached query) fails the test instead of hanging the suite.
    fn block_on_with_timeout<T: Send + 'static>(
        fut: impl std::future::Future<Output = T> + Send + 'static,
    ) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = tx.send(futures::executor::block_on(fut));
        });
        rx.recv_timeout(Duration::from_secs(30))
            .expect("evaluation deadlocked or timed out")
    }

    fn expect_component(class: &crate::analyzer::ClassData) -> &crate::analyzer::ComponentData {
        let Some(component) = class.as_component() else {
            panic!("expected a component classification");
        };
        component
    }

    const APP_WITH_SHARED: &str = r#"
        import { Component } from '@angular/core';
        import { SHARED } from './shared';
        @Component({
            selector: 'app',
            standalone: true,
            imports: SHARED,
            template: '<lib-foo></lib-foo>'
        })
        export class AppComponent {}
    "#;

    const SHARED_CONSTS: &str = r#"
        import { FooComponent } from './foo.component';
        import { BarDirective } from './bar.directive';
        export const SHARED = [FooComponent, BarDirective];
    "#;

    const FOO_COMPONENT: &str = r#"
        import { Component } from '@angular/core';
        @Component({ selector: 'lib-foo', standalone: true, template: '' })
        export class FooComponent {}
    "#;

    const BAR_DIRECTIVE: &str = r#"
        import { Directive } from '@angular/core';
        @Directive({ selector: '[libBar]', standalone: true })
        export class BarDirective {}
    "#;

    #[test]
    fn cross_file_const_array_in_standalone_imports() {
        let engine = build_engine(
            &[
                ("/app/app.component.ts", APP_WITH_SHARED),
                ("/app/shared.ts", SHARED_CONSTS),
                ("/app/foo.component.ts", FOO_COMPONENT),
                ("/app/bar.directive.ts", BAR_DIRECTIVE),
            ],
            &["/app/app.component.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });

        let app_id = engine.intern_path("/app/app.component.ts");
        let component = expect_component(&result.classes[0]);
        let decls = component.resolved_declarations.as_ref().unwrap();
        let names: Vec<&str> = decls
            .iter()
            .map(|d| d.reference.name_in_file(app_id))
            .collect();
        // `app.component.ts` imports only `SHARED`, so it has no binding for either
        // declaration: both must be emitted through a generated import of their real
        // exported names, never through an invented identifier.
        assert!(names.contains(&"FooComponent"), "got: {names:?}");
        assert!(names.contains(&"BarDirective"), "got: {names:?}");
        let foo = decls
            .iter()
            .find(|d| d.reference.name_in_file(app_id) == "FooComponent")
            .unwrap();
        assert!(!foo.reference.is_in_scope_of(app_id));
        assert_eq!(
            foo.reference
                .aliases
                .get(&engine.intern_path("/app/shared.ts")),
            Some(&"FooComponent".to_string()),
            "the barrel that imported it must record its name there"
        );
        let foo_id = engine.intern_path("/app/foo.component.ts");
        assert!(foo.reference.owning_reference.is_none());
        assert_eq!(foo.reference.file, foo_id);
        assert!(
            component.raw_imports_span.is_none(),
            "fully evaluated imports must clear the runtime fallback"
        );
    }

    #[test]
    fn nested_imported_const_array_in_imports() {
        let app = r#"
            import { Component } from '@angular/core';
            import { SHARED } from './shared';
            import { BazComponent } from './baz.component';
            @Component({
                selector: 'app',
                standalone: true,
                imports: [SHARED, BazComponent],
                template: ''
            })
            export class AppComponent {}
        "#;
        let baz = r#"
            import { Component } from '@angular/core';
            @Component({ selector: 'baz', standalone: true, template: '' })
            export class BazComponent {}
        "#;
        let engine = build_engine(
            &[
                ("/app/app.component.ts", app),
                ("/app/shared.ts", SHARED_CONSTS),
                ("/app/foo.component.ts", FOO_COMPONENT),
                ("/app/bar.directive.ts", BAR_DIRECTIVE),
                ("/app/baz.component.ts", baz),
            ],
            &["/app/app.component.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });

        let app_id = engine.intern_path("/app/app.component.ts");
        let component = expect_component(&result.classes[0]);
        let decls = component.resolved_declarations.as_ref().unwrap();
        let names: Vec<&str> = decls
            .iter()
            .map(|d| d.reference.name_in_file(app_id))
            .collect();
        assert_eq!(
            names.len(),
            3,
            "nested array must flatten imports: {names:?}"
        );
        assert!(names.contains(&"FooComponent"));
        assert!(names.contains(&"BarDirective"));
        assert!(names.contains(&"BazComponent"));
        assert!(component.raw_imports_span.is_none());
    }

    #[test]
    fn module_with_providers_map_in_imports() {
        let app = r#"
            import { Component } from '@angular/core';
            import { FooModule } from './foo.module';
            const MWP = { ngModule: FooModule, providers: [] };
            @Component({
                selector: 'app',
                standalone: true,
                imports: [MWP],
                template: ''
            })
            export class AppComponent {}
        "#;
        let foo_module = r#"
            import { NgModule } from '@angular/core';
            @NgModule({})
            export class FooModule {}
        "#;
        let engine = build_engine(
            &[
                ("/app/app.component.ts", app),
                ("/app/foo.module.ts", foo_module),
            ],
            &["/app/app.component.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });

        let app_id = engine.intern_path("/app/app.component.ts");
        let component = expect_component(&result.classes[0]);
        let decls = component.resolved_declarations.as_ref().unwrap();
        let names: Vec<&str> = decls
            .iter()
            .map(|d| d.reference.name_in_file(app_id))
            .collect();
        assert_eq!(names, vec!["FooModule"]);
        assert!(component.raw_imports_span.is_none());
    }

    #[test]
    fn spread_local_const_array_in_imports() {
        let app = r#"
            import { Component, Directive } from '@angular/core';
            @Component({ selector: 'foo', standalone: true, template: '' })
            export class FooComponent {}
            @Directive({ selector: '[bar]', standalone: true })
            export class BarDirective {}
            @Component({ selector: 'baz', standalone: true, template: '' })
            export class BazComponent {}

            const LOCAL = [FooComponent, BarDirective] as const;

            @Component({
                selector: 'app',
                standalone: true,
                imports: [...LOCAL, BazComponent],
                template: ''
            })
            export class AppComponent {}
        "#;
        let engine = build_engine(
            &[("/app/app.component.ts", app)],
            &["/app/app.component.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });

        let app_id = engine.intern_path("/app/app.component.ts");
        let component = expect_component(&result.classes[3]);
        let decls = component.resolved_declarations.as_ref().unwrap();
        let names: Vec<&str> = decls
            .iter()
            .map(|d| d.reference.name_in_file(app_id))
            .collect();
        assert_eq!(names.len(), 3, "spread of local array: {names:?}");
        assert!(names.contains(&"FooComponent"));
        assert!(names.contains(&"BarDirective"));
        assert!(names.contains(&"BazComponent"));
        assert!(component.raw_imports_span.is_none());
    }

    #[test]
    fn namespace_import_member_in_imports() {
        let app = r#"
            import { Component } from '@angular/core';
            import * as shared from './shared';
            @Component({
                selector: 'app',
                standalone: true,
                imports: [shared.FooComponent],
                template: ''
            })
            export class AppComponent {}
        "#;
        let shared = r#"
            import { Component } from '@angular/core';
            @Component({ selector: 'foo', standalone: true, template: '' })
            export class FooComponent {}
        "#;
        let engine = build_engine(
            &[("/app/app.component.ts", app), ("/app/shared.ts", shared)],
            &["/app/app.component.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });

        let app_id = engine.intern_path("/app/app.component.ts");
        let component = expect_component(&result.classes[0]);
        let decls = component.resolved_declarations.as_ref().unwrap();
        let names: Vec<&str> = decls
            .iter()
            .map(|d| d.reference.name_in_file(app_id))
            .collect();
        assert_eq!(names, vec!["FooComponent"]);
        assert!(component.raw_imports_span.is_none());
    }

    #[test]
    fn wildcard_export_with_local_binding_precedence() {
        let app = r#"
            import { Component } from '@angular/core';
            import { MyComponent } from './barrel';
            @Component({
                selector: 'app',
                standalone: true,
                imports: [MyComponent],
                template: ''
            })
            export class AppComponent {}
        "#;
        let barrel = r#"
            export * from './other';
            import { Component } from '@angular/core';
            @Component({ selector: 'my-comp', standalone: true, template: '' })
            export class MyComponent {}
        "#;
        let other = r#"
            import { Component } from '@angular/core';
            @Component({ selector: 'other-comp', standalone: true, template: '' })
            export class OtherComponent {}
        "#;
        let engine = build_engine(
            &[
                ("/app/app.component.ts", app),
                ("/app/barrel.ts", barrel),
                ("/app/other.ts", other),
            ],
            &["/app/app.component.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });

        let app_id = engine.intern_path("/app/app.component.ts");
        let component = expect_component(&result.classes[0]);
        let decls = component.resolved_declarations.as_ref().unwrap();
        let names: Vec<&str> = decls
            .iter()
            .map(|d| d.reference.name_in_file(app_id))
            .collect();
        assert_eq!(names, vec!["MyComponent"]);
        assert!(component.raw_imports_span.is_none());
    }

    #[test]
    fn spread_of_imported_const_array() {
        let app = r#"
            import { Component } from '@angular/core';
            import { SHARED } from './shared';
            import { BazComponent } from './baz.component';
            @Component({
                selector: 'app',
                standalone: true,
                imports: [...SHARED, BazComponent],
                template: ''
            })
            export class AppComponent {}
        "#;
        let baz = r#"
            import { Component } from '@angular/core';
            @Component({ selector: 'baz', standalone: true, template: '' })
            export class BazComponent {}
        "#;
        let engine = build_engine(
            &[
                ("/app/app.component.ts", app),
                ("/app/shared.ts", SHARED_CONSTS),
                ("/app/foo.component.ts", FOO_COMPONENT),
                ("/app/bar.directive.ts", BAR_DIRECTIVE),
                ("/app/baz.component.ts", baz),
            ],
            &["/app/app.component.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });

        let app_id = engine.intern_path("/app/app.component.ts");
        let component = expect_component(&result.classes[0]);
        let decls = component.resolved_declarations.as_ref().unwrap();
        let names: Vec<&str> = decls
            .iter()
            .map(|d| d.reference.name_in_file(app_id))
            .collect();
        assert_eq!(
            names.len(),
            3,
            "spread must splice the imported array: {names:?}"
        );
        assert!(names.contains(&"FooComponent"));
        assert!(names.contains(&"BarDirective"));
        // Directly imported here, so this one *is* nameable without a generated import.
        assert!(names.contains(&"BazComponent"));
        let baz = decls
            .iter()
            .find(|d| d.reference.name_in_file(app_id) == "BazComponent")
            .unwrap();
        assert!(baz.reference.is_in_scope_of(app_id));
        assert!(component.raw_imports_span.is_none());
    }

    /// Every file the evaluation passes through that *binds* the symbol records the name it
    /// binds it under, so a consumer can ask "what do I call this here?" for any of them.
    #[test]
    fn alias_chain_records_every_binding_file() {
        let user = r#"
            import { Component } from '@angular/core';
            import { Something as Thing } from './somewhere';
            @Component({ selector: 'app', standalone: true, imports: [Thing], template: '' })
            export class MyCmp {}
        "#;
        // `Something` is imported *and* re-exported here, so this file binds it too — unlike a
        // bare `export {Something} from './elsewhere'`, which would introduce no binding.
        let somewhere = r#"
            import { Something } from './elsewhere';
            export { Something };
        "#;
        let elsewhere = r#"
            import { Directive } from '@angular/core';
            @Directive({ selector: '[something]', standalone: true })
            export class Something {}
        "#;
        let engine = build_engine(
            &[
                ("/app/user.ts", user),
                ("/app/somewhere.ts", somewhere),
                ("/app/elsewhere.ts", elsewhere),
            ],
            &["/app/user.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/user.ts"))
                .await
        });

        let user_id = engine.intern_path("/app/user.ts");
        let somewhere_id = engine.intern_path("/app/somewhere.ts");
        let elsewhere_id = engine.intern_path("/app/elsewhere.ts");

        let decls = expect_component(&result.classes[0])
            .resolved_declarations
            .as_ref()
            .unwrap();
        assert_eq!(decls.len(), 1, "got: {decls:?}");
        let reference = &decls[0].reference;

        assert_eq!(reference.name, "Something");
        assert_eq!(reference.file, elsewhere_id);
        assert_eq!(reference.name_in_file(user_id), "Thing");
        assert_eq!(reference.name_in_file(somewhere_id), "Something");
        assert_eq!(reference.name_in_file(elsewhere_id), "Something");
        assert_eq!(reference.aliases.len(), 3, "got: {:?}", reference.aliases);

        // The consumer binds it, so it is emitted by name rather than through an import.
        assert!(reference.is_in_scope_of(user_id));
        assert_eq!(decls[0].ref_meta.local_alias.as_deref(), Some("Thing"));
    }

    /// A package barrel may rename on the way out. Importers must use the *barrel's* name,
    /// not the declared one — `lib` has no export called `InternalDir`.
    #[test]
    fn package_barrel_rename_is_the_importable_name() {
        let app = r#"
            import { Component } from '@angular/core';
            import { PublicDir } from 'lib';
            @Component({ selector: 'app', standalone: true, imports: [PublicDir], template: '' })
            export class AppComponent {}
        "#;
        let engine = build_engine(
            &[
                ("/app/app.component.ts", app),
                (
                    "/app/node_modules/lib/index.ts",
                    "export { InternalDir as PublicDir } from './deep';",
                ),
                (
                    "/app/node_modules/lib/deep.ts",
                    r#"
                    import { Directive } from '@angular/core';
                    @Directive({ selector: '[pub]', standalone: true })
                    export class InternalDir {}
                "#,
                ),
            ],
            &["/app/app.component.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });

        let decls = expect_component(&result.classes[0])
            .resolved_declarations
            .as_ref()
            .unwrap();
        assert_eq!(decls.len(), 1, "got: {decls:?}");
        let reference = &decls[0].reference;

        // The declaration keeps its real name...
        assert_eq!(reference.name, "InternalDir");
        // ...but an import through the package must ask for what the package exports.
        let owning = reference
            .owning_reference
            .as_ref()
            .expect("reached through a package specifier");
        assert_eq!(owning.specifier, "lib");
        assert_eq!(owning.export_name, "PublicDir");
        assert_eq!(reference.export_name(), "PublicDir");

        let importable = decls[0]
            .ref_meta
            .typecheck_import
            .as_ref()
            .expect("declared in another file");
        assert_eq!(importable.specifier, "lib");
        assert_eq!(importable.symbol, "PublicDir");
    }

    /// Same rename, but reached through an NgModule's export scope — the consumer imports only
    /// the module, so the directive is never nameable locally and *must* go through the
    /// package's published name.
    #[test]
    fn package_barrel_rename_through_module_scope() {
        let app = r#"
            import { Component } from '@angular/core';
            import { LibModule } from 'lib';
            @Component({ selector: 'app', standalone: true, imports: [LibModule], template: '' })
            export class AppComponent {}
        "#;
        let engine = build_engine(
            &[
                ("/app/app.component.ts", app),
                (
                    "/app/node_modules/lib/index.ts",
                    "export { InternalDir as PublicDir, LibModule } from './deep';",
                ),
                (
                    "/app/node_modules/lib/deep.ts",
                    r#"
                    import { Directive, NgModule } from '@angular/core';
                    @Directive({ selector: '[pub]' })
                    export class InternalDir {}
                    @NgModule({ declarations: [InternalDir], exports: [InternalDir] })
                    export class LibModule {}
                "#,
                ),
            ],
            &["/app/app.component.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });
        let decls = expect_component(&result.classes[0])
            .resolved_declarations
            .as_ref()
            .unwrap();
        let dir = decls
            .iter()
            .find(|d| d.reference.name == "InternalDir")
            .expect("the module's exported directive joins the scope");

        // Not imported by the consumer, so there is no local name to fall back on.
        assert!(dir.ref_meta.local_alias.is_none());
        let importable = dir.ref_meta.typecheck_import.as_ref().unwrap();
        assert_eq!(importable.specifier, "lib");
        assert_eq!(
            importable.symbol, "PublicDir",
            "`lib` publishes no `InternalDir`; importing that name emits a dangling reference"
        );
    }

    /// A file that only forwards a symbol cannot name it: recording an alias there would emit
    /// an identifier that does not exist in that file.
    #[test]
    fn bare_reexport_contributes_no_alias() {
        let user = r#"
            import { Component } from '@angular/core';
            import { Something } from './barrel';
            @Component({ selector: 'app', standalone: true, imports: [Something], template: '' })
            export class MyCmp {}
        "#;
        let engine = build_engine(
            &[
                ("/app/user.ts", user),
                ("/app/barrel.ts", "export { Something } from './elsewhere';"),
                (
                    "/app/elsewhere.ts",
                    r#"
                    import { Directive } from '@angular/core';
                    @Directive({ selector: '[something]', standalone: true })
                    export class Something {}
                "#,
                ),
            ],
            &["/app/user.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/user.ts"))
                .await
        });

        let barrel_id = engine.intern_path("/app/barrel.ts");
        let decls = expect_component(&result.classes[0])
            .resolved_declarations
            .as_ref()
            .unwrap();
        let reference = &decls[0].reference;
        assert!(
            !reference.is_in_scope_of(barrel_id),
            "a pure re-export binds nothing: {:?}",
            reference.aliases
        );
    }

    #[test]
    fn const_array_through_barrel_reexports() {
        let app = r#"
            import { Component } from '@angular/core';
            import { SHARED } from './barrel';
            @Component({ selector: 'app', standalone: true, imports: SHARED, template: '' })
            export class AppComponent {}
        "#;
        let engine = build_engine(
            &[
                ("/app/app.component.ts", app),
                ("/app/barrel.ts", "export { SHARED } from './inner';"),
                ("/app/inner.ts", "export * from './shared';"),
                ("/app/shared.ts", SHARED_CONSTS),
                ("/app/foo.component.ts", FOO_COMPONENT),
                ("/app/bar.directive.ts", BAR_DIRECTIVE),
            ],
            &["/app/app.component.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let ctx_for_deps = ctx.clone();
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });

        let app_id = engine.intern_path("/app/app.component.ts");
        let component = expect_component(&result.classes[0]);
        let decls = component.resolved_declarations.as_ref().unwrap();
        let names: Vec<&str> = decls
            .iter()
            .map(|d| d.reference.name_in_file(app_id))
            .collect();
        assert!(names.contains(&"FooComponent"), "got: {names:?}");
        assert!(names.contains(&"BarDirective"), "got: {names:?}");

        // Every barrel traversed must be a recorded dependency (invalidation correctness).
        let deps = ctx_for_deps.dependencies();
        for file in ["/app/barrel.ts", "/app/inner.ts", "/app/shared.ts"] {
            let id = engine.intern_path(file);
            assert!(deps.contains(&id), "{file} must be a recorded dependency");
        }
    }

    #[test]
    fn cyclic_const_imports_terminate_with_fallback() {
        let app = r#"
            import { Component } from '@angular/core';
            import { A } from './a';
            @Component({ selector: 'app', standalone: true, imports: A, template: '' })
            export class AppComponent {}
        "#;
        let engine = build_engine(
            &[
                ("/app/app.component.ts", app),
                (
                    "/app/a.ts",
                    "import { B } from './b'; export const A = [B];",
                ),
                (
                    "/app/b.ts",
                    "import { A } from './a'; export const B = [A];",
                ),
            ],
            &["/app/app.component.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });

        // The whole point versus a query-cached design: cycles terminate instead of
        // deadlocking, and the component keeps its runtime fallback.
        let component = expect_component(&result.classes[0]);
        assert!(component.raw_imports_span.is_some());
    }

    #[test]
    fn module_with_providers_structural_ts() {
        let widget_module = r#"
            import { NgModule } from '@angular/core';
            import { WidgetComponent } from './widget.component';
            @NgModule({ declarations: [WidgetComponent], exports: [WidgetComponent] })
            export class WidgetModule {}
            export class WidgetProviders {
                static forRoot() {
                    return { ngModule: WidgetModule, providers: [] };
                }
            }
        "#;
        let app_module = r#"
            import { NgModule } from '@angular/core';
            import { WidgetProviders } from './widget.module';
            @NgModule({ imports: [WidgetProviders.forRoot()] })
            export class AppModule {}
        "#;
        let widget_component = r#"
            import { Component } from '@angular/core';
            @Component({ selector: 'widget', template: '' })
            export class WidgetComponent {}
        "#;
        let engine = build_engine(
            &[
                ("/app/app.module.ts", app_module),
                ("/app/widget.module.ts", widget_module),
                ("/app/widget.component.ts", widget_component),
            ],
            &[
                "/app/app.module.ts",
                "/app/widget.module.ts",
                "/app/widget.component.ts",
            ],
        );
        let ctx = QueryContext::new(engine.clone());
        let scope = block_on_with_timeout(async move {
            let syntax = ctx
                .analyze_file_syntax(ctx.engine.intern_path("/app/app.module.ts"))
                .await;
            let app_module_symbol = syntax.classes[0].reference_id;
            ctx.ngmodule_imports_scope(app_module_symbol).await
        });

        // forRoot()'s structural { ngModule: WidgetModule } pulls WidgetModule's exports scope.
        let names: Vec<&str> = scope
            .declarations
            .iter()
            .map(|d| d.reference.name())
            .collect();
        assert!(
            names.contains(&"WidgetComponent"),
            "imports scope must contain the MWP module's exports: {names:?}"
        );
    }

    #[test]
    fn module_with_providers_dts_return_type() {
        let app_module = r#"
            import { NgModule } from '@angular/core';
            import { RouterModule } from 'router-lib';
            @NgModule({ imports: [RouterModule.forRoot([])] })
            export class AppModule {}
        "#;
        // Body-less static method whose return type names the module (the `.d.ts` pattern).
        let router_dts = r#"
            import { ModuleWithProviders } from '@angular/core';
            export declare class RouterModule {
                static forRoot(routes: unknown[]): ModuleWithProviders<RouterModule>;
            }
        "#;
        let core_dts = "export declare type ModuleWithProviders<T> = { ngModule: unknown };";
        let engine = build_engine(
            &[
                ("/app/app.module.ts", app_module),
                ("/app/node_modules/router-lib/index.d.ts", router_dts),
                ("/app/node_modules/@angular/core/index.d.ts", core_dts),
            ],
            &["/app/app.module.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let value = block_on_with_timeout(async move {
            let syntax = ctx
                .analyze_file_syntax(ctx.engine.intern_path("/app/app.module.ts"))
                .await;
            let class_syntax = &syntax.classes[0];
            let mut imports = class_syntax
                .as_ng_module()
                .and_then(|m| m.imports.as_ref())
                .expect("imports evaluation must exist")
                .clone();
            imports
                .complete_with(
                    &ctx,
                    crate::analyzer::resolvers::angular_foreign_resolvers(),
                )
                .await;
            imports.raw().clone()
        });

        let ResolvedValue::Array(items) = &value else {
            panic!("expected array, got {value:?}");
        };
        let ResolvedValue::Synthetic(
            crate::evaluator::value::SyntheticValue::ModuleWithProviders { ng_module, .. },
        ) = &items[0]
        else {
            panic!("expected ModuleWithProviders synthetic, got {:?}", items[0]);
        };
        assert_eq!(ng_module.name, "RouterModule");
        let owning = ng_module
            .owning_reference
            .as_ref()
            .expect("the ngModule must stay importable via the package specifier");
        assert_eq!(owning.specifier, "router-lib");
        assert_eq!(owning.export_name, "RouterModule");
    }

    /// NgRx's real shape, as written by `//devtools/codereview/webclient:critique` and
    /// `//production/incident_response_management/ui/app:app`: `StoreModule.forFeature` is an
    /// *overload set* of generic static methods whose declared return type names a module
    /// (`StoreFeatureModule`) that is not the callee.
    ///
    /// Pinned because these calls were once blamed for collapsing those targets' NgModule
    /// scopes. They are not to blame — like ngtsc, the recognizer resolves them statically.
    #[test]
    fn module_with_providers_overloaded_generic_dts() {
        let app_module = r#"
            import { NgModule } from '@angular/core';
            import { StoreModule } from '@ngrx/store';
            @NgModule({ imports: [StoreModule.forFeature('feat', {})] })
            export class AppModule {}
        "#;
        let store_dts = r#"
            import * as i0 from '@angular/core';
            import { ModuleWithProviders } from '@angular/core';
            export declare class StoreFeatureModule {
                static ɵfac: i0.ɵɵFactoryDeclaration<StoreFeatureModule, never>;
                static ɵmod: i0.ɵɵNgModuleDeclaration<StoreFeatureModule, never, never, never>;
                static ɵinj: i0.ɵɵInjectorDeclaration<StoreFeatureModule>;
            }
            export declare class StoreModule {
                static forFeature<T, V extends Action = Action>(featureName: string, reducers: ActionReducerMap<T, V>, config?: StoreConfig<T, V>): ModuleWithProviders<StoreFeatureModule>;
                static forFeature<T, V extends Action = Action>(featureName: string, reducer: ActionReducer<T, V>, config?: StoreConfig<T, V>): ModuleWithProviders<StoreFeatureModule>;
                static forFeature<T, V extends Action = Action>(slice: FeatureSlice<T, V>): ModuleWithProviders<StoreFeatureModule>;
                static ɵfac: i0.ɵɵFactoryDeclaration<StoreModule, never>;
                static ɵmod: i0.ɵɵNgModuleDeclaration<StoreModule, never, never, never>;
                static ɵinj: i0.ɵɵInjectorDeclaration<StoreModule>;
            }
        "#;
        let core_dts = "export declare type ModuleWithProviders<T> = { ngModule: unknown };";
        let engine = build_engine(
            &[
                ("/app/app.module.ts", app_module),
                ("/app/node_modules/@ngrx/store/index.d.ts", store_dts),
                ("/app/node_modules/@angular/core/index.d.ts", core_dts),
            ],
            &["/app/app.module.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let value = block_on_with_timeout(async move {
            let syntax = ctx
                .analyze_file_syntax(ctx.engine.intern_path("/app/app.module.ts"))
                .await;
            let class_syntax = &syntax.classes[0];
            let mut imports = class_syntax
                .as_ng_module()
                .and_then(|m| m.imports.as_ref())
                .expect("imports evaluation must exist")
                .clone();
            imports
                .complete_with(
                    &ctx,
                    crate::analyzer::resolvers::angular_foreign_resolvers(),
                )
                .await;
            imports.raw().clone()
        });

        let ResolvedValue::Array(items) = &value else {
            panic!("expected array, got {value:?}");
        };
        // ngtsc reads the *declared return type*, never the arguments, so an overload set is
        // no obstacle: `createModuleWithProvidersResolver` yields `StoreFeatureModule` and the
        // entry is a perfectly static reference. Nothing here is a `DynamicValue`, so ngtsc
        // raises no NG1010 and the importing module's scope stays complete.
        let ResolvedValue::Synthetic(
            crate::evaluator::value::SyntheticValue::ModuleWithProviders { ng_module, .. },
        ) = &items[0]
        else {
            panic!("expected ModuleWithProviders synthetic, got {:?}", items[0]);
        };
        assert_eq!(ng_module.name, "StoreFeatureModule");
        let owning = ng_module
            .owning_reference
            .as_ref()
            .expect("the ngModule must stay importable via the package specifier");
        assert_eq!(owning.specifier, "@ngrx/store");
    }

    #[test]
    fn ngmodule_array_spread_in_declarations() {
        let app_module = r#"
            import { NgModule } from '@angular/core';
            import { FooComponent } from './foo.component';
            import { EXTRA } from './extra';
            @NgModule({ declarations: [FooComponent, ...EXTRA] })
            export class AppModule {}
        "#;
        let extra = r#"
            import { BarDirective } from './bar.directive';
            export const EXTRA = [BarDirective];
        "#;
        let engine = build_engine(
            &[
                ("/app/app.module.ts", app_module),
                ("/app/extra.ts", extra),
                ("/app/foo.component.ts", FOO_COMPONENT),
                ("/app/bar.directive.ts", BAR_DIRECTIVE),
            ],
            &[
                "/app/app.module.ts",
                "/app/foo.component.ts",
                "/app/bar.directive.ts",
            ],
        );
        let ctx = QueryContext::new(engine.clone());
        let scope = block_on_with_timeout(async move {
            let syntax = ctx
                .analyze_file_syntax(ctx.engine.intern_path("/app/app.module.ts"))
                .await;
            let app_module_symbol = syntax.classes[0].reference_id;
            ctx.ngmodule_imports_scope(app_module_symbol).await
        });

        let names: Vec<&str> = scope
            .declarations
            .iter()
            .map(|d| d.reference.name())
            .collect();
        assert!(names.contains(&"FooComponent"), "got: {names:?}");
        assert!(
            names.contains(&"BarDirective"),
            "spread of an imported const array must contribute declarations: {names:?}"
        );
    }

    #[test]
    fn edit_to_referenced_const_file_invalidates_consumer() {
        let engine = build_engine(
            &[
                ("/app/app.component.ts", APP_WITH_SHARED),
                ("/app/shared.ts", SHARED_CONSTS),
                ("/app/foo.component.ts", FOO_COMPONENT),
                ("/app/bar.directive.ts", BAR_DIRECTIVE),
            ],
            &["/app/app.component.ts"],
        );

        // Prime the semantic query.
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });
        assert_eq!(
            expect_component(&result.classes[0])
                .resolved_declarations
                .as_ref()
                .unwrap()
                .len(),
            2
        );

        // The transitively-referenced const file must map back to the consumer's semantic key.
        let app_id = engine.intern_path("/app/app.component.ts");
        let shared_id = engine.intern_path("/app/shared.ts");
        let foo_id = engine.intern_path("/app/foo.component.ts");
        {
            let index = engine.reverse_index.read().unwrap();
            for (label, id) in [("shared.ts", shared_id), ("foo.component.ts", foo_id)] {
                let keys = index.get(&id).unwrap_or_else(|| {
                    panic!("{label} must appear in the reverse index");
                });
                assert!(
                    keys.contains(&QueryKey::AnalyzeFileSemantic(app_id)),
                    "{label} must invalidate the consuming component's semantic query"
                );
            }
        }

        // Edit the const file: drop BarDirective from the shared array.
        let evicted = engine.invalidate_file(Path::new("/app/shared.ts"));
        assert!(evicted.contains(&QueryKey::AnalyzeFileSemantic(app_id)));
        engine.fs.upsert_file(
            PathBuf::from("/app/shared.ts"),
            r#"
                import { FooComponent } from './foo.component';
                export const SHARED = [FooComponent];
            "#
            .to_string(),
        );

        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });
        let decls = expect_component(&result.classes[0])
            .resolved_declarations
            .as_ref()
            .unwrap();
        assert_eq!(decls.len(), 1, "stale cache: edit was not picked up");
        assert_eq!(decls[0].reference.name_in_file(app_id), "FooComponent");
    }

    #[test]
    fn unresolvable_import_keeps_runtime_fallback() {
        let app = r#"
            import { Component } from '@angular/core';
            import { THINGS } from 'not-installed-pkg';
            @Component({ selector: 'app', standalone: true, imports: THINGS, template: '' })
            export class AppComponent {}
        "#;
        let engine = build_engine(
            &[("/app/app.component.ts", app)],
            &["/app/app.component.ts"],
        );
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });
        let component = expect_component(&result.classes[0]);
        assert!(
            component.raw_imports_span.is_some(),
            "an unresolvable import must keep the runtime-resolution fallback"
        );
    }

    #[test]
    fn deep_reexport_chain_hits_depth_limit_gracefully() {
        let mut files: Vec<(String, String)> = Vec::new();
        files.push((
            "/app/app.component.ts".to_string(),
            r#"
                import { Component } from '@angular/core';
                import { SHARED } from './hop0';
                @Component({ selector: 'app', standalone: true, imports: SHARED, template: '' })
                export class AppComponent {}
            "#
            .to_string(),
        ));
        for i in 0..70 {
            files.push((
                format!("/app/hop{i}.ts"),
                format!("export {{ SHARED }} from './hop{}';", i + 1),
            ));
        }
        files.push((
            "/app/hop70.ts".to_string(),
            "export const SHARED = [];".to_string(),
        ));
        let file_refs: Vec<(&str, &str)> = files
            .iter()
            .map(|(p, c)| (p.as_str(), c.as_str()))
            .collect();
        let engine = build_engine(&file_refs, &["/app/app.component.ts"]);
        let ctx = QueryContext::new(engine.clone());
        let result = block_on_with_timeout(async move {
            ctx.analyze_file_semantic(ctx.engine.intern_path("/app/app.component.ts"))
                .await
        });
        // 70 hops exceeds MAX_FILE_DEPTH: must terminate and keep the fallback.
        let component = expect_component(&result.classes[0]);
        assert!(component.raw_imports_span.is_some());
    }
}
