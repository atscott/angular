import {TmplAstBlockNode, TmplAstDeferredTrigger} from '@angular/compiler';
import {NgCompiler} from '@angular/compiler-cli/src/ngtsc/core';
import {
  getFileSystem,
  InvalidFileSystem,
  NodeJSFileSystem,
  setFileSystem,
} from '@angular/compiler-cli/src/ngtsc/file_system';
import {
  InputBindingSymbol,
  OutputBindingSymbol,
  Symbol as NgSymbol,
  SymbolKind,
  TcbLocation,
} from '@angular/compiler-cli/src/ngtsc/typecheck/api';
import ts from 'typescript';

import {
  createDollarAnyQuickInfo,
  createNgTemplateQuickInfo,
  createQuickInfoForBuiltIn,
  isDollarAny,
} from './src/quick_info_built_ins';
import {getTargetAtPosition, TargetNodeKind} from './src/template_target';
import {getTypeCheckInfoAtPosition, getTextSpanOfNode, createQuickInfo} from './src/utils';
import {DisplayInfoKind, createDisplayParts} from './src/utils/display_parts';

import {NgtscIsolatedPreprocessor} from '@angular/compiler-cli/src/ngtsc/preprocessor';

export class NgIsolatedLanguageService {
  private readonly preprocessor: NgtscIsolatedPreprocessor;

  constructor(
    rootNames: string[],
    options: ts.CompilerOptions,
    host: ts.CompilerHost,
    old?: NgIsolatedLanguageService,
  ) {
    if (getFileSystem() instanceof InvalidFileSystem) {
      setFileSystem(new NodeJSFileSystem());
    }
    this.preprocessor = new NgtscIsolatedPreprocessor(rootNames, options, host, old?.preprocessor);
  }

  get compiler(): NgCompiler {
    return this.preprocessor.compiler;
  }

  async analyze(): Promise<void> {
    return this.preprocessor.analyze();
  }

  transformAndPrint(): Array<{fileName: string; content: string}> {
    return this.preprocessor.transformAndPrint();
  }

  async getQuickInfoAtPosition(
    fileName: string,
    position: number,
    lsHandler: (fileName: string, position: number) => Promise<ts.QuickInfo | undefined>,
  ): Promise<ts.QuickInfo | undefined> {
    if (!this.isInTypeCheckContext(fileName, position)) {
      return undefined;
    }

    const typeCheckInfo = getTypeCheckInfoAtPosition(fileName, position, this.compiler);
    if (typeCheckInfo === undefined) {
      return undefined;
    }
    const positionDetails = getTargetAtPosition(typeCheckInfo.nodes, position);
    if (positionDetails === null) {
      return undefined;
    }

    const node =
      positionDetails.context.kind === TargetNodeKind.TwoWayBindingContext
        ? positionDetails.context.nodes[0]
        : positionDetails.context.node;

    // Built-ins (defer blocks, etc)
    if (node instanceof TmplAstDeferredTrigger || node instanceof TmplAstBlockNode) {
      return createQuickInfoForBuiltIn(node, positionDetails.position);
    }

    const symbol = this.compiler
      .getTemplateTypeChecker()
      .getSymbolOfNode(node, typeCheckInfo.declaration);

    if (symbol !== null) {
      const resp = await this.getQuickInfoForSymbol(symbol, lsHandler);
      if (resp) return resp;
    }

    if (isDollarAny(node)) {
      return createDollarAnyQuickInfo(node);
    }

    return undefined;
  }

  private async getQuickInfoForSymbol(
    symbol: NgSymbol,
    lsHandler: (fileName: string, position: number) => Promise<ts.QuickInfo | undefined>,
  ): Promise<ts.QuickInfo | undefined> {
    switch (symbol.kind) {
      case SymbolKind.Input:
      case SymbolKind.Output:
        return this.getQuickInfoForBindingSymbol(symbol, lsHandler);
      case SymbolKind.Template:
        return createNgTemplateQuickInfo(symbol.templateNode);
      case SymbolKind.Element:
        // Element symbols often map to directives or just matching the tag
        // If it maps to a directive, we should have gotten a Directive symbol?
        // No, ElementSymbol has `directives`.
        // Simplified: return element info.
        return createQuickInfo(
          symbol.templateNode.name,
          DisplayInfoKind.ELEMENT,
          getTextSpanOfNode(symbol.templateNode),
          undefined,
          'any', // TODO: Type of element?
        );
      case SymbolKind.Variable:
      case SymbolKind.LetDeclaration:
      case SymbolKind.Reference:
        // These map to TCB locations usually
        // For simplicity, delegating if location exists
        if ((symbol as any).initializerLocation) {
          return lsHandler(
            (symbol as any).initializerLocation.tcbPath,
            (symbol as any).initializerLocation.positionInFile,
          );
        }
        if ((symbol as any).targetLocation) {
          return lsHandler(
            (symbol as any).targetLocation.tcbPath,
            (symbol as any).targetLocation.positionInFile,
          );
        }
        return undefined;
      case SymbolKind.Pipe:
      case SymbolKind.Expression:
      case SymbolKind.Directive:
        if (symbol.tcbLocation) {
          return lsHandler(symbol.tcbLocation.tcbPath, symbol.tcbLocation.positionInFile);
        }
        return undefined;
      default:
        return undefined;
    }
  }

  private async getQuickInfoForBindingSymbol(
    symbol: InputBindingSymbol | OutputBindingSymbol,
    lsHandler: (fileName: string, position: number) => Promise<ts.QuickInfo | undefined>,
  ): Promise<ts.QuickInfo | undefined> {
    if (symbol.bindings.length === 0) {
      return undefined;
    }
    const tcbLocation = symbol.bindings[0].tcbLocation;
    const quickInfo = await lsHandler(tcbLocation.tcbPath, tcbLocation.positionInFile);
    if (!quickInfo) return undefined;

    // TODO: Update kind (Property/Event)
    return quickInfo;
  }

  private isInTypeCheckContext(fileName: string, position: number): boolean {
    return true;
  }
}
