use oxc_ast::ast::{Decorator, Expression, ObjectPropertyKind};
use oxc_semantic::Semantic;
use oxc_span::GetSpan;

use crate::analyzer::class_data::{
    DirectiveData, ExpressionValueData, ExpressionValueKind, HostPropertyData,
};
use crate::evaluator::{evaluate_expression, EvalInput, Resolved};

use super::host_directives::extract_host_directives;
use super::input_output::{parse_legacy_input, parse_legacy_output};
use super::queries::parse_legacy_query;
use super::utils::{
    extract_bool, extract_comma_separated_string, extract_literal_string, extract_property_key,
};

/// Parse a @Directive decorator
pub fn parse_decorator<'a>(
    decorator: &'a Decorator<'a>,
    semantic: &Semantic<'a>,
    angular_imports: &crate::analyzer::imports::AngularImports,
    eval: &EvalInput<'a, '_>,
) -> Option<DirectiveData> {
    let Expression::CallExpression(call_expr) = &decorator.expression else {
        return None;
    };

    if !crate::analyzer::utils::is_angular_decorator_named(
        decorator,
        "Directive",
        semantic,
        angular_imports,
    ) {
        return None;
    }

    parse_directive_args(
        call_expr,
        crate::analyzer::utils::extract_decorator_name(decorator),
        semantic,
        angular_imports,
        eval,
    )
}

/// `decorator_name` is the decorator's name exactly as written at the use site (an alias such as
/// `AngularDirective`, or a namespaced `core.Directive`), which `ɵsetClassMetadata` re-emits
/// verbatim the way ngtsc re-emits `decorator.identifier`.
pub fn parse_directive_args<'a>(
    call_expr: &'a oxc_ast::ast::CallExpression<'a>,
    decorator_name: Option<String>,
    semantic: &Semantic<'a>,
    angular_imports: &crate::analyzer::imports::AngularImports,
    eval: &EvalInput<'a, '_>,
) -> Option<DirectiveData> {
    let mut data = match call_expr.arguments.first() {
        Some(oxc_ast::ast::Argument::ObjectExpression(obj)) => {
            extract_directive_metadata(obj, Some(obj.span()), semantic, angular_imports, eval)?
        }
        _ => DirectiveData::default(),
    };
    data.decorator_name = decorator_name;
    Some(data)
}

// Roughly mimics the shape of `extractDirectiveMetadata` in the compiler-cli:
// https://github.com/angular/angular/blob/1c9c4536d6029372b192b2561d60bad6ba7d87e8/packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L128
//
// Returns `None` when the decorator opts into JIT compilation (`jit: true`), mirroring the
// reference's `jitForced` early return: the class is skipped entirely — no analysis is
// produced and the decorator is left intact for runtime JIT compilation. The reference keys
// off the mere presence of the `jit` property (its type only permits `true`):
// https://github.com/angular/angular/blob/83622ee/packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L176-L179
pub fn extract_directive_metadata<'a>(
    obj: &'a oxc_ast::ast::ObjectExpression<'a>,
    args_span: Option<oxc_span::Span>,
    semantic: &Semantic<'a>,
    angular_imports: &crate::analyzer::imports::AngularImports,
    eval: &EvalInput<'a, '_>,
) -> Option<DirectiveData> {
    let has_jit = obj.properties.iter().any(|prop| {
        matches!(prop, ObjectPropertyKind::ObjectProperty(p)
            if extract_property_key(&p.key).as_deref() == Some("jit"))
    });

    let has_template_url = obj.properties.iter().any(|prop| {
        matches!(prop, ObjectPropertyKind::ObjectProperty(p)
            if extract_property_key(&p.key).as_deref() == Some("templateUrl"))
    });

    let mut data = DirectiveData {
        args_span,
        is_jit: has_jit,
        ..Default::default()
    };

    let mut preserved_decorator_properties = Vec::new();

    for prop in &obj.properties {
        let ObjectPropertyKind::ObjectProperty(p) = prop else {
            continue;
        };
        let Some(key_name) = extract_property_key(&p.key) else {
            continue;
        };

        // Record every NON-resource property so it can be re-emitted verbatim in
        // `ɵsetClassMetadata`. The resource fields are excluded because the metadata block
        // regenerates them (templateUrl -> inline `template`, styleUrls/styleUrl/styles ->
        // a collapsed `styles` array), mirroring the reference's `transformDecoratorResources`.
        // If `templateUrl` is present, `template` is also excluded as it is superseded by `templateUrl`.
        let is_resource = match key_name.as_ref() {
            "templateUrl" | "styleUrls" | "styleUrl" | "styles" => true,
            "template" => has_template_url,
            _ => false,
        };

        if !is_resource {
            preserved_decorator_properties.push(p.span());
        }

        match key_name.as_ref() {
            "selector" => {
                data.selector_span = Some(p.value.span());
                let evaluated = evaluate_expression(&p.value, eval);
                data.selector = Some(Resolved::from_syntax(evaluated, eval.file));
            }
            "standalone" => {
                data.standalone_span = Some(p.value.span());
                match extract_bool(&p.value, semantic) {
                    Some(value) => data.standalone = value,
                    None => {
                        data.standalone = true;
                        data.standalone_dynamic = true;
                    }
                }
            }
            "signals" => data.signals = extract_bool(&p.value, semantic).unwrap_or(false),
            "exportAs" => data.export_as = extract_comma_separated_string(&p.value, semantic),
            "host" => {
                // Two independent readings of the same expression, as in ngtsc's
                // `extractHostBindings`: the partial evaluator drives compilation, while the
                // untouched object-literal syntax drives the type-check block.
                // https://github.com/angular/angular/blob/1c9c453/packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L607-L622
                data.host_expr = Some(Box::new(Resolved::from_syntax(
                    evaluate_expression(&p.value, eval),
                    eval.file,
                )));
                data.host_span = Some(p.value.span());
                data.host_properties = extract_host_object(&p.value);
            }
            "hostDirectives" => {
                data.host_directives = Some(extract_host_directives(&p.value, semantic));
            }
            "providers" => {
                data.providers_span = Some(p.value.span());
            }
            "inputs" => {
                if let Expression::ArrayExpression(arr) = p.value.get_inner_expression() {
                    for elem in &arr.elements {
                        if let Some(expr) = elem.as_expression() {
                            if let Some(input) = parse_legacy_input(expr, semantic) {
                                data.fields
                                    .push(crate::analyzer::class_data::AngularField::Input(input));
                            }
                        }
                    }
                }
            }
            "outputs" => {
                if let Expression::ArrayExpression(arr) = p.value.get_inner_expression() {
                    for elem in &arr.elements {
                        if let Some(expr) = elem.as_expression() {
                            if let Some(output) = parse_legacy_output(expr, semantic) {
                                data.fields.push(
                                    crate::analyzer::class_data::AngularField::Output(output),
                                );
                            }
                        }
                    }
                }
            }
            "queries" => {
                if let Expression::ObjectExpression(queries_obj) = p.value.get_inner_expression() {
                    for prop in &queries_obj.properties {
                        let ObjectPropertyKind::ObjectProperty(qp) = prop else {
                            continue;
                        };
                        let Some(prop_name) = extract_property_key(&qp.key).map(|n| n.into_owned())
                        else {
                            continue;
                        };
                        if let Some(query) = parse_legacy_query(
                            prop_name,
                            &qp.value,
                            angular_imports,
                            semantic,
                            eval,
                        ) {
                            data.fields
                                .push(crate::analyzer::class_data::AngularField::Query(query));
                        }
                    }
                }
            }
            _ => {}
        }
    }

    data.preserved_decorator_properties = Some(preserved_decorator_properties);

    Some(data)
}

/// Extract the *syntax* of a `host` object literal, for the type-check block.
///
/// Deliberately unevaluated: ngtsc maps each property through `sourceNodeFromTs`, which keeps
/// only string literals and identifiers and reports everything else as unspecified, and skips
/// the whole step unless `host` is written as an object literal. Compilation reads the
/// evaluated form instead (`DirectiveData::host_expr`).
/// https://github.com/angular/angular/blob/1c9c453/packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L610-L622
pub fn extract_host_object(expr: &Expression) -> Vec<HostPropertyData> {
    let mut properties = Vec::new();

    let Expression::ObjectExpression(obj) = expr else {
        return properties;
    };

    for prop in &obj.properties {
        let ObjectPropertyKind::ObjectProperty(p) = prop else {
            continue;
        };

        // Get the key - use the shared helper
        let Some(key) = extract_property_key(&p.key).map(|n| n.into_owned()) else {
            continue;
        };

        // Optional: exclude quotes from span if it's a string literal
        let mut raw_key_span = p.key.span();
        let key_kind = if matches!(&p.key, oxc_ast::ast::PropertyKey::StringLiteral(_)) {
            raw_key_span = oxc_span::Span::new(raw_key_span.start + 1, raw_key_span.end - 1);
            ExpressionValueKind::String
        } else {
            ExpressionValueKind::Identifier
        };
        let key_node = ExpressionValueData {
            kind: key_kind,
            text: Some(key),
            span: raw_key_span,
        };

        // Get the value - should be a string literal for host bindings
        let mut raw_value_span = p.value.span();

        let (value_text, value_kind) = if let Some(text) = extract_literal_string(&p.value) {
            raw_value_span = oxc_span::Span::new(raw_value_span.start + 1, raw_value_span.end - 1);
            (Some(text), ExpressionValueKind::String)
        } else if let Expression::Identifier(ident) = &p.value {
            (
                Some(ident.name.to_string()),
                ExpressionValueKind::Identifier,
            )
        } else {
            (None, ExpressionValueKind::Unspecified)
        };
        let value_node = ExpressionValueData {
            kind: value_kind,
            text: value_text,
            span: raw_value_span,
        };

        properties.push(HostPropertyData {
            key: key_node,
            value: value_node,
        });
    }

    properties
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_parser::Parser;
    use oxc_semantic::SemanticBuilder;
    use oxc_span::SourceType;

    #[test]
    fn test_extract_host_object_spans() {
        let source_text = r#"
            let x = {
                'class.active': "isActive",
                '[attr.disabled]': isDisabled
            };
        "#;

        let allocator = Allocator::default();
        let source_type = SourceType::default();
        let ret = Parser::new(&allocator, source_text, source_type).parse();

        // Extract the object expression
        let mut object_expr = None;
        if let oxc_ast::ast::Statement::VariableDeclaration(decl) = &ret.program.body[0] {
            if let Some(init) = &decl.declarations[0].init {
                object_expr = Some(init);
            }
        }

        let expr = object_expr.expect("Expected object expression");

        let properties = extract_host_object(expr);

        assert_eq!(properties.len(), 2);

        // Check first property
        assert_eq!(properties[0].key.text, Some("class.active".to_string()));
        assert_eq!(properties[0].value.text, Some("isActive".to_string()));
        let key1_start = source_text.find("class.active").unwrap() as u32;
        assert_eq!(properties[0].key.span.start, key1_start);
        assert_eq!(properties[0].key.span.end, key1_start + 12);

        let val1_start = source_text.find("isActive").unwrap() as u32;
        assert_eq!(properties[0].value.span.start, val1_start);
        assert_eq!(properties[0].value.span.end, val1_start + 8);

        // Check second property
        assert_eq!(properties[1].key.text, Some("[attr.disabled]".to_string()));
        assert_eq!(properties[1].value.text, Some("isDisabled".to_string()));
        assert_eq!(properties[1].value.kind, ExpressionValueKind::Identifier);
        let key2_start = source_text.find("[attr.disabled]").unwrap() as u32;
        assert_eq!(properties[1].key.span.start, key2_start);
        assert_eq!(properties[1].key.span.end, key2_start + 15);

        // The value isDisabled is not a string literal, so we still get the full source for it
        let val2_start = source_text.find("isDisabled").unwrap() as u32;
        assert_eq!(properties[1].value.span.start, val2_start);
        assert_eq!(properties[1].value.span.end, val2_start + 10);
    }

    #[test]
    fn test_extract_host_object_no_substitution_template_literal() {
        // A no-substitution template literal host value (e.g. an animation binding) must be
        // treated as a plain string of its cooked content, with the backticks excluded from
        // the span, so the binding parser receives a parseable Angular expression.
        let source_text = "let x = { '[@anim]': `{ value: _v, params: { p: _p } }` };";

        let allocator = Allocator::default();
        let source_type = SourceType::default();
        let ret = Parser::new(&allocator, source_text, source_type).parse();

        let mut object_expr = None;
        if let oxc_ast::ast::Statement::VariableDeclaration(decl) = &ret.program.body[0] {
            if let Some(init) = &decl.declarations[0].init {
                object_expr = Some(init);
            }
        }
        let expr = object_expr.expect("Expected object expression");
        let properties = extract_host_object(expr);

        assert_eq!(properties.len(), 1);
        assert_eq!(properties[0].key.text, Some("[@anim]".to_string()));
        // Cooked content without the surrounding backticks.
        assert_eq!(
            properties[0].value.text,
            Some("{ value: _v, params: { p: _p } }".to_string())
        );
        assert_eq!(properties[0].value.kind, ExpressionValueKind::String);

        // Span must exclude the backticks.
        let backtick_start = source_text.find('`').unwrap() as u32;
        let backtick_end = source_text.rfind('`').unwrap() as u32;
        assert_eq!(properties[0].value.span.start, backtick_start + 1);
        assert_eq!(properties[0].value.span.end, backtick_end);
    }

    #[test]
    fn test_extract_directive_metadata_signals() {
        let source_text = r#"
            let x = {
                selector: '[signalDir]',
                standalone: false,
                signals: true
            };
        "#;

        let allocator = Allocator::default();
        let source_type = SourceType::default();
        let ret = Parser::new(&allocator, source_text, source_type).parse();

        let semantic_ret = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(&ret.program);

        let mut object_expr = None;
        if let oxc_ast::ast::Statement::VariableDeclaration(decl) = &ret.program.body[0] {
            if let Some(init) = &decl.declarations[0].init {
                object_expr = Some(init);
            }
        }

        let expr = object_expr.expect("Expected object expression");
        let oxc_ast::ast::Expression::ObjectExpression(obj) = expr else {
            panic!("Expected object expression");
        };

        let import_map = crate::analyzer::extract_import_map(&ret.module_record);
        let angular_imports = crate::analyzer::imports::extract_angular_imports(
            &ret.module_record,
            &semantic_ret.semantic,
            false,
        );
        let env = crate::evaluator::ResolvedEnv::new();
        let interner = crate::query::FileIdInterner::new();
        let eval = EvalInput {
            semantic: &semantic_ret.semantic,
            file: interner.intern_path("/test/file.ts"),
            import_map: &import_map,
            mode: crate::evaluator::EvalMode::Syntax,
            env: &env,
            foreign: crate::analyzer::resolvers::angular_foreign_resolvers(),
        };
        let meta =
            extract_directive_metadata(obj, None, &semantic_ret.semantic, &angular_imports, &eval)
                .expect("non-jit metadata should be extracted");

        assert_eq!(
            meta.selector.as_ref().and_then(Resolved::get_optional),
            Some("[signalDir]".to_string())
        );
        assert!(!meta.standalone);
        assert!(meta.signals);
    }

    #[test]
    fn test_extract_directive_metadata_legacy_decorator_fields() {
        let source_text = r#"
            import { Component, Input, Output, ViewChild, ContentChildren, TemplateRef } from '@angular/core';
            
            let x = {
                inputs: [
                    'simpleInput',
                    'propertyWithAlias: publicAlias',
                    { name: 'objectInput', alias: 'objAlias', required: true }
                ],
                outputs: [
                    'simpleOutput',
                    'outputWithAlias: publicOutputAlias'
                ],
                queries: {
                    myViewChild: new ViewChild('myRef', { static: true }),
                    myContentChildren: new ContentChildren(TemplateRef)
                }
            };
        "#;

        let allocator = Allocator::default();
        let source_type = SourceType::default().with_typescript(true);
        let ret = Parser::new(&allocator, source_text, source_type).parse();

        let semantic_ret = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(&ret.program);

        let mut object_expr = None;
        if let oxc_ast::ast::Statement::VariableDeclaration(decl) = &ret.program.body[1] {
            if let Some(init) = &decl.declarations[0].init {
                object_expr = Some(init);
            }
        }

        let expr = object_expr.expect("Expected object expression");
        let oxc_ast::ast::Expression::ObjectExpression(obj) = expr else {
            panic!("Expected object expression");
        };

        let import_map = crate::analyzer::extract_import_map(&ret.module_record);
        let angular_imports = crate::analyzer::imports::extract_angular_imports(
            &ret.module_record,
            &semantic_ret.semantic,
            false,
        );
        let env = crate::evaluator::ResolvedEnv::new();
        let interner = crate::query::FileIdInterner::new();
        let eval = EvalInput {
            semantic: &semantic_ret.semantic,
            file: interner.intern_path("/test/file.ts"),
            import_map: &import_map,
            mode: crate::evaluator::EvalMode::Syntax,
            env: &env,
            foreign: crate::analyzer::resolvers::angular_foreign_resolvers(),
        };

        let meta =
            extract_directive_metadata(obj, None, &semantic_ret.semantic, &angular_imports, &eval)
                .expect("non-jit metadata should be extracted");

        let mut inputs = Vec::new();
        let mut outputs = Vec::new();
        let mut queries = Vec::new();

        for field in meta.fields {
            match field {
                crate::analyzer::class_data::AngularField::Input(i) => inputs.push(i),
                crate::analyzer::class_data::AngularField::Output(o) => outputs.push(o),
                crate::analyzer::class_data::AngularField::Query(q) => queries.push(q),
                _ => {}
            }
        }

        // Verify Inputs
        assert_eq!(inputs.len(), 3);

        assert_eq!(inputs[0].name, "simpleInput");
        assert_eq!(inputs[0].alias, None);
        assert!(!inputs[0].required);

        assert_eq!(inputs[1].name, "propertyWithAlias");
        assert_eq!(inputs[1].alias.as_deref(), Some("publicAlias"));
        assert!(!inputs[1].required);

        assert_eq!(inputs[2].name, "objectInput");
        assert_eq!(inputs[2].alias.as_deref(), Some("objAlias"));
        assert!(inputs[2].required);

        // Verify Outputs
        assert_eq!(outputs.len(), 2);

        assert_eq!(outputs[0].name, "simpleOutput");
        assert_eq!(outputs[0].alias, None);

        assert_eq!(outputs[1].name, "outputWithAlias");
        assert_eq!(outputs[1].alias.as_deref(), Some("publicOutputAlias"));

        // Verify Queries
        assert_eq!(queries.len(), 2);

        assert_eq!(queries[0].property_name, "myViewChild");
        assert!(queries[0].first);
        assert!(queries[0].is_view);
        assert!(queries[0].is_static);
        assert_eq!(
            &source_text
                [queries[0].predicate_span.start as usize..queries[0].predicate_span.end as usize],
            "'myRef'"
        );

        assert_eq!(queries[1].property_name, "myContentChildren");
        assert!(!queries[1].first);
        assert!(!queries[1].is_view);
        assert_eq!(
            &source_text
                [queries[1].predicate_span.start as usize..queries[1].predicate_span.end as usize],
            "TemplateRef"
        );
    }

    /// Parses `source_text`, locates the first `let x = {...}` object literal, and runs
    /// `extract_directive_metadata` over it.
    fn extract_metadata_from_object_literal(source_text: &str) -> Option<DirectiveData> {
        let allocator = Allocator::default();
        let source_type = SourceType::default().with_typescript(true);
        let ret = Parser::new(&allocator, source_text, source_type).parse();

        let semantic_ret = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(&ret.program);

        let obj = ret
            .program
            .body
            .iter()
            .find_map(|stmt| {
                let oxc_ast::ast::Statement::VariableDeclaration(decl) = stmt else {
                    return None;
                };
                match &decl.declarations[0].init {
                    Some(oxc_ast::ast::Expression::ObjectExpression(obj)) => Some(obj),
                    _ => None,
                }
            })
            .expect("Expected object expression");

        let import_map = crate::analyzer::extract_import_map(&ret.module_record);
        let angular_imports = crate::analyzer::imports::extract_angular_imports(
            &ret.module_record,
            &semantic_ret.semantic,
            false,
        );
        let env = crate::evaluator::ResolvedEnv::new();
        let interner = crate::query::FileIdInterner::new();
        let eval = EvalInput {
            semantic: &semantic_ret.semantic,
            file: interner.intern_path("/test/file.ts"),
            import_map: &import_map,
            mode: crate::evaluator::EvalMode::Syntax,
            env: &env,
            foreign: crate::analyzer::resolvers::angular_foreign_resolvers(),
        };

        extract_directive_metadata(obj, None, &semantic_ret.semantic, &angular_imports, &eval)
    }

    #[test]
    fn test_extract_directive_metadata_jit_true_records_is_jit() {
        let meta = extract_metadata_from_object_literal(
            r#"
            let x = {
                selector: '[jitDir]',
                jit: true
            };
        "#,
        )
        .expect("jit: true metadata should be extracted with is_jit flag");
        assert!(meta.is_jit, "jit: true must record is_jit: true");
    }

    #[test]
    fn test_extract_directive_metadata_jit_false_records_is_jit() {
        // The reference keys off the presence of the `jit` property, not its value
        // (`directive.has('jit')` in shared.ts), since its type only permits `true`.
        let meta = extract_metadata_from_object_literal(
            r#"
            let x = {
                selector: '[jitDir]',
                jit: false
            };
        "#,
        )
        .expect("jit: false metadata should be extracted with is_jit flag");
        assert!(meta.is_jit, "presence of `jit` must record is_jit: true");
    }

    #[test]
    fn test_extract_directive_metadata_without_jit_is_extracted() {
        let meta = extract_metadata_from_object_literal(
            r#"
            let x = {
                selector: '[plainDir]'
            };
        "#,
        )
        .expect("non-jit metadata should be extracted");
        assert_eq!(
            meta.selector.as_ref().and_then(Resolved::get_optional),
            Some("[plainDir]".to_string())
        );
        assert!(!meta.is_jit);
    }

    #[test]
    fn test_extract_directive_metadata_template_url_excludes_template_from_preserved_properties() {
        let meta = extract_metadata_from_object_literal(
            r#"
            let x = {
                selector: 'app-comp',
                template: '',
                templateUrl: './app.html'
            };
        "#,
        )
        .expect("metadata should be extracted");

        let preserved = meta
            .preserved_decorator_properties
            .expect("preserved properties should exist");
        // Only `selector` should be preserved, both `template` and `templateUrl` should be excluded
        assert_eq!(preserved.len(), 1);
    }

    #[test]
    fn test_extract_directive_metadata_inline_template_preserved_when_no_template_url() {
        let meta = extract_metadata_from_object_literal(
            r#"
            let x = {
                selector: 'app-comp',
                template: '<div>Hello</div>'
            };
        "#,
        )
        .expect("metadata should be extracted");

        let preserved = meta
            .preserved_decorator_properties
            .expect("preserved properties should exist");
        // Both `selector` and `template` should be preserved when there is no `templateUrl`
        assert_eq!(preserved.len(), 2);
    }
}
