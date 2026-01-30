/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {TmplAstNode, AST, TmplAstTextAttribute, TmplAstBoundAttribute} from '@angular/compiler';
import {
  Symbol,
  SymbolKind,
  InputBindingSymbol,
  OutputBindingSymbol,
  ElementSymbol,
  DirectiveSymbol,
  VariableSymbol,
  LetDeclarationSymbol,
  ReferenceSymbol,
  PipeSymbol,
  DomBindingSymbol,
  SelectorlessComponentSymbol,
  SelectorlessDirectiveSymbol,
} from '@angular/compiler-cli/src/ngtsc/typecheck/api';
import ts from 'typescript';

import {createNgTemplateQuickInfo} from './quick_info_built_ins';
import {
  createQuickInfo,
  getTextSpanOfNode,
  getDirectiveMatchesForElementTag,
  getDirectiveMatchesForAttribute,
  filterAliasImports,
} from './utils';
import {DisplayInfoKind, SYMBOL_PUNC, SYMBOL_SPACE, SYMBOL_TEXT} from './utils/display_parts';
import {LSRequestAdapter, SyncOrAsync} from './types';

export function apply<T, R>(val: SyncOrAsync<T>, fn: (val: T) => SyncOrAsync<R>): SyncOrAsync<R> {
  if (val instanceof Promise) {
    return val.then(fn);
  }
  return fn(val);
}

export class QuickInfoImpl {
  constructor(
    private readonly typeChecker: ts.TypeChecker,
    private readonly adapter: LSRequestAdapter,
    private readonly node: TmplAstNode | AST,
  ) {}

  getQuickInfoForSymbol(symbol: Symbol): SyncOrAsync<ts.QuickInfo | undefined> {
    switch (symbol.kind) {
      case SymbolKind.Input:
      case SymbolKind.Output:
        return this.getQuickInfoForBindingSymbol(symbol);
      case SymbolKind.Template:
        return createNgTemplateQuickInfo(this.node);
      case SymbolKind.Element:
        return this.getQuickInfoForElementSymbol(symbol);
      case SymbolKind.Variable:
        return this.getQuickInfoForVariableSymbol(symbol);
      case SymbolKind.LetDeclaration:
        return this.getQuickInfoForLetDeclarationSymbol(symbol);
      case SymbolKind.Reference:
        return this.getQuickInfoForReferenceSymbol(symbol);
      case SymbolKind.DomBinding:
        return this.getQuickInfoForDomBinding(symbol);
      case SymbolKind.Pipe:
        return this.getQuickInfoForPipeSymbol(symbol);
      case SymbolKind.SelectorlessComponent:
      case SymbolKind.SelectorlessDirective:
        return this.getQuickInfoForSelectorlessSymbol(symbol);
      case SymbolKind.Expression:
      case SymbolKind.Directive:
        return this.getQuickInfoAtTcbLocation(symbol.tcbLocation);
    }
  }

  private getQuickInfoForBindingSymbol(
    symbol: InputBindingSymbol | OutputBindingSymbol,
  ): SyncOrAsync<ts.QuickInfo | undefined> {
    if (symbol.bindings.length === 0) {
      return undefined;
    }

    const kind =
      symbol.kind === SymbolKind.Input ? DisplayInfoKind.PROPERTY : DisplayInfoKind.EVENT;

    return apply(this.getQuickInfoAtTcbLocation(symbol.bindings[0].tcbLocation), (quickInfo) =>
      quickInfo === undefined ? undefined : updateQuickInfoKind(quickInfo, kind),
    );
  }

  private getQuickInfoForElementSymbol(symbol: ElementSymbol): SyncOrAsync<ts.QuickInfo> {
    const {templateNode} = symbol;
    const matches = getDirectiveMatchesForElementTag(templateNode, symbol.directives);
    const directiveSymbol = matches.size > 0 ? matches.values().next().value : null;

    if (directiveSymbol) {
      return this.getQuickInfoForDirectiveSymbol(directiveSymbol, templateNode);
    }

    return createQuickInfo(
      templateNode.name,
      DisplayInfoKind.ELEMENT,
      getTextSpanOfNode(templateNode),
      undefined /* containerName */,
      this.typeChecker.typeToString(symbol.tsType),
    );
  }

  private getQuickInfoForVariableSymbol(symbol: VariableSymbol): SyncOrAsync<ts.QuickInfo> {
    return apply(this.getQuickInfoFromTypeDefAtLocation(symbol.initializerLocation), (info) =>
      createQuickInfo(
        symbol.declaration.name,
        DisplayInfoKind.VARIABLE,
        getTextSpanOfNode(this.node),
        undefined /* containerName */,
        this.typeChecker.typeToString(symbol.tsType),
        info?.documentation,
        info?.tags,
      ),
    );
  }

  private getQuickInfoForLetDeclarationSymbol(
    symbol: LetDeclarationSymbol,
  ): SyncOrAsync<ts.QuickInfo> {
    return apply(this.getQuickInfoFromTypeDefAtLocation(symbol.initializerLocation), (info) =>
      createQuickInfo(
        symbol.declaration.name,
        DisplayInfoKind.LET,
        getTextSpanOfNode(this.node),
        undefined /* containerName */,
        this.typeChecker.typeToString(symbol.tsType),
        info?.documentation,
        info?.tags,
      ),
    );
  }

  private getQuickInfoForReferenceSymbol(symbol: ReferenceSymbol): SyncOrAsync<ts.QuickInfo> {
    return apply(this.getQuickInfoFromTypeDefAtLocation(symbol.targetLocation), (info) =>
      createQuickInfo(
        symbol.declaration.name,
        DisplayInfoKind.REFERENCE,
        getTextSpanOfNode(this.node),
        undefined /* containerName */,
        this.typeChecker.typeToString(symbol.tsType),
        info?.documentation,
        info?.tags,
      ),
    );
  }

  private getQuickInfoForPipeSymbol(symbol: PipeSymbol): SyncOrAsync<ts.QuickInfo | undefined> {
    if (symbol.tsSymbol !== null) {
      return apply(this.getQuickInfoAtTcbLocation(symbol.tcbLocation), (quickInfo) =>
        quickInfo === undefined ? undefined : updateQuickInfoKind(quickInfo, DisplayInfoKind.PIPE),
      );
    } else {
      return createQuickInfo(
        this.typeChecker.typeToString(symbol.classSymbol.tsType),
        DisplayInfoKind.PIPE,
        getTextSpanOfNode(this.node),
      );
    }
  }

  private getQuickInfoForDomBinding(
    symbol: DomBindingSymbol,
  ): SyncOrAsync<ts.QuickInfo | undefined> {
    if (
      !(this.node instanceof TmplAstTextAttribute) &&
      !(this.node instanceof TmplAstBoundAttribute)
    ) {
      return undefined;
    }
    const directives = getDirectiveMatchesForAttribute(
      this.node.name,
      symbol.host.templateNode,
      symbol.host.directives,
    );

    const directiveSymbol = directives.size > 0 ? directives.values().next().value : null;
    return directiveSymbol ? this.getQuickInfoForDirectiveSymbol(directiveSymbol) : undefined;
  }

  private getQuickInfoForDirectiveSymbol(
    dir: DirectiveSymbol,
    node: TmplAstNode | AST = this.node,
  ): SyncOrAsync<ts.QuickInfo> {
    const kind = dir.isComponent ? DisplayInfoKind.COMPONENT : DisplayInfoKind.DIRECTIVE;
    return apply(this.getQuickInfoFromTypeDefAtLocation(dir.tcbLocation), (info) => {
      let containerName: string | undefined;
      if (ts.isClassDeclaration(dir.tsSymbol.valueDeclaration) && dir.ngModule !== null) {
        containerName = dir.ngModule.name.getText();
      }

      return createQuickInfo(
        this.typeChecker.typeToString(dir.tsType),
        kind,
        getTextSpanOfNode(this.node),
        containerName,
        undefined,
        info?.documentation,
        info?.tags,
      );
    });
  }

  private getQuickInfoForSelectorlessSymbol(
    symbol: SelectorlessComponentSymbol | SelectorlessDirectiveSymbol,
  ): SyncOrAsync<ts.QuickInfo> {
    const kind =
      symbol.kind === SymbolKind.SelectorlessComponent
        ? DisplayInfoKind.COMPONENT
        : DisplayInfoKind.DIRECTIVE;
    return apply(this.getQuickInfoFromTypeDefAtLocation(symbol.tcbLocation), (info) =>
      createQuickInfo(
        this.typeChecker.typeToString(symbol.tsType),
        kind,
        getTextSpanOfNode(this.node),
        undefined,
        undefined,
        info?.documentation,
        info?.tags,
      ),
    );
  }

  private getQuickInfoFromTypeDefAtLocation(tcbLocation: {
    tcbPath: string;
    positionInFile: number;
  }): SyncOrAsync<ts.QuickInfo | undefined> {
    return apply(
      this.adapter.getTypeDefinitionAtPosition(tcbLocation.tcbPath, tcbLocation.positionInFile),
      (typeDefs) => {
        if (typeDefs === undefined || typeDefs.length === 0) {
          return undefined;
        }
        return this.adapter.getQuickInfoAtPosition(
          typeDefs[0].fileName,
          typeDefs[0].textSpan.start,
        );
      },
    );
  }

  private getQuickInfoAtTcbLocation(location: {
    tcbPath: string;
    positionInFile: number;
  }): SyncOrAsync<ts.QuickInfo | undefined> {
    return apply(
      this.adapter.getQuickInfoAtPosition(location.tcbPath, location.positionInFile),
      (quickInfo) => {
        if (quickInfo === undefined || quickInfo.displayParts === undefined) {
          return quickInfo;
        }

        quickInfo.displayParts = filterAliasImports(quickInfo.displayParts);

        const textSpan = getTextSpanOfNode(this.node);
        return {...quickInfo, textSpan};
      },
    );
  }
}

function updateQuickInfoKind(quickInfo: ts.QuickInfo, kind: DisplayInfoKind): ts.QuickInfo {
  if (quickInfo.displayParts === undefined) {
    return quickInfo;
  }

  const startsWithKind =
    quickInfo.displayParts.length >= 3 &&
    displayPartsEqual(quickInfo.displayParts[0], {text: '(', kind: SYMBOL_PUNC}) &&
    quickInfo.displayParts[1].kind === SYMBOL_TEXT &&
    displayPartsEqual(quickInfo.displayParts[2], {text: ')', kind: SYMBOL_PUNC});
  if (startsWithKind) {
    quickInfo.displayParts[1].text = kind;
  } else {
    quickInfo.displayParts = [
      {text: '(', kind: SYMBOL_PUNC},
      {text: kind, kind: SYMBOL_TEXT},
      {text: ')', kind: SYMBOL_PUNC},
      {text: ' ', kind: SYMBOL_SPACE},
      ...quickInfo.displayParts,
    ];
  }
  return quickInfo;
}

function displayPartsEqual(a: {text: string; kind: string}, b: {text: string; kind: string}) {
  return a.text === b.text && a.kind === b.kind;
}
