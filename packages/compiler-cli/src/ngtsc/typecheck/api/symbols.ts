/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {TmplAstElement, TmplAstReference, TmplAstTemplate, TmplAstVariable} from '@angular/compiler';
import * as ts from 'typescript';

import {AbsoluteFsPath} from '../../file_system';

export enum SymbolKind {
  Input = 'Input',
  Output = 'Output',
  Reference = 'Reference',
  Variable = 'Variable',
  Directive = 'Directive',
  Element = 'Element',
  Template = 'Template',
  Expression = 'Expression',
}

/**
 * A representation of an entity in the `TemplateAst`.
 */
export type Symbol = InputBindingSymbol|OutputBindingSymbol|ElementSymbol|ReferenceSymbol|
    VariableSymbol|ExpressionSymbol|DirectiveSymbol|TemplateSymbol;

/**
 * A collection of information known by the compiler-cli type checker for an entity in the
 * `TemplateAst`.
 */
export interface BaseTemplateSymbol {
  /** The `ts.Type` of the entity */
  tsType: ts.Type;

  /**
   * The `ts.Symbol` of the entity.
   * Not all `TemplateSymbol`s will have a `ts.Symbol`. For example, the `AST` expression
   * `{{foo.bar + foo.baz}}` does not have a `ts.Symbol` but `foo.bar` and `foo.baz` both do.
   * Input And Output bindings may also not have a `ts.Symbol` if none of the matched
   * directives declare the input as a member.
   */
  tsSymbol: ts.Symbol|null;

  /**
   * The fully qualified path of the file which contains the generated TypeScript type check
   * code for the component's template.
   */
  shimPath: AbsoluteFsPath;

  /** The location in the shim file where this Symbol appears. */
  positionInShimFile: number;
}

/**
 * A representation of an input binding in a component template.
 */
export interface InputBindingSymbol extends BaseTemplateSymbol {
  kind: SymbolKind.Input;

  /**
   * The Component and/or Directives which this input is bound to. Note that a single input can
   * bind to more than one directive.
   */
  directives: DirectiveSymbol[];
}

/**
 * A representation of an output binding in a component template.
 */
export interface OutputBindingSymbol extends BaseTemplateSymbol {
  kind: SymbolKind.Output;

  /**
   * The Component and/or Directives which this output is bound to. Note that a single output can
   * bind to more than one directive.
   */
  directives: DirectiveSymbol[];
}

/**
 * A representation of a local reference or context variable in a component template.
 */
export interface ReferenceSymbol extends BaseTemplateSymbol {
  kind: SymbolKind.Reference;

  /**
   * Depending on the type of the reference, this is one of the following:
   *  - `TmplAstElement` when the local ref refers to the HTML element
   *  - `ts.ClassDeclaration` when the local ref refers to a Directive instance (#ref="myExportAs")
   */
  target: TmplAstElement|TmplAstTemplate|ts.ClassDeclaration;

  /**
   * The node in the `TemplateAst` where the symbol is declared. For references, this may be a
   * different node than the one used to make the request. For example, requesting a symbol for the
   * expression that uses a local ref will have the `#ref` node as the declaration.
   */
  declaration: TmplAstReference;
}

/**
 * A representation of a local reference or context variable in a component template.
 */
export interface VariableSymbol extends BaseTemplateSymbol {
  kind: SymbolKind.Variable;

  /**
   * The node in the `TemplateAst` where the variable is declared. For variables, this may be a
   * different node than the one used to make the request. For example, requesting a symbol for the
   * expression that uses a var will have the `let-` node as the declaration.
   */
  declaration: TmplAstVariable;
}

/**
 * A representation of an element or `ng-template` in a component template.
 */
export interface ElementSymbol extends BaseTemplateSymbol {
  kind: SymbolKind.Element;

  /** A list of directives applied to the element. */
  directives: DirectiveSymbol[];
}

export interface TemplateSymbol {
  kind: SymbolKind.Template;

  /** A list of directives applied to the element. */
  directives: DirectiveSymbol[];
}

/**
 * A representation of an expression in a component template.
 */
export interface ExpressionSymbol extends BaseTemplateSymbol {
  kind: SymbolKind.Expression;
}

/**
 * A representation of a directive that matches an element in a component template.
 */
export interface DirectiveSymbol extends BaseTemplateSymbol {
  kind: SymbolKind.Directive;

  /** Directives must have an associated `ts.Symbol`. */
  tsSymbol: ts.Symbol;
}
