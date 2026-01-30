import {TmplAstBlockNode, TmplAstDeferredTrigger} from '@angular/compiler';
import {NgCompiler} from '@angular/compiler-cli/src/ngtsc/core';
import {
  getFileSystem,
  InvalidFileSystem,
  NodeJSFileSystem,
  setFileSystem,
} from '@angular/compiler-cli/src/ngtsc/file_system';
import {Symbol as NgSymbol} from '@angular/compiler-cli/src/ngtsc/typecheck/api';
import ts from 'typescript';

import {
  createDollarAnyQuickInfo,
  createQuickInfoForBuiltIn,
  isDollarAny,
} from './src/quick_info_built_ins';
import {getTargetAtPosition, TargetNodeKind} from './src/template_target';
import {getTypeCheckInfoAtPosition} from './src/utils';
import {QuickInfoImpl} from './src/quick_info_adapter';
import {LSRequestAdapter, SyncOrAsync} from './src/types';
export {LSRequestAdapter, SyncOrAsync} from './src/types';

import {NgtscIsolatedPreprocessor} from '@angular/compiler-cli/src/ngtsc/preprocessor';

export class NgIsolatedLanguageService {
  private readonly preprocessor: NgtscIsolatedPreprocessor;

  constructor(
    rootNames: readonly string[],
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
    lsHandler: LSRequestAdapter,
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

    const builder = new QuickInfoImpl(
      this.compiler.getCurrentProgram().getTypeChecker(),
      lsHandler,
      node,
    );

    // Built-ins (defer blocks, etc)
    if (node instanceof TmplAstDeferredTrigger || node instanceof TmplAstBlockNode) {
      return createQuickInfoForBuiltIn(node, positionDetails.position);
    }

    const symbol = this.compiler
      .getTemplateTypeChecker()
      .getSymbolOfNode(node, typeCheckInfo.declaration);

    if (symbol !== null) {
      return await builder.getQuickInfoForSymbol(symbol);
    }

    if (isDollarAny(node)) {
      return createDollarAnyQuickInfo(node);
    }

    return undefined;
  }

  private isInTypeCheckContext(fileName: string, position: number): boolean {
    return true;
  }
}
