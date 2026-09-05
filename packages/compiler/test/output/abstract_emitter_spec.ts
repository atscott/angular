/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  AbstractEmitterVisitor,
  EmitterVisitorContext,
  escapeIdentifier,
} from '../../src/output/abstract_emitter';
import * as o from '../../src/output/output_ast';

class TestEmitterVisitor extends AbstractEmitterVisitor {
  override visitExternalExpr(ast: o.ExternalExpr, ctx: EmitterVisitorContext): void {
    ctx.print(ast, ast.value.name || '');
  }
  override visitWrappedNodeExpr(
    ast: o.WrappedNodeExpr<unknown>,
    ctx: EmitterVisitorContext,
  ): void {}
}

describe('AbstractEmitter', () => {
  describe('escapeIdentifier', () => {
    it('should escape single quotes', () => {
      expect(escapeIdentifier(`'`)).toEqual(`'\\''`);
    });

    it('should escape backslash', () => {
      expect(escapeIdentifier('\\')).toEqual(`'\\\\'`);
    });

    it('should escape newlines', () => {
      expect(escapeIdentifier('\n')).toEqual(`'\\n'`);
    });

    it('should escape carriage returns', () => {
      expect(escapeIdentifier('\r')).toEqual(`'\\r'`);
    });

    it('should add quotes for non-identifiers', () => {
      expect(escapeIdentifier('==', false)).toEqual(`'=='`);
    });
    it('does not escape class (but it probably should)', () => {
      expect(escapeIdentifier('class', false)).toEqual('class');
    });
  });

  describe('visitReadKeyExpr', () => {
    it('should emit (receiver as any)[index] when printTypes is true', () => {
      const visitor = new TestEmitterVisitor(/* printComments */ false, /* printTypes */ true);
      const ctx = EmitterVisitorContext.createRoot();
      const readKey = new o.ReadKeyExpr(o.variable('foo'), o.literal('bar'));
      readKey.visitExpression(visitor, ctx);
      expect(ctx.toSource()).toEqual(`(foo as any)['bar']`);
    });

    it('should emit receiver[index] without cast when printTypes is false', () => {
      const visitor = new TestEmitterVisitor(/* printComments */ false, /* printTypes */ false);
      const ctx = EmitterVisitorContext.createRoot();
      const readKey = new o.ReadKeyExpr(o.variable('foo'), o.literal('bar'));
      readKey.visitExpression(visitor, ctx);
      expect(ctx.toSource()).toEqual(`foo['bar']`);
    });

    it('should emit (receiver as any)?.[index] for optional indexed access when printTypes is true', () => {
      const visitor = new TestEmitterVisitor(/* printComments */ false, /* printTypes */ true);
      const ctx = EmitterVisitorContext.createRoot();
      const readKey = new o.ReadKeyExpr(
        o.variable('foo'),
        o.literal('bar'),
        null,
        null,
        undefined,
        true,
      );
      readKey.visitExpression(visitor, ctx);
      expect(ctx.toSource()).toEqual(`(foo as any)?.['bar']`);
    });
  });
});

export function stripSourceMapAndNewLine(source: string): string {
  if (source.endsWith('\n')) {
    source = source.substring(0, source.length - 1);
  }
  const smi = source.lastIndexOf('\n//#');
  if (smi == -1) return source;
  return source.slice(0, smi);
}
