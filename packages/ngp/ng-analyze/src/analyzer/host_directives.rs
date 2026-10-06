use oxc_ast::ast::{Expression, ObjectPropertyKind};
use oxc_semantic::Semantic;

use crate::{HostDirectiveBinding, HostDirectiveMetadata};

use super::utils::{
    extract_property_key, is_forward_reference, resolve_local_expression,
    unwrap_forward_ref_evaluated,
};

// TODO(parity): upstream evaluates `hostDirectives` with the partial evaluator plus
// `createForwardRefResolver`, not syntactically like this extractor. The wrapper sets now agree,
// but upstream additionally resolves value aliases (`const fref = forwardRef;` and its cross-file
// re-export), which we drop, and raises NG1010 where we silently drop the host directive. Closing
// both means routing this extractor through the evaluator.
// https://github.com/angular/angular/blob/96b80424c7/packages/compiler-cli/src/ngtsc/annotations/directive/src/shared.ts#L406-L417
pub fn extract_host_directives<'a>(
    expr: &'a Expression<'a>,
    semantic: &Semantic<'a>,
) -> Vec<HostDirectiveMetadata> {
    let mut directives = Vec::new();

    let resolved = resolve_local_expression(expr, semantic);
    let array = match resolved {
        Expression::ArrayExpression(a) => a,
        _ => return directives,
    };

    for element in &array.elements {
        let Some(expr) = element.as_expression() else {
            continue;
        };

        let is_fwd = is_forward_reference(expr, semantic);
        let unwrapped = unwrap_forward_ref_evaluated(expr, semantic).unwrap_or(expr);
        let resolved_element = resolve_local_expression(unwrapped, semantic);

        match resolved_element {
            Expression::Identifier(i) => {
                directives.push(HostDirectiveMetadata {
                    directive: i.name.to_string(),
                    module_specifier: None,
                    inputs: None,
                    outputs: None,
                    is_forward_ref: is_fwd,
                });
            }
            Expression::ObjectExpression(obj) => {
                let mut directive_name = String::new();
                let mut inputs = None;
                let mut outputs = None;
                let mut is_forward_ref = is_fwd;

                for prop in &obj.properties {
                    if let ObjectPropertyKind::ObjectProperty(p) = prop {
                        if let Some(key_name) = extract_property_key(&p.key) {
                            match key_name.as_ref() {
                                "directive" => {
                                    let is_dir_fwd = is_forward_reference(&p.value, semantic);
                                    let unwrapped_dir =
                                        unwrap_forward_ref_evaluated(&p.value, semantic)
                                            .unwrap_or(&p.value);
                                    let resolved_dir =
                                        resolve_local_expression(unwrapped_dir, semantic);
                                    is_forward_ref = is_forward_ref
                                        || is_dir_fwd
                                        || is_forward_reference(unwrapped_dir, semantic);

                                    match resolved_dir {
                                        Expression::Identifier(i) => {
                                            directive_name = i.name.to_string();
                                        }
                                        Expression::StaticMemberExpression(m) => {
                                            if let Expression::Identifier(obj_id) = &m.object {
                                                directive_name =
                                                    format!("{}.{}", obj_id.name, m.property.name);
                                            } else {
                                                directive_name = m.property.name.to_string();
                                            }
                                        }
                                        _ => {}
                                    }
                                }
                                "inputs" => inputs = extract_map(&p.value, semantic),
                                "outputs" => outputs = extract_map(&p.value, semantic),
                                _ => {}
                            }
                        }
                    }
                }

                if !directive_name.is_empty() {
                    directives.push(HostDirectiveMetadata {
                        directive: directive_name,
                        module_specifier: None,
                        inputs,
                        outputs,
                        is_forward_ref,
                    });
                }
            }
            _ => {
                // Ignore other expressions
            }
        }
    }

    directives
}

fn extract_map<'a>(
    expr: &'a Expression<'a>,
    semantic: &Semantic<'a>,
) -> Option<Vec<HostDirectiveBinding>> {
    let resolved = resolve_local_expression(expr, semantic);
    let array = match resolved {
        Expression::ArrayExpression(a) => a,
        _ => return None,
    };

    let mut list = Vec::new();

    for element in &array.elements {
        let Some(expr) = element.as_expression() else {
            continue;
        };

        let resolved_elem = resolve_local_expression(expr, semantic);
        if let Expression::StringLiteral(s) = resolved_elem {
            let val = s.value.as_str();
            let mut parts = val.splitn(2, ':');
            let first = parts.next().unwrap_or("").trim();
            let second = parts.next().map(|s| s.trim()).unwrap_or(first);
            if !first.is_empty() {
                list.push(HostDirectiveBinding {
                    public_name: first.to_string(),
                    binding_name: second.to_string(),
                });
            }
        }
    }

    if list.is_empty() {
        None
    } else {
        Some(list)
    }
}
