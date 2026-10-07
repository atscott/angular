use oxc_ast::ast::{Argument, CallExpression, ClassElement, Decorator, Expression};

use crate::analyzer::class_data::{
    ExpressionValueData, ExpressionValueKind, HostBindingData, HostListenerArgsError,
    HostListenerData,
};
use crate::analyzer::imports::AngularImports;

use super::utils::{extract_literal_string, extract_property_key, is_angular_decorator_named};
use crate::evaluator::EvalInput;
use oxc_semantic::Semantic;
use oxc_span::GetSpan;

// TODO: we currently don't extract inherited host bindings.

/// Parse @HostBinding() decorator on a property or accessor
pub fn parse_host_binding_decorator<'a>(
    decorator: &'a Decorator<'a>,
    member_name: ExpressionValueData,
    member_span: oxc_span::Span,
    semantic: &Semantic<'a>,
    angular_imports: &AngularImports,
) -> Option<HostBindingData> {
    if !is_angular_decorator_named(decorator, "HostBinding", semantic, angular_imports) {
        return None;
    }
    match &decorator.expression {
        // @HostBinding() or @HostBinding('propName')
        Expression::CallExpression(call) => {
            parse_host_binding_args(call, member_name, decorator.span, member_span)
        }
        // @HostBinding / @core.HostBinding (no parentheses - uses the property name as binding).
        // Matched precisely rather than with a catch-all: a wrapped call such as
        // `@(HostBinding('class.active'))` must not be mistaken for the no-argument form, which
        // would silently drop the argument. ngtsc rejects those outright in `_reflectDecorator`,
        // since `isDecoratorIdentifier` only accepts an identifier or a single-level `a.b`.
        Expression::Identifier(_) | Expression::StaticMemberExpression(_) => {
            Some(HostBindingData {
                member_name,
                arguments: vec![],
                decorator_span: decorator.span,
                member_span,
            })
        }
        _ => None,
    }
}

fn create_source_node(
    span: oxc_span::Span,
    kind: ExpressionValueKind,
    text: Option<String>,
) -> ExpressionValueData {
    ExpressionValueData { kind, text, span }
}

// Note: Do NOT use PartialEvaluator (extract_string / Semantic) to evaluate expressions or string concatenation here.
// When generating Type Check Block (TCB) host metadata (hostBindingDecorators / hostListenerDecorators), reference ngtsc
// maps decorator arguments via `sourceNodeFromTs`, which matches ONLY StringLiteral, NoSubstitutionTemplateLiteral, and Identifier,
// returning Unspecified for all non-literal expressions. Using partial evaluation here would diverge from reference compiler behavior:
// https://github.com/angular/angular/blob/1c9c453/packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L786
/// Classify expression kind according to ngtsc's `sourceNodeFromTs`:
/// StringLiteral and NoSubstitutionTemplateLiteral -> String,
/// Identifier -> Identifier,
/// Any other non-literal expression -> Unspecified.
/// https://github.com/angular/angular/blob/1c9c453/packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L786
fn classify_source_node_kind(expr: &Expression<'_>) -> ExpressionValueKind {
    if extract_literal_string(expr).is_some() {
        ExpressionValueKind::String
    } else if matches!(expr, Expression::Identifier(_)) {
        ExpressionValueKind::Identifier
    } else {
        ExpressionValueKind::Unspecified
    }
}

fn parse_host_argument_expression(
    expr: Option<&Expression<'_>>,
    span: oxc_span::Span,
) -> ExpressionValueData {
    let Some(expr) = expr else {
        return create_source_node(span, ExpressionValueKind::Unspecified, None);
    };

    let kind = classify_source_node_kind(expr);
    let text = match kind {
        ExpressionValueKind::String => extract_literal_string(expr),
        ExpressionValueKind::Identifier => match expr {
            Expression::Identifier(ident) => Some(ident.name.to_string()),
            _ => None,
        },
        _ => None,
    };

    create_source_node(span, kind, text)
}

fn parse_host_binding_args(
    call: &CallExpression,
    name_node: ExpressionValueData,
    decorator_span: oxc_span::Span,
    member_span: oxc_span::Span,
) -> Option<HostBindingData> {
    let arguments = call
        .arguments
        .iter()
        .map(|arg| parse_host_argument_expression(arg.as_expression(), arg.span()))
        .collect();

    Some(HostBindingData {
        member_name: name_node,
        arguments,
        decorator_span,
        member_span,
    })
}

/// Parse @HostListener() decorator on a method
pub fn parse_host_listener_decorator<'a>(
    decorator: &'a Decorator<'a>,
    method_name: ExpressionValueData,
    member_span: oxc_span::Span,
    eval: &EvalInput<'a, '_>,
    angular_imports: &AngularImports,
) -> Option<HostListenerData> {
    if !is_angular_decorator_named(decorator, "HostListener", eval.semantic, angular_imports) {
        return None;
    }
    let Expression::CallExpression(call) = &decorator.expression else {
        return None;
    };
    parse_host_listener_args(call, method_name, decorator.span, member_span, eval)
}

fn eval_to_string(expr: &Expression<'_>, eval: &EvalInput<'_, '_>) -> Option<String> {
    match crate::evaluator::evaluate_expression(expr, eval) {
        crate::evaluator::ResolvedValue::String(s) => Some(s),
        _ => None,
    }
}

fn parse_host_listener_args(
    call: &CallExpression,
    method_name: ExpressionValueData,
    decorator_span: oxc_span::Span,
    member_span: oxc_span::Span,
    eval: &EvalInput<'_, '_>,
) -> Option<HostListenerData> {
    // First argument is the event name
    let arg = call.arguments.first()?;
    let expr = arg.as_expression()?;
    let event_name_str = eval_to_string(expr, eval)?;
    let kind = classify_source_node_kind(expr);
    let event_name = create_source_node(arg.span(), kind, Some(event_name_str));

    // Second argument is the args array, e.g., ['$event']
    let Some(arg) = call.arguments.get(1) else {
        return Some(HostListenerData {
            method_name,
            event_name,
            args: Vec::new(),
            runtime_args: None,
            decorator_span,
            member_span,
            args_errors: Vec::new(),
        });
    };

    // For TCB metadata: reference ngtsc maps decorator arguments via `sourceNodeFromTs`.
    // If the argument is an array literal, its elements are mapped; otherwise args is empty.
    // https://github.com/angular/angular/blob/main/packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L758-L762
    let args = match arg {
        Argument::ArrayExpression(arr) => arr
            .elements
            .iter()
            .map(|elem| parse_host_argument_expression(elem.as_expression(), elem.span()))
            .collect(),
        _ => Vec::new(),
    };

    // For runtime metadata: reference ngtsc evaluates the 2nd argument via `evaluator.evaluate`.
    // It must resolve to an array of strings (constant folding template literals / references).
    // Non-array or non-string elements produce NG1010 diagnostics.
    // Note: Currently evaluated in Syntax mode (within-file). Member-level decorators like
    // @HostListener are extracted during Stage 1 single-file syntactic analysis (`visitor.rs`)
    // and are not currently wired into Stage 2 cross-file semantic resolution (`resolve_semantic`),
    // so cross-file constant evaluation for @HostListener is a known parity gap with ngtsc.
    // https://github.com/angular/angular/blob/main/packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L731-L742
    // https://github.com/angular/angular/blob/main/packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L1081-L1096
    let (runtime_args, args_errors) = evaluate_host_listener_runtime_args(arg, eval);

    Some(HostListenerData {
        method_name,
        event_name,
        args,
        runtime_args,
        decorator_span,
        member_span,
        args_errors,
    })
}

fn evaluate_host_listener_runtime_args(
    arg: &Argument<'_>,
    eval: &EvalInput<'_, '_>,
) -> (Option<Vec<String>>, Vec<HostListenerArgsError>) {
    let Some(expr) = arg.as_expression() else {
        return (
            None,
            vec![HostListenerArgsError::NotStringArray(arg.span())],
        );
    };

    let resolved = crate::evaluator::evaluate_expression(expr, eval);

    // If the expression cannot be fully evaluated within this file (it contains Incomplete
    // holes from cross-file imports), do not report a false NG1010 diagnostic. Because member
    // decorators are parsed in Stage 1 syntax mode and not resolved in Stage 2 semantic analysis,
    // cross-file imported constants cannot be chased; we leave runtime_args as None so downstream
    // code can fall back to the identifier text.
    if resolved.contains_incomplete() {
        return (None, Vec::new());
    }

    let crate::evaluator::ResolvedValue::Array(items) = resolved else {
        return (
            None,
            vec![HostListenerArgsError::NotStringArray(arg.span())],
        );
    };

    let mut runtime_args = Vec::with_capacity(items.len());
    for (i, item) in items.into_iter().enumerate() {
        if item.contains_incomplete() {
            return (None, Vec::new());
        }
        let crate::evaluator::ResolvedValue::String(s) = item else {
            return (
                None,
                vec![HostListenerArgsError::ElementNotString {
                    span: arg.span(),
                    index: i,
                }],
            );
        };
        runtime_args.push(s);
    }

    (Some(runtime_args), Vec::new())
}

fn get_member_span_excluding_decorators(
    span: oxc_span::Span,
    decorators: &[oxc_ast::ast::Decorator],
) -> oxc_span::Span {
    let mut start = span.start;
    if let Some(last_decorator) = decorators.last() {
        if last_decorator.span.end <= span.end {
            start = last_decorator.span.end;
        }
    }
    oxc_span::Span::new(start, span.end)
}

fn extract_property_host_bindings_listeners<'a>(
    decorators: &'a [oxc_ast::ast::Decorator<'a>],
    key: &oxc_ast::ast::PropertyKey,
    span: oxc_span::Span,
    eval: &EvalInput<'a, '_>,
    angular_imports: &AngularImports,
) -> (Vec<HostBindingData>, Vec<HostListenerData>) {
    let mut host_bindings = Vec::new();
    let mut host_listeners = Vec::new();
    let Some(prop_name) = extract_property_key(key).map(|n| n.into_owned()) else {
        return (host_bindings, host_listeners);
    };
    let name_node = create_source_node(
        key.span(),
        ExpressionValueKind::Identifier,
        Some(prop_name.clone()),
    );

    let member_span = get_member_span_excluding_decorators(span, decorators);

    for decorator in decorators {
        if let Some(binding) = parse_host_binding_decorator(
            decorator,
            name_node.clone(),
            member_span,
            eval.semantic,
            angular_imports,
        ) {
            host_bindings.push(binding);
        }
        if let Some(listener) = parse_host_listener_decorator(
            decorator,
            name_node.clone(),
            member_span,
            eval,
            angular_imports,
        ) {
            host_listeners.push(listener);
        }
    }
    (host_bindings, host_listeners)
}

fn extract_method_host_bindings_listeners<'a>(
    method: &'a oxc_ast::ast::MethodDefinition<'a>,
    eval: &EvalInput<'a, '_>,
    angular_imports: &AngularImports,
) -> (Vec<HostBindingData>, Vec<HostListenerData>) {
    let mut host_bindings = Vec::new();
    let mut host_listeners = Vec::new();
    let Some(method_name) = extract_property_key(&method.key).map(|n| n.into_owned()) else {
        return (host_bindings, host_listeners);
    };
    let member_span = get_member_span_excluding_decorators(method.span, &method.decorators);
    let name_node = create_source_node(
        method.key.span(),
        ExpressionValueKind::Identifier,
        Some(method_name.clone()),
    );

    for decorator in &method.decorators {
        // Check for @HostListener on methods
        if let Some(listener) = parse_host_listener_decorator(
            decorator,
            name_node.clone(),
            member_span,
            eval,
            angular_imports,
        ) {
            host_listeners.push(listener);
        }

        // Check for @HostBinding on getter accessors
        if method.kind == oxc_ast::ast::MethodDefinitionKind::Get {
            if let Some(binding) = parse_host_binding_decorator(
                decorator,
                name_node.clone(),
                member_span,
                eval.semantic,
                angular_imports,
            ) {
                host_bindings.push(binding);
            }
        }
    }
    (host_bindings, host_listeners)
}

pub fn extract_host_bindings_listeners<'a>(
    class: &'a oxc_ast::ast::Class<'a>,
    eval: &EvalInput<'a, '_>,
    angular_imports: &AngularImports,
) -> (Vec<HostBindingData>, Vec<HostListenerData>) {
    let mut host_bindings = Vec::new();
    let mut host_listeners = Vec::new();

    for element in &class.body.body {
        match element {
            // Property definitions with @HostBinding or @HostListener
            ClassElement::PropertyDefinition(prop) => {
                let (bindings, listeners) = extract_property_host_bindings_listeners(
                    &prop.decorators,
                    &prop.key,
                    prop.span,
                    eval,
                    angular_imports,
                );
                host_bindings.extend(bindings);
                host_listeners.extend(listeners);
            }

            // Accessor properties with @HostBinding or @HostListener
            ClassElement::AccessorProperty(acc) => {
                let (bindings, listeners) = extract_property_host_bindings_listeners(
                    &acc.decorators,
                    &acc.key,
                    acc.span,
                    eval,
                    angular_imports,
                );
                host_bindings.extend(bindings);
                host_listeners.extend(listeners);
            }

            // Method definitions with @HostListener or @HostBinding (for getters)
            ClassElement::MethodDefinition(method) => {
                let (bindings, listeners) =
                    extract_method_host_bindings_listeners(method, eval, angular_imports);
                host_bindings.extend(bindings);
                host_listeners.extend(listeners);
            }

            _ => {}
        }
    }

    (host_bindings, host_listeners)
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_allocator::Allocator;
    use oxc_parser::Parser;
    use oxc_span::SourceType;

    fn parse_class(source_text: &str) -> (Vec<HostBindingData>, Vec<HostListenerData>) {
        let allocator = Allocator::default();
        let source_type = SourceType::default().with_typescript(true);
        let ret = Parser::new(&allocator, source_text, source_type).parse();
        let semantic = oxc_semantic::SemanticBuilder::new()
            .with_build_nodes(true)
            .build(&ret.program)
            .semantic;

        let import_map = crate::analyzer::extract_import_map(&ret.module_record);
        let angular_imports =
            crate::analyzer::imports::extract_angular_imports(&ret.module_record, &semantic, false);
        let env = crate::evaluator::ResolvedEnv::new();
        let interner = crate::query::FileIdInterner::new();
        let eval = crate::evaluator::EvalInput {
            semantic: &semantic,
            file: interner.intern_path("/test/file.ts"),
            import_map: &import_map,
            mode: crate::evaluator::EvalMode::Syntax,
            env: &env,
            foreign: crate::analyzer::resolvers::angular_foreign_resolvers(),
        };

        let mut bindings = Vec::new();
        let mut listeners = Vec::new();

        for stmt in &ret.program.body {
            if let oxc_ast::ast::Statement::ClassDeclaration(class_decl) = stmt {
                let (b, l) = extract_host_bindings_listeners(class_decl, &eval, &angular_imports);
                bindings.extend(b);
                listeners.extend(l);
            }
        }

        (bindings, listeners)
    }

    #[test]
    fn test_extract_host_bindings_listeners_spans() {
        let source_text = r#"import {HostBinding, HostListener} from '@angular/core';
        class TestComponent {
            @HostBinding('class.active') isActive = true;

            @HostListener('click', ['$event'])
            onClick(e: Event) {}
        }
        "#;

        let (bindings, listeners) = parse_class(source_text);

        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].member_name.text, Some("isActive".to_string()));
        assert_eq!(bindings[0].arguments.len(), 1);
        assert_eq!(
            bindings[0].arguments[0].text,
            Some("class.active".to_string())
        );

        // Find expected name_span based on 'isActive' and 'onClick'
        let is_active_start = source_text.find("isActive").unwrap() as u32;
        let is_active_end = is_active_start + 8; // "isActive".len()
        assert_eq!(bindings[0].member_name.span.start, is_active_start);
        assert_eq!(bindings[0].member_name.span.end, is_active_end);

        let prop1_text = "isActive = true;";
        let prop1_start = source_text.find(prop1_text).unwrap() as u32;
        let last_decorator_end = source_text.find("@HostBinding('class.active')").unwrap() as u32
            + "@HostBinding('class.active')".len() as u32;
        assert_eq!(bindings[0].member_span.start, last_decorator_end);
        assert_eq!(
            bindings[0].member_span.end,
            prop1_start + prop1_text.len() as u32
        );

        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].method_name.text, Some("onClick".to_string()));
        assert_eq!(listeners[0].event_name.text, Some("click".to_string()));
        assert_eq!(listeners[0].args.len(), 1);
        assert_eq!(listeners[0].args[0].text, Some("$event".to_string()));

        let on_click_start = source_text.find("onClick").unwrap() as u32;
        let on_click_end = on_click_start + 7; // "onClick".len()
        assert_eq!(listeners[0].method_name.span.start, on_click_start);
        assert_eq!(listeners[0].method_name.span.end, on_click_end);

        let listener1_text = "onClick(e: Event) {}";
        let listener1_start = source_text.find(listener1_text).unwrap() as u32;
        let last_listener_decorator_end = source_text
            .find("@HostListener('click', ['$event'])")
            .unwrap() as u32
            + "@HostListener('click', ['$event'])".len() as u32;
        assert_eq!(listeners[0].member_span.start, last_listener_decorator_end);
        assert_eq!(
            listeners[0].member_span.end,
            listener1_start + listener1_text.len() as u32
        );
    }

    #[test]
    fn test_extract_host_bindings_arguments() {
        let source_text = r#"import {HostBinding} from '@angular/core';
        class TestComponent {
            @HostBinding() noArgs = true;
            @HostBinding('style.color') stringArg = 'red';
            @HostBinding(SOME_CONST) identifierArg = true;
        }
        "#;

        let (bindings, _) = parse_class(source_text);

        assert_eq!(bindings.len(), 3);

        // No args
        assert_eq!(bindings[0].member_name.text, Some("noArgs".to_string()));
        assert_eq!(bindings[0].arguments.len(), 0);

        // String arg
        assert_eq!(bindings[1].member_name.text, Some("stringArg".to_string()));
        assert_eq!(bindings[1].arguments.len(), 1);
        assert_eq!(bindings[1].arguments[0].kind, ExpressionValueKind::String);
        assert_eq!(
            bindings[1].arguments[0].text,
            Some("style.color".to_string())
        );

        // Identifier arg
        assert_eq!(
            bindings[2].member_name.text,
            Some("identifierArg".to_string())
        );
        assert_eq!(bindings[2].arguments.len(), 1);
        assert_eq!(
            bindings[2].arguments[0].kind,
            ExpressionValueKind::Identifier
        );
        assert_eq!(
            bindings[2].arguments[0].text,
            Some("SOME_CONST".to_string())
        );
    }

    #[test]
    fn test_extract_host_bindings_and_listeners_template_literal() {
        let source_text = r#"import {HostBinding, HostListener} from '@angular/core';
        class TestComponent {
            @HostBinding(`class.active`) isActive = true;
            @HostListener(`click`, [`$event`]) onClick(e: Event) {}
        }
        "#;

        let (bindings, listeners) = parse_class(source_text);

        assert_eq!(bindings.len(), 1);
        assert_eq!(bindings[0].member_name.text, Some("isActive".to_string()));
        assert_eq!(bindings[0].arguments.len(), 1);
        assert_eq!(bindings[0].arguments[0].kind, ExpressionValueKind::String);
        assert_eq!(
            bindings[0].arguments[0].text,
            Some("class.active".to_string())
        );

        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].method_name.text, Some("onClick".to_string()));
        assert_eq!(listeners[0].event_name.kind, ExpressionValueKind::String);
        assert_eq!(listeners[0].event_name.text, Some("click".to_string()));
        assert_eq!(listeners[0].args.len(), 1);
        assert_eq!(listeners[0].args[0].kind, ExpressionValueKind::String);
        assert_eq!(listeners[0].args[0].text, Some("$event".to_string()));
    }

    #[test]
    fn test_extract_host_listener_on_property_definition() {
        let source_text = r#"import {HostListener} from '@angular/core';
        class TestComponent {
            @HostListener('click', ['$event'])
            handleClick = ($event: any) => {};
        }
        "#;

        let (bindings, listeners) = parse_class(source_text);

        assert_eq!(bindings.len(), 0);
        assert_eq!(listeners.len(), 1);
        assert_eq!(
            listeners[0].method_name.text,
            Some("handleClick".to_string())
        );
        assert_eq!(listeners[0].event_name.text, Some("click".to_string()));
        assert_eq!(listeners[0].args.len(), 1);
        assert_eq!(listeners[0].args[0].text, Some("$event".to_string()));
    }

    #[test]
    fn test_extract_host_listener_template_literal_constant_folded() {
        let source_text = r#"import {HostListener} from '@angular/core';
        const MIN_LARGE_SCREEN_WIDTH = 1000;
        class TestComponent {
            @HostListener('window:resize', [`$event.target.innerWidth < ${MIN_LARGE_SCREEN_WIDTH}`])
            onResize(isSmallScreen: boolean) {}
        }
        "#;

        let (bindings, listeners) = parse_class(source_text);

        assert_eq!(bindings.len(), 0);
        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].method_name.text, Some("onResize".to_string()));
        assert_eq!(
            listeners[0].event_name.text,
            Some("window:resize".to_string())
        );
        assert_eq!(listeners[0].args.len(), 1);
        assert_eq!(listeners[0].args[0].kind, ExpressionValueKind::Unspecified);
        assert_eq!(listeners[0].args[0].text, None);
        assert_eq!(
            listeners[0].runtime_args,
            Some(vec!["$event.target.innerWidth < 1000".to_string()])
        );
    }

    #[test]
    fn test_extract_host_listener_non_literal_argument_preserved_as_unspecified() {
        let source_text = r#"import {HostListener} from '@angular/core';
        class TestComponent {
            @HostListener('window:resize', [`$event.target.innerWidth < ${MIN_LARGE_SCREEN_WIDTH}`])
            onResize(isSmallScreen: boolean) {}
        }
        "#;

        let (bindings, listeners) = parse_class(source_text);

        assert_eq!(bindings.len(), 0);
        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].method_name.text, Some("onResize".to_string()));
        assert_eq!(
            listeners[0].event_name.text,
            Some("window:resize".to_string())
        );
        assert_eq!(listeners[0].args.len(), 1);
        assert_eq!(listeners[0].args[0].kind, ExpressionValueKind::Unspecified);
        assert_eq!(listeners[0].args[0].text, None);
        assert_eq!(listeners[0].runtime_args, None);
        assert_eq!(listeners[0].args_errors.len(), 1);
        assert!(matches!(
            listeners[0].args_errors[0],
            HostListenerArgsError::ElementNotString { index: 0, .. }
        ));
    }

    #[test]
    fn test_extract_host_listener_identifier_argument_constant_resolved() {
        let source_text = r#"import {HostListener} from '@angular/core';
        const customEventArg = '$event';
        class TestComponent {
            @HostListener('click', [customEventArg])
            onClick(event: any) {}
        }
        "#;

        let (bindings, listeners) = parse_class(source_text);

        assert_eq!(bindings.len(), 0);
        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].method_name.text, Some("onClick".to_string()));
        assert_eq!(listeners[0].event_name.text, Some("click".to_string()));
        assert_eq!(listeners[0].args.len(), 1);
        assert_eq!(listeners[0].args[0].kind, ExpressionValueKind::Identifier);
        assert_eq!(
            listeners[0].args[0].text,
            Some("customEventArg".to_string())
        );
        assert_eq!(listeners[0].runtime_args, Some(vec!["$event".to_string()]));
        assert_eq!(listeners[0].args_errors.len(), 0);
    }

    #[test]
    fn test_extract_host_listener_non_array_argument_error() {
        let source_text = r#"import {HostListener} from '@angular/core';
        class TestComponent {
            @HostListener('click', 'notAnArray')
            onClick(event: any) {}
        }
        "#;

        let (bindings, listeners) = parse_class(source_text);

        assert_eq!(bindings.len(), 0);
        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].args_errors.len(), 1);
        assert!(matches!(
            listeners[0].args_errors[0],
            HostListenerArgsError::NotStringArray(_)
        ));
    }

    #[test]
    fn test_extract_host_listener_array_reference_constant_resolved() {
        let source_text = r#"import {HostListener} from '@angular/core';
        const customArgs = ['$event'];
        class TestComponent {
            @HostListener('click', customArgs)
            onClick(event: any) {}
        }
        "#;

        let (bindings, listeners) = parse_class(source_text);

        assert_eq!(bindings.len(), 0);
        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].method_name.text, Some("onClick".to_string()));
        assert_eq!(listeners[0].event_name.text, Some("click".to_string()));
        // In ngtsc, non-array-literal arguments result in empty args for TCB
        assert_eq!(listeners[0].args.len(), 0);
        assert_eq!(listeners[0].runtime_args, Some(vec!["$event".to_string()]));
        assert_eq!(listeners[0].args_errors.len(), 0);
    }

    #[test]
    fn test_extract_host_listener_array_reference_invalid_element_diagnostic() {
        let source_text = r#"import {HostListener} from '@angular/core';
        const customArgs = [123];
        class TestComponent {
            @HostListener('click', customArgs)
            onClick(event: any) {}
        }
        "#;

        let (bindings, listeners) = parse_class(source_text);

        assert_eq!(bindings.len(), 0);
        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].args.len(), 0);
        assert_eq!(listeners[0].runtime_args, None);
        assert_eq!(listeners[0].args_errors.len(), 1);
        assert!(matches!(
            listeners[0].args_errors[0],
            HostListenerArgsError::ElementNotString { index: 0, .. }
        ));
    }

    #[test]
    fn test_extract_host_listener_spread_argument() {
        let source_text = r#"import {HostListener} from '@angular/core';
        const baseArgs = ['$event'];
        class TestComponent {
            @HostListener('click', [...baseArgs])
            onClick(event: any) {}
        }
        "#;

        let (bindings, listeners) = parse_class(source_text);

        assert_eq!(bindings.len(), 0);
        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].method_name.text, Some("onClick".to_string()));
        assert_eq!(listeners[0].event_name.text, Some("click".to_string()));
        assert_eq!(listeners[0].args.len(), 1);
        assert_eq!(listeners[0].args[0].kind, ExpressionValueKind::Unspecified);
        assert_eq!(listeners[0].runtime_args, Some(vec!["$event".to_string()]));
        assert_eq!(listeners[0].args_errors.len(), 0);
    }

    #[test]
    fn test_extract_host_listener_incomplete_imported_arg_does_not_error() {
        let source_text = r#"import {HostListener} from '@angular/core';
        import { customArgs, customArg } from './constants';
        class TestComponent {
            @HostListener('click', customArgs)
            onClick(event: any) {}

            @HostListener('keydown', [customArg])
            onKeydown(event: any) {}
        }
        "#;

        let (bindings, listeners) = parse_class(source_text);

        assert_eq!(bindings.len(), 0);
        assert_eq!(listeners.len(), 2);

        // customArgs is imported, so in syntax mode it evaluates to Incomplete.
        // It should NOT produce a false NG1010 NotStringArray error.
        assert_eq!(listeners[0].method_name.text, Some("onClick".to_string()));
        assert_eq!(listeners[0].runtime_args, None);
        assert_eq!(listeners[0].args_errors.len(), 0);

        // [customArg] contains an imported symbol, so the element is Incomplete.
        // It should NOT produce a false NG1010 ElementNotString error.
        assert_eq!(listeners[1].method_name.text, Some("onKeydown".to_string()));
        assert_eq!(listeners[1].runtime_args, None);
        assert_eq!(listeners[1].args_errors.len(), 0);
    }

    #[test]
    fn test_extract_host_listener_dynamic_event_name_unspecified_kind() {
        let source_text = r#"import {HostListener} from '@angular/core';
        const SHORTCUT = { eventName: 'window:keydown.r' };
        class TestComponent {
            @HostListener(`${SHORTCUT.eventName}`, ['$event'])
            onKey(event?: KeyboardEvent) {}
        }
        "#;

        let (bindings, listeners) = parse_class(source_text);

        assert_eq!(bindings.len(), 0);
        assert_eq!(listeners.len(), 1);
        assert_eq!(listeners[0].method_name.text, Some("onKey".to_string()));
        assert_eq!(
            listeners[0].event_name.text,
            Some("window:keydown.r".to_string())
        );
        assert_eq!(
            listeners[0].event_name.kind,
            ExpressionValueKind::Unspecified
        );
    }
}
