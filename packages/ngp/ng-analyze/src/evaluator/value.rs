//! Owned value types produced by partial static evaluation.
//!
//! Mirror of `@angular/compiler-cli`'s `ngtsc/partial_evaluator` `ResolvedValue` union
//! (`result.ts`, `dynamic.ts`, `synthetic.ts`, `builtin.ts`), adapted to oxc's arena-allocated
//! AST: every type here is fully owned (`'static`) so values can outlive the `ParsedFile` arena
//! they were computed from and be cached across query boundaries.
//!
//! Two additions over upstream:
//! - [`ResolvedValue::Incomplete`]: a structured *hole* recording a reference the evaluation
//!   could not chase in the current [`crate::evaluator::EvalMode`] (e.g. an import binding in
//!   `Syntax` mode). Holes appear inside the value tree and are keyed by [`HoleKey`] so the
//!   semantic driver can resolve them and re-run with a [`ResolvedEnv`].
//! - A closed [`SyntheticValue`] enum instead of upstream's generic `SyntheticValue<T>`.

use crate::analyzer::ImportKind;
use crate::query::{FileId, ReferenceId};
use crate::types::ImportPath;
use oxc_span::Span;
use std::collections::HashMap;
use std::hash::{Hash, Hasher};

/// A value resulting from partial static evaluation. Owned — no arena lifetimes.
///
/// `PartialEq` (but not `Eq`/`Hash`) because [`ResolvedValue::Number`] carries an `f64` with JS
/// semantics (`NaN != NaN`). Hole identity uses [`HoleKey`] / [`fingerprint`] instead.
#[derive(Clone, Debug, PartialEq)]
pub enum ResolvedValue {
    String(String),
    /// JS number semantics (use [`js_number_to_string`] for string coercion).
    Number(f64),
    Boolean(bool),
    Null,
    Undefined,
    Array(Vec<ResolvedValue>),
    /// Insertion-ordered string-keyed map (upstream uses `Map<string, ResolvedValue>`).
    Map(ValueMap),
    Reference(ValueReference),
    EnumValue(Box<EnumValue>),
    KnownFn(KnownFn),
    Synthetic(SyntheticValue),
    Dynamic(Box<DynamicValue>),
    Incomplete(Box<IncompleteValue>),
    Named {
        span: Span,
        value: Box<ResolvedValue>,
        synthetic: bool,
    },
}

impl ResolvedValue {
    pub fn dynamic(file: FileId, span: Span, reason: DynamicReason) -> Self {
        ResolvedValue::Dynamic(Box::new(DynamicValue { file, span, reason }))
    }

    pub fn incomplete(
        file: FileId,
        span: Span,
        node_id: Option<oxc_semantic::NodeId>,
        dep: IncompleteDep,
    ) -> Self {
        ResolvedValue::Incomplete(Box::new(IncompleteValue {
            file,
            span,
            node_id,
            dep,
            transparent: true,
        }))
    }

    pub fn is_dynamic(&self) -> bool {
        match self {
            ResolvedValue::Dynamic(_) => true,
            ResolvedValue::Named { value, .. } => value.is_dynamic(),
            _ => false,
        }
    }

    pub fn is_incomplete(&self) -> bool {
        match self {
            ResolvedValue::Incomplete(_) => true,
            ResolvedValue::Named { value, .. } => value.is_incomplete(),
            _ => false,
        }
    }

    /// True if any node in this value tree is an [`IncompleteValue`] hole.
    pub fn contains_incomplete(&self) -> bool {
        match self {
            ResolvedValue::Incomplete(_) => true,
            ResolvedValue::Array(items) => items.iter().any(|v| v.contains_incomplete()),
            ResolvedValue::Map(map) => map.iter().any(|(_, v)| v.contains_incomplete()),
            ResolvedValue::EnumValue(ev) => ev.resolved.contains_incomplete(),
            ResolvedValue::KnownFn(kf) => kf.children().iter().any(|v| v.contains_incomplete()),
            ResolvedValue::Named { value, .. } => value.contains_incomplete(),
            _ => false,
        }
    }

    /// True if any node in this value tree is a [`DynamicValue`].
    pub fn contains_dynamic(&self) -> bool {
        match self {
            ResolvedValue::Dynamic(_) => true,
            ResolvedValue::Array(items) => items.iter().any(|v| v.contains_dynamic()),
            ResolvedValue::Map(map) => map.iter().any(|(_, v)| v.contains_dynamic()),
            ResolvedValue::EnumValue(ev) => ev.resolved.contains_dynamic(),
            ResolvedValue::KnownFn(kf) => kf.children().iter().any(|v| v.contains_dynamic()),
            ResolvedValue::Named { value, .. } => value.contains_dynamic(),
            _ => false,
        }
    }

    pub fn unwrap_named(&self) -> &Self {
        let mut curr = self;
        while let ResolvedValue::Named { value, .. } = curr {
            curr = value.as_ref();
        }
        curr
    }

    pub fn unwrap_named_mut(&mut self) -> &mut Self {
        let mut curr = self;
        while let ResolvedValue::Named { value, .. } = curr {
            curr = value.as_mut();
        }
        curr
    }

    pub fn into_unwrapped_named(self) -> Self {
        let mut curr = self;
        while let ResolvedValue::Named { value, .. } = curr {
            curr = *value;
        }
        curr
    }

    /// True when any reference in this value tree satisfies `f`.
    pub fn any_reference<F>(&self, f: &mut F) -> bool
    where
        F: FnMut(&ValueReference) -> bool,
    {
        match self {
            Self::Reference(r) => f(r),
            Self::Array(items) => items.iter().any(|item| item.any_reference(f)),
            Self::Map(map) => map.iter().any(|(_, val)| val.any_reference(f)),
            Self::EnumValue(enum_val) => f(&enum_val.enum_ref),
            Self::KnownFn(kf) => kf.children().iter().any(|item| item.any_reference(f)),
            Self::Synthetic(SyntheticValue::ModuleWithProviders { ng_module, .. }) => f(ng_module),
            Self::Named { value, .. } => value.any_reference(f),
            _ => false,
        }
    }

    pub fn mutate_references<F>(&mut self, f: &mut F)
    where
        F: FnMut(&mut ValueReference),
    {
        match self {
            Self::Reference(r) => f(r),
            Self::Array(items) => {
                for item in items {
                    item.mutate_references(f);
                }
            }
            Self::Map(map) => {
                for (_, val) in map.iter_mut() {
                    val.mutate_references(f);
                }
            }
            Self::EnumValue(enum_val) => {
                f(&mut enum_val.enum_ref);
            }
            Self::KnownFn(kf) => {
                for item in kf.children_mut() {
                    item.mutate_references(f);
                }
            }
            Self::Named { value, .. } => {
                value.mutate_references(f);
            }
            _ => {}
        }
    }
}

/// Insertion-ordered string-keyed map. Object literals are small; a linear-scan `Vec` preserves
/// upstream `Map` iteration order (which matters for e.g. provider arrays) without a new
/// dependency.
// TODO: swap to `indexmap` if evaluated object literals ever get large enough to matter.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct ValueMap {
    entries: Vec<(String, ResolvedValue)>,
}

impl ValueMap {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn get(&self, key: &str) -> Option<&ResolvedValue> {
        self.entries.iter().find(|(k, _)| k == key).map(|(_, v)| v)
    }

    pub fn contains_key(&self, key: &str) -> bool {
        self.entries.iter().any(|(k, _)| k == key)
    }

    /// Insert preserving first-insertion order; a duplicate key overwrites in place
    /// (JS object literal semantics: later keys win, position stays).
    pub fn insert(&mut self, key: String, value: ResolvedValue) {
        if let Some(entry) = self.entries.iter_mut().find(|(k, _)| *k == key) {
            entry.1 = value;
        } else {
            self.entries.push((key, value));
        }
    }

    pub fn iter(&self) -> impl Iterator<Item = &(String, ResolvedValue)> {
        self.entries.iter()
    }

    pub fn iter_mut(&mut self) -> impl Iterator<Item = &mut (String, ResolvedValue)> {
        self.entries.iter_mut()
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// The kind of declaration a [`ValueReference`] points at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum DeclKind {
    Class,
    Function,
    /// A static method on a class; [`ValueReference::name`] names the class and
    /// [`ValueReference::member`] the method.
    StaticMethod,
    Enum,
    /// e.g. `declare const` with no statically reducible value (upstream parity).
    Variable,
    Other,
}

/// Owned reference to a declaration in some file.
///
/// Mirror of upstream `Reference` (`imports/src/references.ts`) — carries the best-guess owning
/// module and the `synthetic` flag for references produced through a foreign-function resolver.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct ValueReference {
    /// File containing the declaration.
    pub file: FileId,
    /// Declared name of the top-level symbol (class/function/enum/variable name).
    pub name: String,
    /// `Some("forRoot")` when this references a static class member; `name` then names the
    /// owning class and `kind` is [`DeclKind::StaticMethod`].
    pub member: Option<String>,
    /// Hint: symbol id of the top-level symbol w.r.t. the *current parse* of `file`. Consumers
    /// must fall back to a name lookup if the parse generation may have changed.
    pub reference_id: Option<ReferenceId>,
    /// Byte span of the referenced declaration (the member's span when `member` is `Some`).
    pub span: Span,
    pub kind: DeclKind,
    /// `bestGuessOwningModule` analogue: the package this symbol was reached through, when it
    /// was reached through one, with that package's name for it.
    pub owning_reference: Option<crate::types::analysis::OwningReference>,
    /// True when produced through a foreign-function resolver (upstream `Reference.synthetic`):
    /// the runtime value of the original expression may differ from this reference, so
    /// identity-sensitive consumers must not reuse the original identifier.
    pub synthetic: bool,
    /// The name this symbol is bound to in each file the evaluation traversed to reach it —
    /// the importer's local name, any binding re-export hops, and the declaration itself.
    /// A file absent from this list cannot name the symbol and must import it.
    pub aliases: Vec<(FileId, String)>,
    /// True when the declaring module exports this symbol under the reserved `default` key
    /// (`export default class Foo {}`), so importers reach it as `m.default` rather than by
    /// [`Self::name`].
    pub is_default_export: bool,
}

/// Mirror of upstream `EnumValue` (`result.ts`): a single enum member.
#[derive(Clone, Debug, PartialEq)]
pub struct EnumValue {
    /// Reference to the enum declaration (`kind == DeclKind::Enum`).
    pub enum_ref: ValueReference,
    /// Member name.
    pub name: String,
    /// The member's statically resolved value.
    pub resolved: ResolvedValue,
}

/// Mirror of upstream `KnownFn` subclasses (`builtin.ts`): statically evaluable built-in
/// methods, each capturing its receiver.
#[derive(Clone, Debug, PartialEq)]
pub enum KnownFn {
    ArraySlice(Vec<ResolvedValue>),
    ArrayConcat(Vec<ResolvedValue>),
    StringConcat(String),
}

impl KnownFn {
    /// The receiver values captured by this built-in.
    pub fn children(&self) -> &[ResolvedValue] {
        match self {
            KnownFn::ArraySlice(receiver) | KnownFn::ArrayConcat(receiver) => receiver,
            KnownFn::StringConcat(_) => &[],
        }
    }

    /// Mutable counterpart of [`Self::children`].
    pub fn children_mut(&mut self) -> &mut [ResolvedValue] {
        match self {
            KnownFn::ArraySlice(receiver) | KnownFn::ArrayConcat(receiver) => receiver,
            KnownFn::StringConcat(_) => &mut [],
        }
    }

    /// Rebuild the same variant with its receiver passed through `f`.
    pub fn map_receiver(self, f: impl FnOnce(Vec<ResolvedValue>) -> Vec<ResolvedValue>) -> Self {
        match self {
            KnownFn::ArraySlice(receiver) => KnownFn::ArraySlice(f(receiver)),
            KnownFn::ArrayConcat(receiver) => KnownFn::ArrayConcat(f(receiver)),
            KnownFn::StringConcat(_) => self,
        }
    }

    pub fn evaluate(self, file: FileId, span: Span, args: Vec<ResolvedValue>) -> ResolvedValue {
        match self {
            KnownFn::ArraySlice(receiver) => {
                // Parity: only the zero-argument `arr.slice()` form is supported.
                // https://github.com/angular/angular/blob/main/packages/compiler-cli/src/ngtsc/partial_evaluator/src/builtin.ts#L19-L25
                if args.is_empty() {
                    ResolvedValue::Array(receiver)
                } else {
                    ResolvedValue::dynamic(file, span, DynamicReason::Unknown)
                }
            }
            KnownFn::ArrayConcat(receiver) => {
                let mut result = receiver;
                for arg in args {
                    match arg {
                        ResolvedValue::Array(items) => result.extend(items),
                        ResolvedValue::Dynamic(d) => {
                            result.push(chain_dynamic_boxed(file, span, d));
                        }
                        other => result.push(other),
                    }
                }
                ResolvedValue::Array(result)
            }
            KnownFn::StringConcat(receiver) => {
                let mut result = receiver;
                for arg in args {
                    let arg = match arg {
                        ResolvedValue::EnumValue(ev) => ev.resolved,
                        other => other,
                    };
                    match arg {
                        ResolvedValue::String(s) => result.push_str(&s),
                        ResolvedValue::Number(n) => result.push_str(&js_number_to_string(n)),
                        ResolvedValue::Boolean(b) => {
                            result.push_str(if b { "true" } else { "false" })
                        }
                        ResolvedValue::Null => result.push_str("null"),
                        ResolvedValue::Undefined => result.push_str("undefined"),
                        _ => return ResolvedValue::dynamic(file, span, DynamicReason::Unknown),
                    }
                }
                ResolvedValue::String(result)
            }
        }
    }
}

/// Mirror of upstream `DynamicValue.fromDynamicInput` (`dynamic.ts`), except an inner dynamic
/// already at `span` passes through unwrapped: spans are node identity here, so wrapping would
/// chain the node to itself.
pub(crate) fn chain_dynamic(file: FileId, span: Span, inner: DynamicValue) -> ResolvedValue {
    chain_dynamic_boxed(file, span, Box::new(inner))
}

/// [`chain_dynamic`] for a value that is already boxed — every caller unwrapping a
/// `ResolvedValue::Dynamic`. Reuses that allocation instead of freeing and remaking it, which
/// on the identity path makes the whole call free. This runs once per evaluated expression.
pub(crate) fn chain_dynamic_boxed(
    file: FileId,
    span: Span,
    inner: Box<DynamicValue>,
) -> ResolvedValue {
    if inner.span == span && inner.file == file {
        ResolvedValue::Dynamic(inner)
    } else {
        ResolvedValue::dynamic(file, span, DynamicReason::DynamicInput(inner))
    }
}

/// Mirror of upstream `SyntheticValue<T>` (`synthetic.ts`) as a closed enum. Like upstream,
/// synthetic values cannot be evaluated further — property access or calls on them produce
/// `Dynamic(SyntheticInput)`.
#[derive(Clone, Debug, PartialEq)]
pub enum SyntheticValue {
    /// `ResolvedModuleWithProviders` (`annotations/ng_module/src/module_with_providers.ts`):
    /// the result of a `Module.forRoot(...)`-style call whose return type names the module.
    ModuleWithProviders {
        /// The resolved `ngModule` class (`kind == DeclKind::Class`).
        ng_module: ValueReference,
        /// Span of the originating `X.forRoot(...)` call, in `call_file`.
        call_span: Span,
        call_file: FileId,
    },
}

/// Mirror of upstream `DynamicValue` (`dynamic.ts`): a node that could not be statically
/// evaluated, with a reason that may chain to the root cause.
#[derive(Clone, Debug, PartialEq)]
pub struct DynamicValue {
    /// File containing the dynamic expression.
    pub file: FileId,
    /// Span of the dynamic expression.
    pub span: Span,
    pub reason: DynamicReason,
}

impl DynamicValue {
    /// Follow [`DynamicReason::DynamicInput`] links to the innermost cause
    /// (the core of upstream `traceDynamicValue`).
    pub fn root_cause(&self) -> &DynamicValue {
        match &self.reason {
            DynamicReason::DynamicInput(inner) => inner.root_cause(),
            _ => self,
        }
    }
}

/// Mirror of upstream `DynamicValueReason`, with payloads folded into the variants, plus
/// driver-produced reasons for cross-file resolution failures.
#[derive(Clone, Debug, PartialEq)]
pub enum DynamicReason {
    /// A sub-expression was dynamic; chains to it (upstream `DYNAMIC_INPUT`).
    DynamicInput(Box<DynamicValue>),
    /// A string could not be determined statically — computed object key or template
    /// substitution (upstream `DYNAMIC_STRING`).
    DynamicString,
    /// A reference to an external declaration that could not be evaluated
    /// (upstream `EXTERNAL_REFERENCE`).
    ExternalReference(Box<ValueReference>),
    /// Syntax the interpreter does not support (upstream `UNSUPPORTED_SYNTAX`).
    UnsupportedSyntax,
    /// An identifier with no resolvable declaration, e.g. `window`
    /// (upstream `UNKNOWN_IDENTIFIER`); carries the identifier text.
    UnknownIdentifier(String),
    /// A value resolved, but had the wrong type for the operation performed on it
    /// (upstream `INVALID_EXPRESSION_TYPE`).
    InvalidExpressionType,
    /// A function body that is not a single `return` statement
    /// (upstream `COMPLEX_FUNCTION_CALL`).
    ComplexFunctionCall,
    /// Property access or call on a [`SyntheticValue`] (upstream `SYNTHETIC_INPUT`).
    SyntheticInput,
    // ---- Driver-produced reasons (Semantic mode demotes unresolvable holes to these). ----
    /// An import whose target could not be resolved or evaluated in Semantic mode.
    UnresolvedImport(Box<UnresolvedReference>),
    /// Evaluation followed a cycle of imports/exports back to itself.
    ImportCycle,
    /// Cross-file recursion exceeded the depth limit.
    DepthLimit,
    /// The named export was not found in the target module.
    ExportNotFound,
    Unknown,
}

/// The reference an evaluation could not chase in the current mode: an import binding whose
/// target lives in another file.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct UnresolvedReference {
    /// File containing the import binding (also the resolution context for a relative
    /// `specifier`).
    pub importer: FileId,
    /// The module specifier (e.g. `./shared` or `@angular/router`).
    pub specifier: String,
    /// Which binding of the module is referenced (named/default/namespace).
    pub symbol: ImportKind,
    /// The local name of the import binding in the importer's file.
    pub local_name: String,
    /// Whether this reference came from property access on a namespace import (e.g. `ns.Member`).
    pub is_namespace_member: bool,
}

/// A structured hole: evaluation needed to cross a file boundary and the current mode could
/// not. Appears *inside* the value tree (e.g. `Array([Reference(A), Incomplete{..}])`).
///
/// A tree containing any hole is non-final: element counts, spread expansion, and map keys
/// around the hole are not trustworthy until a re-evaluation pass with the hole's
/// [`ResolvedEnv`] entry filled.
#[derive(Clone, Debug, PartialEq)]
pub struct IncompleteValue {
    /// File in which the hole originated (= the evaluating file).
    pub file: FileId,
    /// Span of the originating expression (identifier / member access / call) — for
    /// diagnostics and dependency tracking; *not* part of the env-key identity.
    pub span: Span,
    pub node_id: Option<oxc_semantic::NodeId>,
    pub dep: IncompleteDep,
    /// True when the hole occupies a plain value position (array element, map value, root):
    /// substituting the env entry for the hole node yields the final value directly. False
    /// when the hole was *propagated* through a containing operation (spread, operator,
    /// template, access on the hole, …) — the node then stands for the larger expression and
    /// completing it requires re-running the interpreter with the env.
    pub transparent: bool,
}

impl IncompleteValue {
    /// Identity of this hole for the [`ResolvedEnv`]. Span-independent: every use of the same
    /// import binding shares one env entry, and call holes are keyed by callee + argument
    /// fingerprint so the same call site under different parameter scopes keys separately.
    pub fn key(&self) -> HoleKey {
        match &self.dep {
            IncompleteDep::Reference(target) => HoleKey::Reference(target.clone()),
            IncompleteDep::Member { base, member } => HoleKey::Member {
                base: base.clone(),
                member: member.clone(),
            },
            IncompleteDep::Call { callee, args } => HoleKey::Call {
                callee: callee.clone(),
                args_fingerprint: fingerprint_args(args),
            },
        }
    }
}

/// What a hole is waiting on.
#[derive(Clone, Debug, PartialEq)]
pub enum IncompleteDep {
    /// An import binding used as a value — the reference we couldn't chase.
    Reference(UnresolvedReference),
    /// Property access on a [`ValueReference`] whose declaration lives in another file
    /// (e.g. `.forRoot` on a resolved foreign class reference).
    Member {
        base: ValueReference,
        member: String,
    },
    /// A call whose callee is a function-like [`ValueReference`] in another file; the
    /// arguments were evaluated in the current file (and may themselves contain holes).
    Call {
        callee: ValueReference,
        args: Vec<ResolvedValue>,
    },
}

/// Identity of a hole, used as the [`ResolvedEnv`] key. `Eq + Hash` — [`ResolvedValue`] itself
/// cannot be (`f64`), so call identity uses a structural [`fingerprint`] of the arguments.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum HoleKey {
    Reference(UnresolvedReference),
    Member {
        base: ValueReference,
        member: String,
    },
    Call {
        callee: ValueReference,
        args_fingerprint: u64,
    },
}

/// Resolved-holes environment supplied by the semantic driver's fixpoint loop. Empty in
/// `Syntax` mode.
pub type ResolvedEnv = HashMap<HoleKey, ResolvedValue>;

/// Walk a value tree collecting all holes, deduplicated by [`HoleKey`]. Driver entry point.
pub fn collect_holes(value: &ResolvedValue) -> Vec<IncompleteValue> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    collect_holes_inner(value, &mut seen, &mut out);
    out
}

fn collect_holes_inner(
    value: &ResolvedValue,
    seen: &mut std::collections::HashSet<HoleKey>,
    out: &mut Vec<IncompleteValue>,
) {
    match value {
        ResolvedValue::Incomplete(hole) => {
            // A Call hole's arguments may themselves contain holes that must resolve first.
            if let IncompleteDep::Call { args, .. } = &hole.dep {
                for arg in args {
                    collect_holes_inner(arg, seen, out);
                }
            }
            if seen.insert(hole.key()) {
                out.push((**hole).clone());
            }
        }
        ResolvedValue::Array(items) => {
            for item in items {
                collect_holes_inner(item, seen, out);
            }
        }
        ResolvedValue::Map(map) => {
            for (_, v) in map.iter() {
                collect_holes_inner(v, seen, out);
            }
        }
        ResolvedValue::EnumValue(ev) => collect_holes_inner(&ev.resolved, seen, out),
        ResolvedValue::KnownFn(kf) => {
            for item in kf.children() {
                collect_holes_inner(item, seen, out);
            }
        }
        ResolvedValue::Named { value, .. } => collect_holes_inner(value, seen, out),
        _ => {}
    }
}

/// Fill *transparent* holes from the env, in place on an owned tree (no arena access).
///
/// This is the driver's fast path: when every hole in a tree is transparent, substitution
/// completes the value without re-running the interpreter. Non-transparent holes (and
/// transparent holes missing from the env) are left as-is — the caller falls back to a re-run.
/// Anchor a value that filled a hole onto the node the hole stood for.
///
/// Holes have no upstream analogue: there, the *importing* file's `visitExpression` postlude
/// wraps whatever the imported declaration evaluated to, so the node carried by a dynamic
/// value is always the local reference. Without this, a constant imported from another file
/// reports a node in *that* file, which a consumer emitting the expression verbatim cannot
/// use — and the syntax projection, where the hole is still intact, would disagree with the
/// semantic one. `chain_dynamic` is a no-op when the value already sits at this node.
fn anchor_on_hole(value: ResolvedValue, (file, span): (FileId, Span)) -> ResolvedValue {
    match value {
        ResolvedValue::Dynamic(dynamic) => chain_dynamic_boxed(file, span, dynamic),
        other => other,
    }
}

pub fn substitute(
    value: ResolvedValue,
    env: &ResolvedEnv,
    ast_results: &std::collections::HashMap<oxc_span::Span, ResolvedValue>,
) -> ResolvedValue {
    if !value.contains_incomplete() {
        return value;
    }
    match value {
        ResolvedValue::Incomplete(ref hole) => {
            // Where the hole stood, so a value that comes back dynamic can be anchored there.
            let anchor = (hole.file, hole.span);
            let can_subst_env = hole.transparent
                || matches!(&hole.dep, IncompleteDep::Call { .. })
                || env
                    .get(&hole.key())
                    .is_some_and(|v| matches!(v.unwrap_named(), ResolvedValue::Array(_)));

            if can_subst_env {
                if let Some(replacement) = env.get(&hole.key()) {
                    return anchor_on_hole(
                        substitute(replacement.clone(), env, ast_results),
                        anchor,
                    );
                }
            }
            if let Some(reevaluated) = ast_results.get(&hole.span) {
                return anchor_on_hole(reevaluated.clone(), anchor);
            }
            value
        }
        ResolvedValue::Array(items) => {
            ResolvedValue::Array(substitute_items(items, env, ast_results))
        }
        ResolvedValue::Map(mut map) => {
            for entry in map.iter_mut() {
                let v = std::mem::replace(&mut entry.1, ResolvedValue::Undefined);
                entry.1 = substitute(v, env, ast_results);
            }
            ResolvedValue::Map(map)
        }
        ResolvedValue::EnumValue(mut ev) => {
            let resolved = std::mem::replace(&mut ev.resolved, ResolvedValue::Undefined);
            ev.resolved = substitute(resolved, env, ast_results);
            ResolvedValue::EnumValue(ev)
        }
        ResolvedValue::KnownFn(kf) => ResolvedValue::KnownFn(
            kf.map_receiver(|items| substitute_items(items, env, ast_results)),
        ),
        ResolvedValue::Named {
            span,
            value,
            synthetic,
        } => {
            let inner_subst = substitute(*value, env, ast_results);
            match inner_subst {
                ResolvedValue::Incomplete(_) | ResolvedValue::Dynamic(_) => ResolvedValue::Named {
                    span,
                    value: Box::new(inner_subst),
                    synthetic,
                },
                other => other,
            }
        }
        other => other,
    }
}

/// Substitute each item of an array literal or `KnownFn` receiver, splicing (rather than
/// nesting) a non-transparent hole's replacement when it resolves to an array. Spread holes
/// (`[...HOLE]`) are non-transparent, but so are other propagated failures — both splice.
fn substitute_items(
    items: Vec<ResolvedValue>,
    env: &ResolvedEnv,
    ast_results: &std::collections::HashMap<oxc_span::Span, ResolvedValue>,
) -> Vec<ResolvedValue> {
    let mut new_items = Vec::with_capacity(items.len());
    for item in items {
        let is_spread = match item.unwrap_named() {
            ResolvedValue::Incomplete(h) => !h.transparent,
            _ => false,
        };
        let replaced = substitute(item, env, ast_results);
        if is_spread && matches!(replaced.unwrap_named(), ResolvedValue::Array(_)) {
            let ResolvedValue::Array(sub_items) = replaced.into_unwrapped_named() else {
                unreachable!("unwrap_named and into_unwrapped_named disagree");
            };
            new_items.extend(sub_items);
            continue;
        }
        new_items.push(replaced);
    }
    new_items
}

/// Rewrite every surviving [`IncompleteValue`] hole into a [`DynamicValue`].
///
/// Semantic-mode postcondition: `Incomplete` means "stopped at a file boundary *by design*",
/// which is only true in Syntax mode. After the driver has attempted (and failed) resolution,
/// the value is semantically dynamic — consumers then need exactly one fallback branch, and a
/// lingering hole can never tempt a consumer into resolving it outside the query system
/// (bypassing dependency recording).
pub fn demote_incomplete_to_dynamic(value: ResolvedValue) -> ResolvedValue {
    match value {
        ResolvedValue::Incomplete(hole) => {
            let inner_reason = match hole.dep {
                IncompleteDep::Reference(unresolved) => {
                    DynamicReason::UnresolvedImport(Box::new(unresolved))
                }
                IncompleteDep::Member { base, .. } => {
                    DynamicReason::ExternalReference(Box::new(base))
                }
                IncompleteDep::Call { callee, .. } => {
                    DynamicReason::ExternalReference(Box::new(callee))
                }
            };
            let reason = if hole.transparent {
                inner_reason
            } else {
                DynamicReason::DynamicInput(Box::new(DynamicValue {
                    file: hole.file,
                    span: hole.span,
                    reason: inner_reason,
                }))
            };
            ResolvedValue::dynamic(hole.file, hole.span, reason)
        }
        ResolvedValue::Array(items) => ResolvedValue::Array(
            items
                .into_iter()
                .map(demote_incomplete_to_dynamic)
                .collect(),
        ),
        ResolvedValue::Map(mut map) => {
            for entry in map.iter_mut() {
                let v = std::mem::replace(&mut entry.1, ResolvedValue::Undefined);
                entry.1 = demote_incomplete_to_dynamic(v);
            }
            ResolvedValue::Map(map)
        }
        ResolvedValue::EnumValue(mut ev) => {
            let resolved = std::mem::replace(&mut ev.resolved, ResolvedValue::Undefined);
            ev.resolved = demote_incomplete_to_dynamic(resolved);
            ResolvedValue::EnumValue(ev)
        }
        ResolvedValue::KnownFn(kf) => ResolvedValue::KnownFn(kf.map_receiver(|items| {
            items
                .into_iter()
                .map(demote_incomplete_to_dynamic)
                .collect()
        })),
        ResolvedValue::Named {
            span,
            value,
            synthetic,
        } => ResolvedValue::Named {
            span,
            value: Box::new(demote_incomplete_to_dynamic(*value)),
            synthetic,
        },
        other => other,
    }
}

/// Stamp `owning_module` onto references declared in `file` that don't have one yet, pairing
/// it with each reference's own declared name to form its [`OwningReference`].
///
/// Best-guess owning module propagation: when a value was obtained *through* a package
/// specifier (e.g. evaluating `RouterModule.forRoot()` reached via `@angular/router`),
/// references it contains to declarations of that same package file should be importable via
/// that specifier rather than a relative path into `node_modules`.
// TODO(parity): upstream's bestGuessOwningModule follows package-format conventions more
// thoroughly; this covers the resolution chain we actually walked.
pub fn stamp_owning_reference(
    value: ResolvedValue,
    file: FileId,
    owning_module: &ImportPath,
) -> ResolvedValue {
    let ImportPath::Absolute(specifier) = owning_module else {
        return value;
    };
    // A package re-exports its declarations under their declared name; the renaming case can
    // only arise on a chased chain, which carries its own name.
    let owning_for = |name: &str| crate::types::analysis::OwningReference {
        specifier: specifier.clone(),
        export_name: name.to_string(),
    };
    match value {
        ResolvedValue::Reference(mut reference) => {
            if reference.file == file && reference.owning_reference.is_none() {
                reference.owning_reference = Some(owning_for(&reference.name));
            }
            ResolvedValue::Reference(reference)
        }
        ResolvedValue::Array(items) => ResolvedValue::Array(
            items
                .into_iter()
                .map(|v| stamp_owning_reference(v, file, owning_module))
                .collect(),
        ),
        ResolvedValue::Map(mut map) => {
            for entry in map.iter_mut() {
                let v = std::mem::replace(&mut entry.1, ResolvedValue::Undefined);
                entry.1 = stamp_owning_reference(v, file, owning_module);
            }
            ResolvedValue::Map(map)
        }
        ResolvedValue::Synthetic(SyntheticValue::ModuleWithProviders {
            mut ng_module,
            call_span,
            call_file,
        }) => {
            if ng_module.file == file && ng_module.owning_reference.is_none() {
                ng_module.owning_reference = Some(owning_for(&ng_module.name));
            }
            ResolvedValue::Synthetic(SyntheticValue::ModuleWithProviders {
                ng_module,
                call_span,
                call_file,
            })
        }
        ResolvedValue::EnumValue(mut ev) => {
            // Deliberately no `ev.enum_ref.file == file` check, unlike the arms above:
            // upstream takes the owning module from the import site rather than from the
            // declaring file, and published `@angular/core` declares its enums in a chunk
            // `.d.ts` rather than in the entry point its consumers import.
            if ev.enum_ref.owning_reference.is_none() {
                ev.enum_ref.owning_reference = Some(owning_for(&ev.enum_ref.name));
            }
            ResolvedValue::EnumValue(ev)
        }
        ResolvedValue::KnownFn(kf) => ResolvedValue::KnownFn(kf.map_receiver(|items| {
            items
                .into_iter()
                .map(|v| stamp_owning_reference(v, file, owning_module))
                .collect()
        })),
        ResolvedValue::Named {
            span,
            value,
            synthetic,
        } => ResolvedValue::Named {
            span,
            value: Box::new(stamp_owning_reference(*value, file, owning_module)),
            synthetic,
        },
        other => other,
    }
}

/// JS truthiness. Literals follow JS; every non-literal (Array, Map, Reference, EnumValue,
/// KnownFn, Synthetic) is truthy, mirroring upstream where `condition ? a : b` sees a JS
/// object.
///
/// NOTE: upstream quirk preserved — an `EnumValue` is an object and therefore truthy even when
/// its resolved value is `0`.
pub fn is_truthy(value: &ResolvedValue) -> bool {
    match value.unwrap_named() {
        ResolvedValue::String(s) => !s.is_empty(),
        ResolvedValue::Number(n) => *n != 0.0 && !n.is_nan(),
        ResolvedValue::Boolean(b) => *b,
        ResolvedValue::Null | ResolvedValue::Undefined => false,
        _ => true,
    }
}

/// ECMA-ish `Number::toString` for template/`+` string coercion: integral values print without
/// a fractional part (`"1"`, not `"1.0"`); `NaN`, `±Infinity`, and `-0` are handled.
// TODO(parity): full ECMA-262 7.1.12.1 shortest-roundtrip formatting for exotic doubles
// (very large magnitudes should switch to exponential notation).
pub fn js_number_to_string(n: f64) -> String {
    if n.is_nan() {
        return "NaN".to_string();
    }
    if n.is_infinite() {
        return if n > 0.0 { "Infinity" } else { "-Infinity" }.to_string();
    }
    if n == 0.0 {
        // Covers -0: JS String(-0) === "0".
        return "0".to_string();
    }
    if n.fract() == 0.0 && n.abs() < 9_007_199_254_740_992.0 {
        return format!("{}", n as i64);
    }
    format!("{}", n)
}

/// Structural fingerprint of a value tree, for [`HoleKey::Call`] identity. Hashes enum
/// discriminants, strings, and `f64` bit patterns; stable within a process.
pub fn fingerprint(value: &ResolvedValue) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    hash_value(value, &mut hasher);
    hasher.finish()
}

/// Structural fingerprint of an argument list, for [`HoleKey::Call`] identity.
pub fn fingerprint_args(values: &[ResolvedValue]) -> u64 {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    for value in values {
        hash_value(value, &mut hasher);
    }
    hasher.finish()
}

fn hash_value<H: Hasher>(value: &ResolvedValue, hasher: &mut H) {
    std::mem::discriminant(value).hash(hasher);
    match value {
        ResolvedValue::String(s) => s.hash(hasher),
        ResolvedValue::Number(n) => n.to_bits().hash(hasher),
        ResolvedValue::Boolean(b) => b.hash(hasher),
        ResolvedValue::Null | ResolvedValue::Undefined => {}
        ResolvedValue::Array(items) => {
            items.len().hash(hasher);
            for item in items {
                hash_value(item, hasher);
            }
        }
        ResolvedValue::Map(map) => {
            map.len().hash(hasher);
            for (k, v) in map.iter() {
                k.hash(hasher);
                hash_value(v, hasher);
            }
        }
        ResolvedValue::Reference(r) => r.hash(hasher),
        ResolvedValue::EnumValue(ev) => {
            ev.enum_ref.hash(hasher);
            ev.name.hash(hasher);
            hash_value(&ev.resolved, hasher);
        }
        ResolvedValue::KnownFn(f) => {
            std::mem::discriminant(f).hash(hasher);
            match f {
                KnownFn::ArraySlice(items) | KnownFn::ArrayConcat(items) => {
                    for item in items {
                        hash_value(item, hasher);
                    }
                }
                KnownFn::StringConcat(s) => s.hash(hasher),
            }
        }
        ResolvedValue::Synthetic(SyntheticValue::ModuleWithProviders {
            ng_module,
            call_span,
            call_file,
        }) => {
            ng_module.hash(hasher);
            call_span.hash(hasher);
            call_file.hash(hasher);
        }
        ResolvedValue::Dynamic(d) => {
            d.file.hash(hasher);
            d.span.hash(hasher);
        }
        ResolvedValue::Incomplete(hole) => hole.key().hash(hasher),
        ResolvedValue::Named {
            span,
            value,
            synthetic,
        } => {
            span.hash(hasher);
            hash_value(value, hasher);
            synthetic.hash(hasher);
        }
    }
}
