use oxc_ast::ast::{Argument, Expression, ObjectPropertyKind};
use oxc_span::GetSpan;
use std::collections::HashMap;

use crate::analyzer::class_data::{AngularField, InputData, OutputData, TransformData};
///
/// Input/Output Analysis Module
///
/// This module handles the extraction of Angular inputs and outputs from class members.
/// It supports both:
/// 1. Decorator-based inputs/outputs (@Input(), @Output())
/// 2. Signal-based inputs/outputs (input(), output(), model())
///
/// # Feature Parity Status (vs compiler-cli)
///
/// | Feature | Status | Notes |
/// |---------|--------|-------|
/// | @Input/@Output Decorators | ✅ Supported | basic usage, aliases, required |
/// | Signal Inputs/Outputs | ✅ Supported | input(), output(), model() |
/// | Aliases | ⚠️ Partial | String literals only. Complex static expressions are NOT evaluated. |
/// | Transforms | ✅ Supported | In decorated-based and signal inputs |
/// | Inheritance | ❌ Missing | Base class inputs/outputs are NOT scanned here. This must be handled by the caller. |
/// | Legacy Metadata | ✅ Supported | `inputs: [...]` and `outputs: [...]` arrays in decorators. |
///
/// # Architecture
/// This module uses `oxc_ast` to inspect class members. It does NOT have access to the
/// type checker or semantic model for cross-file resolution here.
///
use oxc_semantic::Semantic;

pub struct ExtractContext<'a> {
    pub angular_imports: &'a crate::analyzer::imports::AngularImports,
    pub semantic: &'a Semantic<'a>,
}

use super::utils::{
    extract_bool, extract_property_key, extract_string, get_decorator_args,
    is_angular_decorator_named, resolve_angular_call, ResolvedAngularCall,
};

#[derive(Default)]
struct InputOptions {
    alias: Option<String>,
    required: bool,
    transform: Option<TransformData>,
}

/// Extract alias from @Input('alias') or @Input({alias: 'alias'})
fn extract_input_alias(
    args: &oxc_allocator::Vec<Argument>,
    ctx: &ExtractContext<'_>,
) -> InputOptions {
    let Some(first) = args.first() else {
        return InputOptions::default();
    };

    // Case A: @Input('alias')
    if let Some(s) = extract_string(first.to_expression(), ctx.semantic) {
        return InputOptions {
            alias: Some(s),
            ..Default::default()
        };
    }

    // Case B: @Input({alias: 'alias', required: true})
    if let Argument::ObjectExpression(obj) = first {
        return parse_input_options_object(obj, ctx);
    }

    InputOptions::default()
}

/// Extract alias from @Output('alias')
fn extract_output_alias<'a>(
    args: &oxc_allocator::Vec<Argument<'a>>,
    semantic: &Semantic<'a>,
) -> Option<String> {
    let first = args.first()?;
    extract_string(first.to_expression(), semantic)
}

pub fn parse_input_decorator(
    decorator: &oxc_ast::ast::Decorator,
    prop_name: &str,
    property_span: Option<oxc_span::Span>,
    ctx: &ExtractContext<'_>,
) -> Option<(InputData, bool)> {
    if !is_angular_decorator_named(decorator, "Input", ctx.semantic, ctx.angular_imports) {
        return None;
    }
    let options = match get_decorator_args(decorator) {
        Some(args) => extract_input_alias(args, ctx),
        None => InputOptions::default(),
    };

    let has_transform = options.transform.is_some();
    Some((
        InputData {
            name: prop_name.to_string(),
            alias: options.alias,
            required: options.required,
            is_signal: false,
            decorator_span: Some(decorator.span),
            property_span,
            transform: options.transform,
            is_restricted: false,
            is_literal: false,
        },
        has_transform,
    ))
}

pub fn parse_output_decorator<'a>(
    decorator: &'a oxc_ast::ast::Decorator<'a>,
    prop_name: &str,
    property_span: Option<oxc_span::Span>,
    ctx: &ExtractContext<'a>,
) -> Option<OutputData> {
    if !is_angular_decorator_named(decorator, "Output", ctx.semantic, ctx.angular_imports) {
        return None;
    }
    let alias =
        get_decorator_args(decorator).and_then(|args| extract_output_alias(args, ctx.semantic));

    Some(OutputData {
        name: prop_name.to_string(),
        alias,
        decorator_span: Some(decorator.span),
        property_span,
        is_signal: false,
    })
}
/// Check if property is initialized with input(), output() or model()
fn parse_signal_input_output(
    prop: &oxc_ast::ast::PropertyDefinition,
    ctx: &ExtractContext<'_>,
    fields: &mut Vec<AngularField>,
) -> bool {
    let Some(init) = prop.value.as_ref() else {
        return false;
    };

    let call = match init.get_inner_expression() {
        Expression::CallExpression(c) => c,
        _ => return false,
    };

    let Some(prop_name_cow) = extract_property_key(&prop.key) else {
        return false;
    };
    let prop_name = prop_name_cow.into_owned();

    let Some(resolved_call) = resolve_angular_call(call, ctx.semantic, ctx.angular_imports) else {
        return false;
    };

    match resolved_call {
        ResolvedAngularCall::Input { is_required } => {
            let options_arg = if is_required {
                call.arguments.first()
            } else {
                call.arguments.get(1)
            };
            let options = extract_signal_options(options_arg, ctx);
            let input = InputData {
                name: prop_name,
                alias: options.alias,
                required: is_required,
                is_signal: true,
                decorator_span: None,
                property_span: Some(prop.span),
                transform: options.transform,
                is_restricted: false,
                is_literal: false,
            };
            fields.push(AngularField::Input(input));
            true
        }
        ResolvedAngularCall::Model { is_required } => {
            let options_arg = if is_required {
                call.arguments.first()
            } else {
                call.arguments.get(1)
            };
            let options = extract_signal_options(options_arg, ctx);
            let input = InputData {
                name: prop_name.clone(),
                alias: options.alias.clone(),
                required: is_required,
                is_signal: true,
                decorator_span: None,
                property_span: Some(prop.span),
                transform: None,
                is_restricted: false,
                is_literal: false,
            };
            let output_alias = Some(format!(
                "{}Change",
                options.alias.as_ref().unwrap_or(&prop_name)
            ));
            let output = OutputData {
                name: prop_name,
                alias: output_alias,
                decorator_span: None,
                property_span: Some(prop.span),
                is_signal: true,
            };
            fields.push(AngularField::Input(input));
            fields.push(AngularField::Output(output));
            true
        }
        ResolvedAngularCall::Output => {
            let options = extract_signal_options(call.arguments.first(), ctx);
            let output = OutputData {
                name: prop_name,
                alias: options.alias,
                is_signal: true,
                decorator_span: None,
                property_span: Some(prop.span),
            };
            fields.push(AngularField::Output(output));
            false
        }
        ResolvedAngularCall::OutputFromObservable => {
            let options = extract_signal_options(call.arguments.get(1), ctx);
            let output = OutputData {
                name: prop_name,
                alias: options.alias,
                is_signal: true,
                decorator_span: None,
                property_span: Some(prop.span),
            };
            fields.push(AngularField::Output(output));
            false
        }
        _ => false,
    }
}

/// Extract alias from signal input/output options object
fn extract_signal_options(arg: Option<&Argument>, ctx: &ExtractContext<'_>) -> InputOptions {
    if let Some(Argument::ObjectExpression(obj)) = arg {
        return parse_input_options_object(obj, ctx);
    }

    InputOptions::default()
}

/// Parse common input/model options like alias, required, and transform
fn parse_input_options_object(
    obj: &oxc_ast::ast::ObjectExpression<'_>,
    ctx: &ExtractContext<'_>,
) -> InputOptions {
    let mut alias = None;
    let mut required = false;
    let mut transform = None;

    for prop in &obj.properties {
        let ObjectPropertyKind::ObjectProperty(p) = prop else {
            continue;
        };

        let Some(name) = extract_property_key(&p.key) else {
            continue;
        };

        match name.as_ref() {
            "alias" => {
                // TODO: Support complex expressions (static member access, constants)
                // Currently only supports string literals
                alias = extract_string(&p.value, ctx.semantic);
            }
            "required" => {
                required = extract_bool(&p.value, ctx.semantic).unwrap_or(false);
            }
            "transform" => {
                if let Some(t_type) = crate::analyzer::transforms::extract_transform_type(&p.value)
                {
                    transform = Some(match t_type {
                        crate::analyzer::transforms::ExtractedTransformType::Type(type_span) => {
                            use oxc_span::GetSpan;
                            TransformData::Type {
                                type_span,
                                value_span: p.value.span(),
                            }
                        }
                        crate::analyzer::transforms::ExtractedTransformType::Expression(span) => {
                            TransformData::Expression(span)
                        }
                    });
                }
            }
            _ => {}
        }
    }

    InputOptions {
        alias,
        required,
        transform,
    }
}

fn process_decorators<'a>(
    decorators: &'a [oxc_ast::ast::Decorator<'a>],
    prop_name: &str,
    key: &'a oxc_ast::ast::PropertyKey<'a>,
    accessibility: Option<oxc_ast::ast::TSAccessibility>,
    readonly: bool,
    is_signal: bool,
    property_span: Option<oxc_span::Span>,
    ctx: &ExtractContext<'a>,
    fields: &mut Vec<AngularField>,
) {
    let mut is_input = is_signal;

    for decorator in decorators {
        if let Some((input, _transform)) =
            parse_input_decorator(decorator, prop_name, property_span, ctx)
        {
            fields.push(AngularField::Input(input));
            is_input = true;
        }
        if let Some(output) = parse_output_decorator(decorator, prop_name, property_span, ctx) {
            fields.push(AngularField::Output(output));
        }
    }

    if is_input {
        let is_restricted = accessibility == Some(oxc_ast::ast::TSAccessibility::Private)
            || accessibility == Some(oxc_ast::ast::TSAccessibility::Protected)
            || readonly;
        let is_literal = matches!(key, oxc_ast::ast::PropertyKey::StringLiteral(_));

        if let Some(AngularField::Input(input)) = fields.iter_mut().find(|f| match f {
            AngularField::Input(i) => i.name == prop_name,
            _ => false,
        }) {
            input.is_restricted = is_restricted;
            input.is_literal = is_literal;
        }
    }
}

fn parse_io_array(expr: &Expression, semantic: &Semantic) -> HashMap<String, String> {
    let mut map = HashMap::new();
    let Some(strings) = super::utils::extract_string_array(expr, semantic) else {
        return map;
    };
    for val in strings {
        if let Some((prop_name, binding_name)) = val.split_once(':') {
            map.insert(
                prop_name.trim().to_string(),
                binding_name.trim().to_string(),
            );
        } else {
            let name = val.trim().to_string();
            map.insert(name.clone(), name);
        }
    }
    map
}

fn extract_decorator_io_maps(
    class: &oxc_ast::ast::Class,
    ctx: &ExtractContext<'_>,
) -> (HashMap<String, String>, HashMap<String, String>) {
    let mut inputs = HashMap::new();
    let mut outputs = HashMap::new();

    for decorator in &class.decorators {
        let is_comp_or_dir =
            is_angular_decorator_named(decorator, "Component", ctx.semantic, ctx.angular_imports)
                || is_angular_decorator_named(
                    decorator,
                    "Directive",
                    ctx.semantic,
                    ctx.angular_imports,
                );
        if !is_comp_or_dir {
            continue;
        }
        let Some(args) = get_decorator_args(decorator) else {
            continue;
        };
        let Some(Argument::ObjectExpression(obj)) = args.first() else {
            continue;
        };

        for prop in &obj.properties {
            let ObjectPropertyKind::ObjectProperty(p) = prop else {
                continue;
            };
            let Some(key_name) = extract_property_key(&p.key) else {
                continue;
            };
            if key_name == "inputs" {
                inputs = parse_io_array(&p.value, ctx.semantic);
            } else if key_name == "outputs" {
                outputs = parse_io_array(&p.value, ctx.semantic);
            }
        }
        break; // Only process the first matching decorator
    }

    (inputs, outputs)
}

fn has_input(fields: &[AngularField], name: &str) -> bool {
    fields.iter().any(|f| match f {
        AngularField::Input(i) => i.name == name,
        _ => false,
    })
}

fn has_output(fields: &[AngularField], name: &str) -> bool {
    fields.iter().any(|f| match f {
        AngularField::Output(o) => o.name == name,
        _ => false,
    })
}

pub fn extract_inputs_outputs<'a>(
    class: &'a oxc_ast::ast::Class<'a>,
    angular_imports: &crate::analyzer::imports::AngularImports,
    semantic: &Semantic<'a>,
) -> Vec<AngularField> {
    let ctx = ExtractContext {
        angular_imports,
        semantic,
    };
    let mut fields = Vec::new();
    let mut static_coerced = Vec::new();

    let (decorator_inputs, decorator_outputs) = extract_decorator_io_maps(class, &ctx);

    for element in &class.body.body {
        let extracted_prop_name = match element {
            oxc_ast::ast::ClassElement::PropertyDefinition(prop) => {
                let prop_name = match extract_property_key(&prop.key) {
                    Some(name) => name.into_owned(),
                    None => continue,
                };

                // Check for ngAcceptInputType_prop
                if !prop.computed && prop.r#static && prop_name.starts_with("ngAcceptInputType_") {
                    static_coerced.push(prop_name["ngAcceptInputType_".len()..].to_string());
                }

                // Check for signal-based input()/output()/model() in initializer
                let is_signal = parse_signal_input_output(prop, &ctx, &mut fields);

                process_decorators(
                    &prop.decorators,
                    &prop_name,
                    &prop.key,
                    prop.accessibility,
                    prop.readonly,
                    is_signal,
                    Some(prop.span),
                    &ctx,
                    &mut fields,
                );
                Some(prop_name)
            }
            oxc_ast::ast::ClassElement::MethodDefinition(method) => {
                let prop_name = match extract_property_key(&method.key) {
                    Some(name) => name.into_owned(),
                    None => continue,
                };

                process_decorators(
                    &method.decorators,
                    &prop_name,
                    &method.key,
                    method.accessibility,
                    false, // Methods cannot be readonly
                    false,
                    Some(method.span),
                    &ctx,
                    &mut fields,
                );
                Some(prop_name)
            }
            oxc_ast::ast::ClassElement::AccessorProperty(acc) => {
                let prop_name = match extract_property_key(&acc.key) {
                    Some(name) => name.into_owned(),
                    None => continue,
                };

                process_decorators(
                    &acc.decorators,
                    &prop_name,
                    &acc.key,
                    acc.accessibility,
                    false, // Accessors cannot be readonly
                    false,
                    Some(acc.span),
                    &ctx,
                    &mut fields,
                );
                Some(prop_name)
            }
            _ => None,
        };

        let Some(prop_name) = extracted_prop_name else {
            continue;
        };

        if !has_input(&fields, &prop_name) {
            if let Some(alias) = decorator_inputs.get(&prop_name) {
                let resolved_alias = if alias != &prop_name {
                    Some(alias.clone())
                } else {
                    None
                };
                fields.push(AngularField::Input(InputData {
                    name: prop_name.clone(),
                    alias: resolved_alias,
                    required: false,
                    is_signal: false,
                    decorator_span: None,
                    property_span: Some(element.span()),
                    transform: None,
                    is_restricted: false,
                    is_literal: false,
                }));
            }
        }

        if !has_output(&fields, &prop_name) {
            if let Some(alias) = decorator_outputs.get(&prop_name) {
                let resolved_alias = if alias != &prop_name {
                    Some(alias.clone())
                } else {
                    None
                };
                fields.push(AngularField::Output(OutputData {
                    name: prop_name.clone(),
                    alias: resolved_alias,
                    decorator_span: None,
                    property_span: Some(element.span()),
                    is_signal: false,
                }));
            }
        }
    }

    // Process static coerced fields
    for field in static_coerced {
        fields.push(AngularField::InputCoercion(field));
    }
    fields
}

pub(crate) fn parse_legacy_input<'a>(
    expr: &'a Expression<'a>,
    semantic: &Semantic<'a>,
) -> Option<InputData> {
    if let Some(s) = extract_string(expr, semantic) {
        let (name, alias) = if let Some((n, a)) = s.split_once(':') {
            (n.trim().to_string(), Some(a.trim().to_string()))
        } else {
            (s.trim().to_string(), None)
        };
        return Some(InputData {
            name,
            alias,
            required: false,
            is_signal: false,
            decorator_span: Some(expr.span()),
            property_span: None,
            transform: None,
            is_restricted: false,
            is_literal: false,
        });
    }

    if let Expression::ObjectExpression(obj) = expr.get_inner_expression() {
        let mut name = None;
        let mut alias = None;
        let mut required = false;
        let mut transform = None;
        for prop in &obj.properties {
            let ObjectPropertyKind::ObjectProperty(p) = prop else {
                continue;
            };
            let Some(key) = extract_property_key(&p.key) else {
                continue;
            };
            match key.as_ref() {
                "name" => name = extract_string(&p.value, semantic),
                "alias" => alias = extract_string(&p.value, semantic),
                "required" => required = extract_bool(&p.value, semantic).unwrap_or(false),
                "transform" => {
                    if let Some(t_type) =
                        crate::analyzer::transforms::extract_transform_type(&p.value)
                    {
                        transform = Some(match t_type {
                            crate::analyzer::transforms::ExtractedTransformType::Type(
                                type_span,
                            ) => TransformData::Type {
                                type_span,
                                value_span: p.value.span(),
                            },
                            crate::analyzer::transforms::ExtractedTransformType::Expression(
                                span,
                            ) => TransformData::Expression(span),
                        });
                    }
                }
                _ => {}
            }
        }
        if let Some(name) = name {
            return Some(InputData {
                name,
                alias,
                required,
                is_signal: false,
                decorator_span: Some(expr.span()),
                property_span: None,
                transform,
                is_restricted: false,
                is_literal: false,
            });
        }
    }

    None
}

pub(crate) fn parse_legacy_output<'a>(
    expr: &'a Expression<'a>,
    semantic: &Semantic<'a>,
) -> Option<OutputData> {
    let s = extract_string(expr, semantic)?;
    let (name, alias) = if let Some((n, a)) = s.split_once(':') {
        (n.trim().to_string(), Some(a.trim().to_string()))
    } else {
        (s.trim().to_string(), None)
    };
    Some(OutputData {
        name,
        alias,
        decorator_span: Some(expr.span()),
        property_span: None,
        is_signal: false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use oxc_semantic::SemanticBuilder;

    struct TestExtracted {
        inputs: Vec<InputData>,
        outputs: Vec<OutputData>,
        coerced: Vec<String>,
    }

    #[cfg(test)]
    fn test_extract(
        class: &oxc_ast::ast::Class,
        angular_imports: &crate::analyzer::imports::AngularImports,
        semantic: &Semantic,
    ) -> Vec<AngularField> {
        extract_inputs_outputs(class, angular_imports, semantic)
    }

    use oxc_allocator::Allocator;
    use oxc_parser::Parser;
    use oxc_span::SourceType;

    fn parse_class(source_text: &str) -> TestExtracted {
        let allocator = Allocator::default();
        let source_type = SourceType::default().with_typescript(true);
        let ret = Parser::new(&allocator, source_text, source_type).parse();
        let semantic_ret = SemanticBuilder::new()
            .with_build_nodes(true)
            .build(&ret.program);
        let semantic = semantic_ret.semantic;
        let angular_imports =
            crate::analyzer::imports::extract_angular_imports(&ret.module_record, &semantic, false);

        let mut inputs = Vec::new();
        let mut outputs = Vec::new();
        let mut coerced = Vec::new();

        for stmt in &ret.program.body {
            if let oxc_ast::ast::Statement::ClassDeclaration(class_decl) = stmt {
                let res = test_extract(class_decl, &angular_imports, &semantic);
                for field in res {
                    match field {
                        AngularField::Input(i) => inputs.push(i),
                        AngularField::Output(o) => outputs.push(o),
                        AngularField::InputCoercion(name) => coerced.push(name),
                        _ => {}
                    }
                }
            }
        }

        TestExtracted {
            inputs,
            outputs,
            coerced,
        }
    }

    #[test]
    fn test_extract_inputs_outputs_from_properties() {
        let source = r#"import {Input, Output} from '@angular/core';
        class TestComponent {
            @Input() simpleInput: string;
            @Input('alias') aliasedInput: string;
            @Input({ required: true, alias: 'reqAlias' }) configInput: string;
            @Input({ transform: (v: boolean) => !v }) transformInput: boolean;


            @Output() simpleOutput = new EventEmitter();
            @Output('outAlias') aliasedOutput = new EventEmitter();
        }
        "#;

        let ext = parse_class(source);
        let inputs = ext.inputs;
        let outputs = ext.outputs;

        assert_eq!(inputs.len(), 4);
        assert_eq!(inputs[0].name, "simpleInput");
        assert_eq!(inputs[0].alias, None);
        assert!(!inputs[0].required);

        assert_eq!(inputs[1].name, "aliasedInput");
        assert_eq!(inputs[1].alias.as_deref(), Some("alias"));

        assert_eq!(inputs[2].name, "configInput");
        assert_eq!(inputs[2].alias.as_deref(), Some("reqAlias"));
        assert!(inputs[2].required);

        assert_eq!(inputs[3].name, "transformInput");
        let tt = inputs[3].transform.as_ref().unwrap();
        let (type_span, value_span) = match tt {
            TransformData::Type {
                type_span,
                value_span,
            } => (type_span, value_span),
            TransformData::Expression(s) => (s, s),
        };
        assert!(matches!(tt, TransformData::Type { .. }));
        assert_eq!(
            &source[type_span.start as usize..type_span.end as usize],
            "boolean"
        );
        assert_eq!(
            &source[value_span.start as usize..value_span.end as usize],
            "(v: boolean) => !v"
        );

        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0].name, "simpleOutput");
        assert_eq!(outputs[0].alias, None);

        assert_eq!(outputs[1].name, "aliasedOutput");
        assert_eq!(outputs[1].alias.as_deref(), Some("outAlias"));
    }

    #[test]
    fn test_extract_inputs_outputs_from_methods_and_accessors() {
        let source = r#"import {Input, Output} from '@angular/core';
        class TestComponent {
            // MethodDefinition (setter)
            @Input()
            set routerLink(commands: any[] | string | null | undefined) {}

            @Input('rtAlias')
            set aliasedLink(val: string) {}

            @Output()
            get activeStateChange() { return this._output; }

            // AccessorProperty (auto-accessor / experimental decorators)
            @Input() accessor myAccessorProp: string;
        }
        "#;

        let ext = parse_class(source);
        let inputs = ext.inputs;
        let outputs = ext.outputs;

        // Asserting 3 inputs on methods/accessors
        assert_eq!(inputs.len(), 3);
        assert_eq!(inputs[0].name, "routerLink");
        assert_eq!(inputs[0].alias, None);

        assert_eq!(inputs[1].name, "aliasedLink");
        assert_eq!(inputs[1].alias.as_deref(), Some("rtAlias"));

        assert_eq!(inputs[2].name, "myAccessorProp");

        // Asserting 1 output on a getter
        assert_eq!(outputs.len(), 1);
        assert_eq!(outputs[0].name, "activeStateChange");
    }

    #[test]
    fn test_extract_signal_inputs_outputs() {
        let source = r#"
        import { input, model, output } from '@angular/core';
        class SignalComponent {
            // Signal inputs
            name = input<string>('World');
            aliasObj = input(123, { alias: 'inputAlias' });
            req = input.required<number>();
            reqAlias = input.required<string>({ alias: 'reqInputAlias' });

            // Signal outputs
            submitted = output<string>();
            aliasedOut = output<void>({ alias: 'outLimit' });

            // Model inputs/outputs
            val = model(0);
            checked = model(false, { alias: 'isChecked' });
            reqModel = model.required<string>();
            reqModelAlias = model.required<number>({ alias: 'reqModelAlias' });
        }
        "#;

        let ext = parse_class(source);
        let inputs = ext.inputs;
        let outputs = ext.outputs;

        // Inputs: name, aliasObj, req, reqAlias, val, checked, reqModel, reqModelAlias (8 total)
        assert_eq!(inputs.len(), 8);

        // 1. name = input<string>('World')
        assert_eq!(inputs[0].name, "name");
        assert!(inputs[0].is_signal);
        assert!(!inputs[0].required);
        assert_eq!(inputs[0].alias, None);

        // 2. aliasObj = input(123, { alias: 'inputAlias' })
        assert_eq!(inputs[1].name, "aliasObj");
        assert_eq!(inputs[1].alias.as_deref(), Some("inputAlias"));

        // 3. req = input.required<number>()
        assert_eq!(inputs[2].name, "req");
        assert!(inputs[2].required);

        // 4. reqAlias = input.required<string>({ alias: 'reqInputAlias' })
        assert_eq!(inputs[3].name, "reqAlias");
        assert!(inputs[3].required);
        assert_eq!(inputs[3].alias.as_deref(), Some("reqInputAlias"));

        // 5. val = model(0) -> Input "val", Output "valChange"
        assert_eq!(inputs[4].name, "val");
        assert!(inputs[4].is_signal);

        // 6. checked = model(false, { alias: 'isChecked' })
        assert_eq!(inputs[5].name, "checked");
        assert_eq!(inputs[5].alias.as_deref(), Some("isChecked"));

        // 7. reqModel = model.required()
        assert_eq!(inputs[6].name, "reqModel");
        assert!(inputs[6].required);

        // 8. reqModelAlias = model.required({ alias: 'reqModelAlias' })
        assert_eq!(inputs[7].name, "reqModelAlias");
        assert_eq!(inputs[7].alias.as_deref(), Some("reqModelAlias"));

        // Outputs: submitted, aliasedOut, valChange, checkedChange, reqModelChange, reqModelAliasChange (6 total)
        assert_eq!(outputs.len(), 6);

        // 1. submitted = output<string>()
        assert_eq!(outputs[0].name, "submitted");
        assert_eq!(outputs[0].alias, None);

        // 2. aliasedOut = output<void>({ alias: 'outLimit' })
        assert_eq!(outputs[1].name, "aliasedOut");
        assert_eq!(outputs[1].alias.as_deref(), Some("outLimit"));

        // 3. val -> name: "val", alias: "valChange"
        assert_eq!(outputs[2].name, "val");
        assert_eq!(outputs[2].alias.as_deref(), Some("valChange"));

        // 4. checked -> name: "checked", alias: "isCheckedChange"
        assert_eq!(outputs[3].name, "checked");
        assert_eq!(outputs[3].alias.as_deref(), Some("isCheckedChange"));

        // 5. reqModel -> name: "reqModel", alias: "reqModelChange"
        assert_eq!(outputs[4].name, "reqModel");
        assert_eq!(outputs[4].alias.as_deref(), Some("reqModelChange"));

        // 6. reqModelAlias -> name: "reqModelAlias", alias: "reqModelAliasChange"
        assert_eq!(outputs[5].name, "reqModelAlias");
        assert_eq!(outputs[5].alias.as_deref(), Some("reqModelAliasChange"));
    }

    #[test]
    fn test_extract_output_from_observable() {
        let source = r#"
        import { outputFromObservable } from '@angular/core/rxjs-interop';
        class ObservableOutputComponent {
            basic = outputFromObservable(myObs);
            aliased = outputFromObservable(myObs, { alias: 'customAlias' });
        }
        "#;

        let ext = parse_class(source);
        let outputs = ext.outputs;

        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0].name, "basic");
        assert_eq!(outputs[0].alias, None);

        assert_eq!(outputs[1].name, "aliased");
        assert_eq!(outputs[1].alias.as_deref(), Some("customAlias"));
    }

    #[test]
    fn test_extract_inputs_outputs_without_parens() {
        let source = r#"import {Input, Output} from '@angular/core';
        class NoParensComponent {
            @Input inputNoParens: string;
            @Output outputNoParens = new EventEmitter();
        }
        "#;

        let ext = parse_class(source);
        let inputs = ext.inputs;
        let outputs = ext.outputs;

        assert_eq!(inputs.len(), 1, "Should detect @Input without parens");
        assert_eq!(inputs[0].name, "inputNoParens");

        assert_eq!(outputs.len(), 1, "Should detect @Output without parens");
        assert_eq!(outputs[0].name, "outputNoParens");
    }

    #[test]
    fn test_extract_signal_inputs_initial_value_object() {
        let source = r#"
        import { input } from '@angular/core';
        class InitialValueComponent {
            // input({ alias: 'internal', count: 0 }) -> initial value is object, NO options
            // The parser should NOT find an alias here because the first arg is initial value
            state = input({ alias: 'internal', count: 0 });

            // input(initial, options)
            // Here the second arg IS options
            correct = input({ count: 0 }, { alias: 'external' });
        }
        "#;

        let ext = parse_class(source);
        let inputs = ext.inputs;

        assert_eq!(inputs.len(), 2);

        // 1. state = input({ alias: 'internal', count: 0 });
        assert_eq!(inputs[0].name, "state");
        // Should NOT have an alias, because the object is the initial value, not options
        assert_eq!(inputs[0].alias, None);

        // 2. correct = input({ count: 0 }, { alias: 'external' });
        assert_eq!(inputs[1].name, "correct");
        assert_eq!(inputs[1].alias.as_deref(), Some("external"));
    }

    #[test]
    fn test_extract_options_with_template_literal() {
        let source = r#"
        import { input, Input } from '@angular/core';
        class TemplateLiteralComponent {
            // input(0, { alias: `tmplAlias` })
            input1 = input(0, { alias: `tmplAlias` });

            // @Input(`decAlias`)
            @Input(`decAlias`) input2: string;
        }
        "#;

        let ext = parse_class(source);
        let inputs = ext.inputs;

        assert_eq!(inputs.len(), 2);
        assert_eq!(inputs[0].alias.as_deref(), Some("tmplAlias"));
        assert_eq!(inputs[1].alias.as_deref(), Some("decAlias"));
    }
    #[test]
    fn test_extract_string_literal_property_keys() {
        let source = r#"import {Input} from '@angular/core';
        class LiteralKeysComponent {
            @Input() 'stringLiteral'!: string;
            @Input() 123!: number;
        }
        "#;

        let ext = parse_class(source);
        let literal_inputs: Vec<String> = ext
            .inputs
            .iter()
            .filter(|i| i.is_literal)
            .map(|i| i.name.clone())
            .collect();
        assert_eq!(literal_inputs, vec!["stringLiteral"]);
    }

    #[test]
    fn test_extract_coerced_input_fields() {
        let source = r#"
        import { input, Input } from '@angular/core';
        class CoercedComponent {
            @Input() noTransform: string;
            @Input({ transform: booleanAttribute }) withTransform: boolean;

            static ngAcceptInputType_staticCoerced: string | boolean;
            @Input() staticCoerced: string;

            static ngAcceptInputType_signalField: string | number;
            signalField = input<number>(0);

            signalWithTransform = input(false, { transform: booleanAttribute });
        }
        "#;

        let ext = parse_class(source);
        let mut coerced: Vec<String> = ext
            .coerced
            .into_iter()
            .filter(|name| ext.inputs.iter().any(|i| &i.name == name && !i.is_signal))
            .collect();
        let coerced_transforms: Vec<String> = ext
            .inputs
            .iter()
            .filter(|i| !i.is_signal && i.transform.is_some())
            .map(|i| i.name.clone())
            .collect();
        coerced.extend(coerced_transforms);
        coerced.sort();
        let mut expected = vec!["staticCoerced", "withTransform"];
        expected.sort();
        assert_eq!(coerced, expected);
    }

    #[test]
    fn test_extract_restricted_input_fields() {
        let source = r#"import {Input} from '@angular/core';
        class RestrictedComponent {
            @Input() private privateField: string;
            @Input() protected protectedField: string;
            @Input() readonly readonlyField: string;

            // Methods
            @Input() private set privateSetter(v: string) {}
            @Input() protected set protectedSetter(v: string) {}

            // Public should NOT be restricted
            @Input() publicField: string;
            @Input() set publicSetter(v: string) {}

            // Accessor
            @Input() private accessor privateAccessor: string;
        }
        "#;

        let ext = parse_class(source);
        let mut restricted: Vec<String> = ext
            .inputs
            .iter()
            .filter(|i| i.is_restricted)
            .map(|i| i.name.clone())
            .collect();
        restricted.sort();
        let mut expected = vec![
            "privateAccessor",
            "privateField",
            "privateSetter",
            "protectedField",
            "protectedSetter",
            "readonlyField",
        ];
        expected.sort();
        assert_eq!(restricted, expected);
    }

    #[test]
    fn test_extract_transform_type_variations() {
        let source = r#"
        import { input, Input } from '@angular/core';
        class TransformTests {
            @Input({ transform: (v) => v }) noType: any;
            @Input({ transform: (v: string | number) => v }) unionType: any;
            @Input({ transform: function(v: boolean[]) { return v; } }) funcExpr: any;
            @Input({ transform: booleanAttribute }) identifier: any;

            sigNoType = input(null, { transform: (v) => v });
            sigUnionType = input(null, { transform: (v: 'a' | 'b') => v });
            sigFuncExpr = input(null, { transform: function(v: {a: string}) { return v; } });
        }
        "#;

        let ext = parse_class(source);
        let inputs = ext.inputs;
        assert_eq!(inputs.len(), 7);

        // noType
        assert_eq!(inputs[0].name, "noType");
        assert!(inputs[0].transform.is_none());

        // unionType
        assert_eq!(inputs[1].name, "unionType");
        let ut = inputs[1].transform.as_ref().unwrap();
        let TransformData::Type {
            type_span,
            value_span,
        } = ut
        else {
            panic!("Expected Type variant")
        };
        assert_eq!(
            &source[type_span.start as usize..type_span.end as usize],
            "string | number"
        );
        assert_eq!(
            &source[value_span.start as usize..value_span.end as usize],
            "(v: string | number) => v"
        );

        // funcExpr
        assert_eq!(inputs[2].name, "funcExpr");
        let fe = inputs[2].transform.as_ref().unwrap();
        let TransformData::Type {
            type_span,
            value_span,
        } = fe
        else {
            panic!("Expected Type variant")
        };
        assert_eq!(
            &source[type_span.start as usize..type_span.end as usize],
            "boolean[]"
        );
        assert_eq!(
            &source[value_span.start as usize..value_span.end as usize],
            "function(v: boolean[]) { return v; }"
        );

        // identifier
        assert_eq!(inputs[3].name, "identifier");
        let id = inputs[3].transform.as_ref().unwrap();
        let TransformData::Expression(span) = id else {
            panic!("Expected Expression variant")
        };
        assert_eq!(
            &source[span.start as usize..span.end as usize],
            "booleanAttribute"
        );

        // sigNoType
        assert_eq!(inputs[4].name, "sigNoType");
        assert!(inputs[4].transform.is_none());

        // sigUnionType
        assert_eq!(inputs[5].name, "sigUnionType");
        let sut = inputs[5].transform.as_ref().unwrap();
        let TransformData::Type {
            type_span,
            value_span,
        } = sut
        else {
            panic!("Expected Type variant")
        };
        assert_eq!(
            &source[type_span.start as usize..type_span.end as usize],
            "'a' | 'b'"
        );
        assert_eq!(
            &source[value_span.start as usize..value_span.end as usize],
            "(v: 'a' | 'b') => v"
        );

        // sigFuncExpr
        assert_eq!(inputs[6].name, "sigFuncExpr");
        let sfe = inputs[6].transform.as_ref().unwrap();
        let TransformData::Type {
            type_span,
            value_span,
        } = sfe
        else {
            panic!("Expected Type variant")
        };
        assert_eq!(
            &source[type_span.start as usize..type_span.end as usize],
            "{a: string}"
        );
        assert_eq!(
            &source[value_span.start as usize..value_span.end as usize],
            "function(v: {a: string}) { return v; }"
        );
    }

    #[test]
    fn test_extract_inputs_outputs_arrays() {
        let source = r#"import {Component} from '@angular/core';
        @Component({
            selector: 'test-component',
            inputs: ['name', 'aliasInput: publicName'],
            outputs: ['emitter', 'aliasOutput: publicEmitter']
        })
        class TestComponent {
            name: string;
            aliasInput: string;
            emitter = new EventEmitter();
            aliasOutput = new EventEmitter();
        }
        "#;

        let ext = parse_class(source);
        let inputs = ext.inputs;
        let outputs = ext.outputs;

        assert_eq!(inputs.len(), 2);
        assert_eq!(inputs[0].name, "name");
        assert_eq!(inputs[0].alias, None);
        assert_eq!(inputs[1].name, "aliasInput");
        assert_eq!(inputs[1].alias.as_deref(), Some("publicName"));

        assert_eq!(outputs.len(), 2);
        assert_eq!(outputs[0].name, "emitter");
        assert_eq!(outputs[0].alias, None);
        assert_eq!(outputs[1].name, "aliasOutput");
        assert_eq!(outputs[1].alias.as_deref(), Some("publicEmitter"));
    }
}
