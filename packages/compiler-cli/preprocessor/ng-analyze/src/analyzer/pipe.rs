use oxc_ast::ast::{Decorator, Expression, ObjectPropertyKind};
use oxc_semantic::Semantic;
use oxc_span::GetSpan;

use crate::analyzer::class_data::PipeData;

use super::utils::{extract_bool, extract_property_key, extract_string};

/// Parse a @Pipe decorator
pub fn parse_decorator<'a>(
    decorator: &'a Decorator<'a>,
    semantic: &Semantic<'a>,
    angular_imports: &crate::analyzer::imports::AngularImports,
) -> Option<PipeData> {
    let Expression::CallExpression(call_expr) = &decorator.expression else {
        return None;
    };

    if !crate::analyzer::utils::is_angular_decorator_named(
        decorator,
        "Pipe",
        semantic,
        angular_imports,
    ) {
        return None;
    }

    parse_pipe_args(
        call_expr,
        crate::analyzer::utils::extract_decorator_name(decorator),
        semantic,
    )
}

fn parse_pipe_args<'a>(
    call_expr: &oxc_ast::ast::CallExpression<'a>,
    decorator_name: Option<String>,
    semantic: &Semantic<'a>,
) -> Option<PipeData> {
    let mut name = None;
    let mut name_span = None;
    let mut pure = None;
    let mut pure_span = None;
    let mut standalone = None;
    let mut standalone_span = None;
    let mut args_span = None;

    if let Some(oxc_ast::ast::Argument::ObjectExpression(obj)) = call_expr.arguments.first() {
        args_span = Some(obj.span);
        for prop in &obj.properties {
            if let ObjectPropertyKind::ObjectProperty(p) = prop {
                if let Some(key_name) = extract_property_key(&p.key) {
                    match key_name.as_ref() {
                        "name" => {
                            name_span = Some(p.value.span());
                            name = extract_string(&p.value, semantic);
                        }
                        "pure" => {
                            pure_span = Some(p.value.span());
                            pure = extract_bool(&p.value, semantic);
                        }
                        "standalone" => {
                            standalone_span = Some(p.value.span());
                            standalone = extract_bool(&p.value, semantic);
                        }
                        _ => {}
                    }
                }
            }
        }
    }

    Some(PipeData {
        name,
        name_span,
        pure,
        pure_span,
        standalone,
        standalone_span,
        args_span,
        injectable: None,
        service: None,
        declaring_ng_module: None,
        decorator_name,
    })
}
