/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import {
  AST,
  TmplAstBlockNode,
  TmplAstBoundAttribute,
  TmplAstDeferredTrigger,
  TmplAstNode,
  TmplAstTextAttribute,
} from '@angular/compiler';
import {NgCompiler} from '@angular/compiler-cli/src/ngtsc/core';
import {Symbol, SymbolKind} from '@angular/compiler-cli/src/ngtsc/typecheck/api';
import ts from 'typescript';

import {
  createDollarAnyQuickInfo,
  createNgTemplateQuickInfo,
  createQuickInfoForBuiltIn,
  isDollarAny,
} from './quick_info_built_ins';
import {TemplateTarget} from './template_target';
import {createQuickInfo} from './utils';

import {QuickInfoImpl} from './quick_info_adapter';
import {LSRequestAdapter, SyncOrAsync} from './types';

export class QuickInfoBuilder implements LSRequestAdapter {
  private readonly typeChecker: ts.TypeChecker;
  private readonly parent: TmplAstNode | AST | null;
  private readonly impl: QuickInfoImpl;

  constructor(
    private readonly tsLS: ts.LanguageService,
    private readonly compiler: NgCompiler,
    private readonly component: ts.ClassDeclaration,
    private node: TmplAstNode | AST,
    private readonly positionDetails: TemplateTarget,
  ) {
    this.typeChecker = this.compiler.getCurrentProgram().getTypeChecker();
    this.parent = this.positionDetails.parent;
    this.impl = new QuickInfoImpl(this.typeChecker, this, this.node);
  }

  get(): ts.QuickInfo | undefined {
    if (this.node instanceof TmplAstDeferredTrigger || this.node instanceof TmplAstBlockNode) {
      return createQuickInfoForBuiltIn(this.node, this.positionDetails.position);
    }

    const symbol = this.compiler
      .getTemplateTypeChecker()
      .getSymbolOfNode(this.node, this.component);
    if (symbol !== null) {
      return this.impl.getQuickInfoForSymbol(symbol) as ts.QuickInfo | undefined;
    }

    if (isDollarAny(this.node)) {
      return createDollarAnyQuickInfo(this.node);
    }

    // If the cursor lands on the receiver of a method call, we have to look
    // at the entire call in order to figure out if it's a call to `$any`.
    if (this.parent !== null && isDollarAny(this.parent) && this.parent.receiver === this.node) {
      return createDollarAnyQuickInfo(this.parent);
    }

    return undefined;
  }

  getQuickInfoAtPosition(
    fileName: string,
    position: number,
  ): SyncOrAsync<ts.QuickInfo | undefined> {
    return this.tsLS.getQuickInfoAtPosition(fileName, position);
  }

  getTypeDefinitionAtPosition(
    fileName: string,
    position: number,
  ): SyncOrAsync<readonly ts.DefinitionInfo[] | undefined> {
    return this.tsLS.getTypeDefinitionAtPosition(fileName, position);
  }
}
