use crate::ResourceResolverFs;
use oxc_ast::ast::{Decorator, Expression, ObjectPropertyKind};
use oxc_resolver::ResolverGeneric;
use oxc_semantic::Semantic;
use oxc_span::GetSpan;
use std::collections::HashMap;

use std::path::Path;

use crate::analyzer::class_data::{
    ComponentData, DirectiveData, ForeignImportData, ForeignImportIssue, ForeignImportIssueKind,
    UrlData,
};
use crate::evaluator::{evaluate_expression, EvalInput, Resolved, ResolvedValue};

use super::imports::{resolve_imports_array, ImportInfo, ImportedSymbol};

use super::utils::{
    extract_bool, extract_property_key, extract_schemas, extract_string, extract_string_or_array,
    resolve_local_expression,
};

/// Parse a @Component decorator
#[allow(clippy::too_many_arguments)]
pub fn parse_decorator<'a, Fs: ResourceResolverFs>(
    decorator: &Decorator<'a>,
    file_path: &Path,
    fs: &Fs,
    resolver: &ResolverGeneric<Fs>,
    semantic: &Semantic<'a>,
    import_map: &HashMap<String, ImportedSymbol>,
    angular_imports: &crate::analyzer::imports::AngularImports,
    eval: &EvalInput<'a, '_>,
) -> Option<ComponentData> {
    let Expression::CallExpression(call_expr) = &decorator.expression else {
        return None;
    };

    if !crate::analyzer::utils::is_angular_decorator_named(
        decorator,
        "Component",
        semantic,
        angular_imports,
    ) {
        return None;
    }

    let directive_data = super::directive::parse_directive_args(
        call_expr,
        crate::analyzer::utils::extract_decorator_name(decorator),
        semantic,
        angular_imports,
        eval,
    )?;

    let obj = match call_expr.arguments.first() {
        Some(oxc_ast::ast::Argument::ObjectExpression(o)) => o,
        _ => {
            return Some(ComponentData {
                directive: directive_data,
                ..Default::default()
            });
        }
    };

    if directive_data.is_jit {
        return Some(ComponentData {
            directive: directive_data,
            ..Default::default()
        });
    }

    parse_component_metadata(
        obj,
        decorator.span,
        semantic,
        import_map,
        file_path,
        fs,
        resolver,
        directive_data,
        angular_imports,
        eval,
    )
}

// TODO(#60): To achieve full feature parity with `@angular/compiler-cli`, we will eventually need to use the `Semantic` model to follow static identifier references (e.g., `const myAnimations = [...]`). For now, falling back to dynamic is fine.
fn collect_animation_triggers<'a>(
    expr: &'a Expression<'a>,
    static_trigger_names: &mut Vec<String>,
    includes_dynamic_animations: &mut bool,
    semantic: &Semantic<'a>,
) {
    let resolved = resolve_local_expression(expr, semantic);
    match resolved.get_inner_expression() {
        Expression::CallExpression(call) => {
            let callee_resolved = resolve_local_expression(&call.callee, semantic);
            let Expression::Identifier(ident) = callee_resolved else {
                *includes_dynamic_animations = true;
                return;
            };
            if ident.name != "trigger" || call.arguments.is_empty() {
                *includes_dynamic_animations = true;
                return;
            }
            let Some(arg_expr) = call.arguments[0].as_expression() else {
                *includes_dynamic_animations = true;
                return;
            };
            let Some(name) = extract_string(arg_expr, semantic) else {
                *includes_dynamic_animations = true;
                return;
            };
            static_trigger_names.push(name);
        }
        Expression::ArrayExpression(arr) => {
            for elem in &arr.elements {
                let Some(nested_expr) = elem.as_expression() else {
                    *includes_dynamic_animations = true;
                    continue;
                };
                collect_animation_triggers(
                    nested_expr,
                    static_trigger_names,
                    includes_dynamic_animations,
                    semantic,
                );
            }
        }
        _ => {
            *includes_dynamic_animations = true;
        }
    }
}

/// Represents a URL parsed directly from the component decorator that has not yet been resolved
/// to an absolute filesystem path or checked for existence.
struct UnresolvedUrl {
    url: String,
    string_literal_span: Option<oxc_span::Span>,
}

#[allow(clippy::too_many_arguments)]
fn parse_component_metadata<'a, Fs: ResourceResolverFs>(
    obj: &'a oxc_ast::ast::ObjectExpression<'a>,
    decorator_span: oxc_span::Span,
    semantic: &Semantic<'a>,
    import_map: &HashMap<String, ImportedSymbol>,
    file_path: &Path,
    fs: &Fs,
    resolver: &ResolverGeneric<Fs>,
    directive_data: DirectiveData,
    _angular_imports: &crate::analyzer::imports::AngularImports,
    eval: &EvalInput<'a, '_>,
) -> Option<ComponentData> {
    let mut data = ComponentData {
        directive: directive_data,
        ..Default::default()
    };

    let mut template_url: Option<UnresolvedUrl> = None;
    let mut style_url: Option<UnresolvedUrl> = None;
    let mut style_urls: Option<Vec<UnresolvedUrl>> = None;

    for prop in &obj.properties {
        let ObjectPropertyKind::ObjectProperty(p) = prop else {
            continue;
        };
        let Some(key_name) = extract_property_key(&p.key) else {
            continue;
        };
        match key_name.as_ref() {
            "template" => {
                let eval_val = evaluate_expression(&p.value, eval);
                data.template = Some(Resolved::from_syntax(eval_val, eval.file));
                let span = p.value.span();
                data.template_span = Some(span);
                data.template_offset = Some(span.start + 1);
            }
            "templateUrl" => {
                data.template_url_span = Some(p.value.span());
                if let Some(url) = extract_string(&p.value, semantic) {
                    let string_literal_span =
                        if let Expression::StringLiteral(s) = p.value.get_inner_expression() {
                            Some(s.span)
                        } else {
                            None
                        };
                    template_url = Some(UnresolvedUrl {
                        url,
                        string_literal_span,
                    });
                }
            }
            "styles" => data.styles = extract_string_or_array(&p.value, semantic),
            "styleUrl" => {
                if let Some(url) = extract_string(&p.value, semantic) {
                    let string_literal_span =
                        if let Expression::StringLiteral(s) = p.value.get_inner_expression() {
                            Some(s.span)
                        } else {
                            None
                        };
                    style_url = Some(UnresolvedUrl {
                        url,
                        string_literal_span,
                    });
                }
            }
            "styleUrls" => {
                let inner_expr =
                    resolve_local_expression(&p.value, semantic).get_inner_expression();
                if let Expression::ArrayExpression(arr) = inner_expr {
                    let urls = arr
                        .elements
                        .iter()
                        .filter_map(|elem| {
                            let expr = elem.as_expression()?;
                            let url = extract_string(expr, semantic)?;
                            let string_literal_span =
                                if let Expression::StringLiteral(s) = expr.get_inner_expression() {
                                    Some(s.span)
                                } else {
                                    None
                                };
                            Some(UnresolvedUrl {
                                url,
                                string_literal_span,
                            })
                        })
                        .collect::<Vec<_>>();
                    style_urls = Some(urls);
                }
            }
            "encapsulation" => {
                let span = p.value.span();
                data.encapsulation_span = Some(span);
                data.encapsulation_text = semantic
                    .source_text()
                    .get(span.start as usize..span.end as usize)
                    .map(|text| text.trim().to_string());
                data.encapsulation = Some(Resolved::from_syntax(
                    evaluate_expression(&p.value, eval),
                    eval.file,
                ));
            }
            "schemas" => data.schemas = extract_schemas(&p.value, semantic),
            "imports" => {
                data.raw_imports_span = Some(p.value.span());
                data.imports_factory_span = Some(p.value.span());

                data.imports = Some(Resolved::from_syntax(
                    evaluate_expression(&p.value, eval),
                    eval.file,
                ));

                let resolved_imports =
                    resolve_local_expression(&p.value, semantic).get_inner_expression();
                if let Expression::ArrayExpression(arr) = resolved_imports {
                    data.parsed_imports = resolve_imports_array(arr, semantic, import_map);
                }
            }
            "deferredImports" => {
                data.deferred_imports_span = Some(p.value.span());
                data.deferred_imports = Some(Resolved::from_syntax(
                    evaluate_expression(&p.value, eval),
                    eval.file,
                ));

                let resolved_expr =
                    resolve_local_expression(&p.value, semantic).get_inner_expression();
                match resolved_expr {
                    Expression::ArrayExpression(arr) => {
                        data.parsed_deferred_imports =
                            resolve_imports_array(arr, semantic, import_map);
                        data.parsed_deferred_imports_by_block = None;
                    }
                    Expression::ObjectExpression(obj) => {
                        let mut by_block = std::collections::HashMap::new();
                        let mut flattened = Vec::new();
                        for prop in &obj.properties {
                            let ObjectPropertyKind::ObjectProperty(prop) = prop else {
                                continue;
                            };
                            let block_name = match &prop.key {
                                oxc_ast::ast::PropertyKey::StaticIdentifier(id) => {
                                    Some(id.name.to_string())
                                }
                                oxc_ast::ast::PropertyKey::StringLiteral(s) => {
                                    Some(s.value.to_string())
                                }
                                _ => None,
                            };
                            let Some(block_name) = block_name else {
                                continue;
                            };

                            let prop_val = resolve_local_expression(&prop.value, semantic)
                                .get_inner_expression();
                            if let Expression::ArrayExpression(arr) = prop_val {
                                let block_imports =
                                    resolve_imports_array(arr, semantic, import_map);
                                for imp in &block_imports {
                                    if !flattened.iter().any(|existing: &ImportInfo| {
                                        existing.local_name == imp.local_name
                                            && existing.import_source == imp.import_source
                                    }) {
                                        flattened.push(imp.clone());
                                    }
                                }
                                by_block.insert(block_name, block_imports);
                            }
                        }
                        data.parsed_deferred_imports = flattened;
                        data.parsed_deferred_imports_by_block = Some(by_block);
                    }
                    _ => {}
                }
            }
            "foreignImports" => {
                data.foreign_imports_span = Some(p.value.span());
                let (entries, issues) = extract_foreign_imports_from_ast(&p.value);
                data.foreign_imports = entries;
                data.foreign_import_issues = issues;
            }
            "viewProviders" => data.view_providers_span = Some(p.value.span()),
            "changeDetection" => {
                data.change_detection_span = Some(p.value.span());
                data.change_detection = Some(Resolved::from_syntax(
                    evaluate_expression(&p.value, eval),
                    eval.file,
                ));
            }
            "preserveWhitespaces" => {
                data.preserve_whitespaces = extract_bool(&p.value, semantic);
            }
            "animations" => {
                data.animations_span = Some(p.value.span());

                let mut static_trigger_names = Vec::new();
                let mut includes_dynamic_animations = false;

                collect_animation_triggers(
                    &p.value,
                    &mut static_trigger_names,
                    &mut includes_dynamic_animations,
                    semantic,
                );

                data.animation_trigger_names = Some(crate::LegacyAnimationTriggerNames {
                    static_trigger_names,
                    includes_dynamic_animations,
                });
            }
            _ => {}
        }
    }

    let resource_resolver = crate::ResourceResolver::new(fs, resolver);
    let default_span = data.directive.args_span.unwrap_or(decorator_span);

    process_component_styles(
        style_url,
        style_urls,
        &mut data,
        &resource_resolver,
        file_path,
        fs,
        default_span,
    );

    process_component_template_url(
        template_url,
        &mut data,
        &resource_resolver,
        file_path,
        fs,
        eval.file,
    );

    Some(data)
}

fn process_component_styles<Fs: ResourceResolverFs>(
    style_url: Option<UnresolvedUrl>,
    style_urls: Option<Vec<UnresolvedUrl>>,
    data: &mut ComponentData,
    resource_resolver: &crate::ResourceResolver<'_, Fs>,
    file_path: &Path,
    fs: &Fs,
    default_span: oxc_span::Span,
) {
    if style_url.is_some() && style_urls.is_some() {
        data.style_conflict_span = Some(
            style_url
                .as_ref()
                .and_then(|u| u.string_literal_span)
                .or_else(|| {
                    style_urls
                        .as_ref()
                        .and_then(|urls| urls.first())
                        .and_then(|u| u.string_literal_span)
                })
                .or(data.directive.args_span)
                .unwrap_or(default_span),
        );
    }

    let mut styles_from_urls_vec = Vec::new();
    let mut resolved_style_urls = Vec::new();

    let mut urls_to_process: Vec<&UnresolvedUrl> = Vec::new();
    if let Some(ref s_url) = style_url {
        urls_to_process.push(s_url);
    }
    if let Some(ref urls) = style_urls {
        urls_to_process.extend(urls.iter());
    }

    for s_url in urls_to_process {
        let resolved_path_opt = resource_resolver
            .resolve_resource(file_path, &s_url.url)
            .ok();

        let (resolved_path_str, is_missing) = if let Some(resolved_path) = resolved_path_opt {
            let is_missing = match fs.read_to_string(&resolved_path) {
                Ok(content) => {
                    styles_from_urls_vec.push(content);
                    false
                }
                Err(_) => true,
            };
            let canonical = fs.canonicalize(&resolved_path).unwrap_or(resolved_path);
            (crate::fs::path_to_string(canonical), is_missing)
        } else {
            (String::new(), true)
        };

        resolved_style_urls.push(UrlData {
            url: s_url.url.clone(),
            resolved_path: resolved_path_str,
            string_literal_span: s_url.string_literal_span,
            is_missing,
        });
    }

    if style_url.is_some() || style_urls.is_some() {
        data.styles_from_urls = Some(styles_from_urls_vec);
        data.style_urls = Some(resolved_style_urls);
    }
}

fn process_component_template_url<Fs: ResourceResolverFs>(
    template_url: Option<UnresolvedUrl>,
    data: &mut ComponentData,
    resource_resolver: &crate::ResourceResolver<'_, Fs>,
    file_path: &Path,
    fs: &Fs,
    eval_file: crate::query::FileId,
) {
    let Some(t_url) = template_url else {
        return;
    };

    let resolved_path_opt = resource_resolver
        .resolve_resource(file_path, &t_url.url)
        .ok();

    let (resolved_path_str, is_missing) = if let Some(resolved_path) = resolved_path_opt {
        let is_missing = match fs.read_to_string(&resolved_path) {
            Ok(content) => {
                data.template = Some(Resolved::from_syntax(
                    ResolvedValue::String(content),
                    eval_file,
                ));
                false
            }
            Err(_) => true,
        };
        let canonical = fs.canonicalize(&resolved_path).unwrap_or(resolved_path);
        (crate::fs::path_to_string(canonical), is_missing)
    } else {
        (String::new(), true)
    };

    data.template_url = Some(UrlData {
        url: t_url.url,
        resolved_path: resolved_path_str,
        string_literal_span: t_url.string_literal_span,
        is_missing,
    });
}

/// Extract each well-formed `myImport(MyComponent)` entry, recording an issue (rather than a
/// diagnostic — `validate()` owns those) for every malformed shape ngtsc reports `NG1010` on.
/// Check order matches the reference: call expression, then callee, then arity, then argument.
/// https://github.com/angular/angular/blob/e3ac727/packages/compiler-cli/src/ngtsc/annotations/component/src/util.ts#L167-L241
fn extract_foreign_imports_from_ast(
    value: &Expression,
) -> (Option<Vec<ForeignImportData>>, Vec<ForeignImportIssue>) {
    let mut issues = Vec::new();
    let Expression::ArrayExpression(arr) = value.get_inner_expression() else {
        issues.push(ForeignImportIssue {
            kind: ForeignImportIssueKind::NotAnArray,
            span: value.span(),
        });
        return (None, issues);
    };
    let mut entries = Vec::with_capacity(arr.elements.len());
    for elem in &arr.elements {
        // Array holes and spreads are not call expressions either; ngtsc reports the same
        // shape error for them.
        let Some(Expression::CallExpression(call)) = elem
            .as_expression()
            .map(|el_expr| el_expr.get_inner_expression())
        else {
            issues.push(ForeignImportIssue {
                kind: ForeignImportIssueKind::EntryNotCall,
                span: elem.span(),
            });
            continue;
        };
        if !matches!(
            call.callee.get_inner_expression(),
            Expression::Identifier(_)
        ) {
            issues.push(ForeignImportIssue {
                kind: ForeignImportIssueKind::CalleeNotIdentifier,
                span: call.callee.span(),
            });
            continue;
        }
        if call.arguments.len() != 1 {
            issues.push(ForeignImportIssue {
                kind: ForeignImportIssueKind::WrongArity,
                span: elem.span(),
            });
            continue;
        }
        let arg_ident = match call.arguments[0]
            .as_expression()
            .map(|arg| arg.get_inner_expression())
        {
            Some(Expression::Identifier(arg_ident)) => arg_ident,
            _ => {
                issues.push(ForeignImportIssue {
                    kind: ForeignImportIssueKind::ArgNotIdentifier,
                    span: call.arguments[0].span(),
                });
                continue;
            }
        };
        entries.push(ForeignImportData {
            name: arg_ident.name.to_string(),
            span: call.span,
        });
    }
    (Some(entries), issues)
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_parser::Parser;
    use oxc_span::SourceType;

    /// Parse `source` as a single expression and run `extract_foreign_imports_from_ast` on it,
    /// returning each entry's `(name, sliced call text)` plus each recorded issue's
    /// `(kind, sliced span text)`.
    #[allow(clippy::type_complexity)]
    fn extract(
        source: &str,
    ) -> (
        Option<Vec<(String, String)>>,
        Vec<(ForeignImportIssueKind, String)>,
    ) {
        let allocator = Allocator::default();
        let ret = Parser::new(&allocator, source, SourceType::ts()).parse();
        let Some(oxc_ast::ast::Statement::ExpressionStatement(stmt)) = ret.program.body.first()
        else {
            panic!("expected a single expression statement");
        };
        let (entries, issues) = extract_foreign_imports_from_ast(&stmt.expression);
        (
            entries.map(|entries| {
                entries
                    .iter()
                    .map(|fi| {
                        (
                            fi.name.clone(),
                            source[fi.span.start as usize..fi.span.end as usize].to_string(),
                        )
                    })
                    .collect()
            }),
            issues
                .iter()
                .map(|issue| {
                    (
                        issue.kind,
                        source[issue.span.start as usize..issue.span.end as usize].to_string(),
                    )
                })
                .collect(),
        )
    }

    #[test]
    fn keeps_valid_entries_with_any_callee_identifier() {
        // Any identifier callee is accepted (not just `frameworkImport`); each valid entry keeps
        // the argument identifier as `name` and the whole call span for verbatim re-emission.
        let (got, issues) = extract("[frameworkImport(FancyButton), myImport(OtherCmp)]");
        assert_eq!(
            got.unwrap(),
            vec![
                (
                    "FancyButton".to_string(),
                    "frameworkImport(FancyButton)".to_string()
                ),
                ("OtherCmp".to_string(), "myImport(OtherCmp)".to_string()),
            ]
        );
        assert_eq!(issues, vec![]);
    }

    #[test]
    fn records_issue_per_malformed_entry() {
        // Not a call, non-identifier callee, wrong arity, and non-identifier argument each
        // record the issue ngtsc reports NG1010 for, on the node ngtsc reports it on; the
        // surrounding valid entries are still kept.
        let (got, issues) =
            extract("[bad, two(A, B), obj.member(C), fn(x.y), frameworkImport(Kept)]");
        assert_eq!(
            got.unwrap(),
            vec![("Kept".to_string(), "frameworkImport(Kept)".to_string())]
        );
        assert_eq!(
            issues,
            vec![
                (ForeignImportIssueKind::EntryNotCall, "bad".to_string()),
                (ForeignImportIssueKind::WrongArity, "two(A, B)".to_string()),
                (
                    ForeignImportIssueKind::CalleeNotIdentifier,
                    "obj.member".to_string()
                ),
                (ForeignImportIssueKind::ArgNotIdentifier, "x.y".to_string()),
            ]
        );
    }

    #[test]
    fn non_array_value_records_issue() {
        let (got, issues) = extract("SHARED_IMPORTS");
        assert!(got.is_none());
        assert_eq!(
            issues,
            vec![(
                ForeignImportIssueKind::NotAnArray,
                "SHARED_IMPORTS".to_string()
            )]
        );
    }
}
