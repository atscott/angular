/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {AbsoluteSourceSpan, AST, ASTWithSource, BindingPipe, ParseSourceSpan, SafeMethodCall, SafePropertyRead, TmplAstBoundAttribute, TmplAstBoundEvent, TmplAstElement, TmplAstNode, TmplAstTemplate} from '@angular/compiler';
import * as ts from 'typescript';

import {AbsoluteFsPath} from '../../file_system';
import {DirectiveSymbol, ElementSymbol, ExpressionSymbol, InputBindingSymbol, OutputBindingSymbol, Symbol, SymbolKind, TemplateSymbol} from '../api';

import {TemplateData} from './context';
import {ExpressionIdentifiers, hasExpressionIdentifier, readSpanComment} from './diagnostics';
import {TcbDirectiveOutputsOp} from './type_check_block';

/**
 * Given a `ts.Node` with source span comments, finds the first node whose source span comment
 * matches the given `sourceSpan`. Additionally, the `filter` function allows matching only
 * `ts.Nodes` of a given type, which provides the ability to select only matches of a given type
 * when there may be more than one.
 *
 * Returns `null` when no `ts.Node` matches the given conditions.
 */
function findFirstNodeWithAbsoluteSourceSpan<T extends ts.Node>(
    tcb: ts.Node, sourceSpan: AbsoluteSourceSpan, filter: (node: ts.Node) => node is T): T|null {
  function visitor(node: ts.Node): T|undefined {
    const comment = readSpanComment(tcb.getSourceFile(), node);
    if (sourceSpan.start === comment?.start && sourceSpan.end === comment?.end && filter(node)) {
      return node;
    }
    return node.forEachChild(visitor);
  }
  return tcb.forEachChild(visitor) ?? null;
}

/**
 * Given a `ts.Node` with source span comments, finds the first node whose source span comment
 * matches the given `sourceSpan`. Additionally, the `filter` function allows matching only
 * `ts.Nodes` of a given type, which provides the ability to select only matches of a given type
 * when there may be more than one.
 *
 * Returns `null` when no `ts.Node` matches the given conditions.
 */
function findAllNodesWithAbsoluteSourceSpan<T extends ts.Node>(
    tcb: ts.Node, sourceSpan: AbsoluteSourceSpan, filter: (node: ts.Node) => node is T): T[] {
  const results: T[] = [];
  function visitor(node: ts.Node|undefined, unprocessedNodes: ts.Node[]): T[] {
    if (node === undefined) {
      return results;
    }

    const comment = readSpanComment(tcb.getSourceFile(), node);
    if (sourceSpan.start === comment?.start && sourceSpan.end === comment?.end && filter(node)) {
      results.push(node);
    }

    unprocessedNodes.push(...node.getChildren());
    return visitor(unprocessedNodes.pop(), unprocessedNodes);
  }
  return visitor(tcb, []);
}

/** Converts a `ParseSourceSpan` to an `AbsoluteSourceSpan`. */
function toAbsoluteSourceSpan(sourceSpan: ParseSourceSpan): AbsoluteSourceSpan {
  return new AbsoluteSourceSpan(sourceSpan.start.offset, sourceSpan.end.offset);
}

/**
 * A class which extracts information from a type check block.
 * This class is essentially used as just a closure around the constructor parameters.
 */
export class SymbolBuilder {
  constructor(
      readonly typeChecker: ts.TypeChecker, readonly shimPath: AbsoluteFsPath,
      readonly typeCheckBlock: ts.Node, readonly templateData: TemplateData) {}

  getSymbol(node: AST|TmplAstNode): Symbol|null {
    if (node instanceof TmplAstBoundAttribute || node instanceof TmplAstBoundEvent) {
      return this.getSymbolOfBinding(node);
    } else if (node instanceof TmplAstElement) {
      return this.getSymbolOfElement(node);
    } else if (node instanceof TmplAstTemplate) {
      return this.getSymbolOfAstTemplate(node);
    } else if (node instanceof AST) {
      return this.getSymbolOfTemplateExpression(node);
    }
    // TODO(atscott): TmplAstContent, TmplAstIcu
    return null;
  }

  private getSymbolOfAstTemplate(template: TmplAstTemplate): TemplateSymbol|null {
    const directives = this.getDirectivesOfNode(template);
    return {kind: SymbolKind.Template, directives};
  }

  private getSymbolOfElement(element: TmplAstElement): ElementSymbol|null {
    const elementSourceSpan = element.startSourceSpan ?? element.sourceSpan;

    const node = findFirstNodeWithAbsoluteSourceSpan(
        this.typeCheckBlock, toAbsoluteSourceSpan(elementSourceSpan), ts.isVariableDeclaration);
    if (node === null) {
      return null;
    }

    const symbolFromDeclaration = this.getSymbolOfVariableDeclaration(node);
    if (symbolFromDeclaration === null || symbolFromDeclaration.tsSymbol === null) {
      return null;
    }

    const directives = this.getDirectivesOfNode(element);
    return {
      ...symbolFromDeclaration,
      tsSymbol: symbolFromDeclaration.tsSymbol!,
      kind: SymbolKind.Element,
      directives
    };
  }

  private getDirectivesOfNode(element: TmplAstElement|TmplAstTemplate): DirectiveSymbol[] {
    const elementSourceSpan = element.startSourceSpan ?? element.sourceSpan;
    const isDirectiveDeclaration = (node: ts.Node): node is ts.TypeNode => ts.isTypeNode(node) &&
        hasExpressionIdentifier(this.typeCheckBlock.getSourceFile(), node,
                                ExpressionIdentifiers.DIRECTIVE);

    return findAllNodesWithAbsoluteSourceSpan(
               this.typeCheckBlock, toAbsoluteSourceSpan(elementSourceSpan), isDirectiveDeclaration)
        .map(
            (node):
                DirectiveSymbol|null => {
                  const symbol = this.getSymbolOfTsNode(node);
                  if (symbol === null || symbol.tsSymbol === null) {
                    return null;
                  }
                  return {...symbol, tsSymbol: symbol.tsSymbol, kind: SymbolKind.Directive};
                })
        .filter((d): d is DirectiveSymbol => d !== null);
  }

  /**
   * While the signature for this method allows for multiple `Symbol`s to be returned, the
   * current implementation only returns the first match.
   */
  private getSymbolOfBinding(binding: TmplAstBoundAttribute|TmplAstBoundEvent): InputBindingSymbol
      |OutputBindingSymbol|null {
    // TODO(atscott): These methods only retrieve the first matched directive. They should return
    // all directives that the input/output binds to.
    return binding instanceof TmplAstBoundAttribute ? this.getSymbolOfInputBinding(binding) :
                                                      this.getSymbolOfBoundEvent(binding);
  }

  private getSymbolOfBoundEvent(eventBinding: TmplAstBoundEvent): OutputBindingSymbol|null {
    // Outputs are a `CallExpression` that look like one of the two:
    // * _outputHelper(_t1["outputField"]).subscribe(handler);
    // * _t1.addEventListener(handler);
    const node = findFirstNodeWithAbsoluteSourceSpan(
        this.typeCheckBlock, toAbsoluteSourceSpan(eventBinding.sourceSpan), ts.isCallExpression);
    if (node === null) {
      return null;
    }

    const outputFieldAccess = TcbDirectiveOutputsOp.decodeOutputCallExpression(node);
    if (outputFieldAccess === null) {
      return null;
    }

    const symbol =
        this.typeChecker.getSymbolAtLocation(outputFieldAccess.argumentExpression) ?? null;
    if (symbol === null) {
      return null;
    }

    const positionInShimFile = outputFieldAccess.argumentExpression.getStart();
    const directive = this.getDirectiveSymbolForAccessExpression(outputFieldAccess);
    const type = this.typeChecker.getTypeAtLocation(node);
    return {
      kind: SymbolKind.Output,
      tsSymbol: symbol,
      tsType: type,
      directives: directive !== null ? [directive] : [],
      shimPath: this.shimPath,
      positionInShimFile
    };
  }

  private getSymbolOfInputBinding(attributeBinding: TmplAstBoundAttribute): InputBindingSymbol
      |null {
    const node = findFirstNodeWithAbsoluteSourceSpan(
        this.typeCheckBlock, toAbsoluteSourceSpan(attributeBinding.sourceSpan),
        ts.isBinaryExpression);
    if (node === null) {
      return null;
    }

    let symbol: ts.Symbol|null = null;
    let positionInShimFile: number|null = null;
    if (ts.isElementAccessExpression(node.left)) {
      symbol = this.typeChecker.getSymbolAtLocation(node.left.argumentExpression) ?? null;
      positionInShimFile = node.left.argumentExpression.getStart();
    } else if (ts.isPropertyAccessExpression(node.left)) {
      symbol = this.typeChecker.getSymbolAtLocation(node.left.name) ?? null;
      positionInShimFile = node.left.name.getStart();
    } else {
      return null;
    }
    if (symbol === null) {
      return null;
    }

    const directive = this.getDirectiveSymbolForAccessExpression(node.left);
    const type = this.typeChecker.getTypeOfSymbolAtLocation(symbol, node);
    return {
      kind: SymbolKind.Input,
      tsSymbol: symbol,
      tsType: type,
      directives: directive !== null ? [directive] : [],
      shimPath: this.shimPath,
      positionInShimFile
    };
  }

  private getDirectiveSymbolForAccessExpression(node: ts.ElementAccessExpression|
                                                ts.PropertyAccessExpression): DirectiveSymbol|null {
    // In either case, `_t1["index"]` or `_t1.index`, `node.expression` is _t1.
    // The retrieved symbol for _t1 will be the variable declaration.
    const declaration = this.typeChecker.getSymbolAtLocation(node.expression)?.declarations[0];
    if (declaration === undefined || !ts.isVariableDeclaration(declaration)) {
      return null;
    }

    const templateSymbol = this.getSymbolOfVariableDeclaration(declaration);
    if (templateSymbol === null || templateSymbol.tsSymbol === null) {
      return null;
    }

    return {...templateSymbol, kind: SymbolKind.Directive, tsSymbol: templateSymbol.tsSymbol};
  }

  private getSymbolOfTemplateExpression(expression: AST): ExpressionSymbol|null {
    if (expression instanceof ASTWithSource) {
      return this.getSymbolOfTemplateExpression(expression.ast);
    }

    const node = this.getTsNodeWithSourceSpan(expression.sourceSpan);
    if (node === null) {
      return null;
    }

    // - If we have safe property read ("a?.b") we want to get the Symbol for b, the `whenTrue`
    // expression.
    // - If our expression is a pipe binding ("a | test:b:c"), we want the Symbol for the
    // `transform` on the pipe.
    // - Otherwise, we retrieve the symbol for the node itself with no special considerations
    if ((expression instanceof SafePropertyRead || expression instanceof SafeMethodCall) &&
        ts.isConditionalExpression(node)) {
      const whenTrueSymbol =
          (expression instanceof SafeMethodCall && ts.isCallExpression(node.whenTrue)) ?
          this.getSymbolOfTsNode(node.whenTrue.expression) :
          this.getSymbolOfTsNode(node.whenTrue);
      return whenTrueSymbol !== null ?
          // Rather than using the type of only the `whenTrue` part of the expression, we should
          // still get the type of the whole conditional expression.
          {...whenTrueSymbol, tsType: this.typeChecker.getTypeAtLocation(node)} :
          null;
    } else if (expression instanceof BindingPipe && ts.isCallExpression(node)) {
      return this.getSymbolOfTsNode(node.expression);
    } else {
      return this.getSymbolOfTsNode(node);
    }
  }

  private getSymbolOfTsNode(node: ts.Node): ExpressionSymbol|null {
    if (ts.isParenthesizedExpression(node)) {
      return this.getSymbolOfTsNode(node.expression);
    }

    let symbol: ts.Symbol|null;
    let positionInShimFile: number;
    if (ts.isPropertyAccessExpression(node)) {
      symbol = this.typeChecker.getSymbolAtLocation(node.name) ?? null;
      positionInShimFile = node.name.getStart();
    } else {
      symbol = this.typeChecker.getSymbolAtLocation(node) ?? null;
      positionInShimFile = node.getStart();
    }

    if (symbol !== null) {
      const [declarationNode] = symbol.declarations;
      if (ts.isVariableDeclaration(declarationNode)) {
        return this.getSymbolOfVariableDeclaration(declarationNode);
      }
    }

    const type = this.typeChecker.getTypeAtLocation(node);
    // If we could not find a symbol, fall back to the symbol on the type for the node.
    // Some nodes won't have a "symbol at location" but will have a symbol for the type.
    // One example of this would be literals.
    symbol = symbol ?? type.symbol ?? null;
    return {
      kind: SymbolKind.Expression,
      tsSymbol: symbol,
      tsType: type,
      shimPath: this.shimPath,
      positionInShimFile
    };
  }

  private getSymbolOfVariableDeclaration(declaration: ts.VariableDeclaration): ExpressionSymbol
      |null {
    // Instead of returning the Symbol for the temporary variable, we want to get the `ts.Symbol`
    // for:
    // - The type reference for `var _t2: MyDir = xyz` (prioritize/trust the declared type)
    // - The initializer for `var _t2 = _t1.index`.
    if (declaration.type && ts.isTypeReferenceNode(declaration.type)) {
      return this.getSymbolOfTsNode(declaration.type.typeName);
    } else if (declaration.initializer) {
      const templateSymbol = this.getSymbolOfTsNode(declaration.initializer);
      if (templateSymbol === null) {
        return null;
      }

      const initializerHasTsSymbol =
          this.typeChecker.getSymbolAtLocation(declaration.initializer) !== undefined;
      // If we cannot get a Symbol for the initializer itself, that means it is a type constructor
      // (`var _t1 = _ctor1({...})`) or some other TCB synthetic initializer (type ctor is the only
      // one right now). Instead of using the position of the initializer, point to the variable
      // itself.
      return initializerHasTsSymbol ?
          templateSymbol :
          {...templateSymbol, positionInShimFile: declaration.name.getStart()};
    }

    return null;
  }

  private getTsNodeWithSourceSpan(sourceSpan: AbsoluteSourceSpan): ts.Node|null {
    let node = findFirstNodeWithAbsoluteSourceSpan(
        this.typeCheckBlock, sourceSpan, (n: ts.Node): n is ts.Node => true);
    if (node === null) {
      return null;
    }

    return ts.isParenthesizedExpression(node) ? node.expression : node;
  }
}
