/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  TypeCheckBlockMetadata,
  TcbTypeCheckBlockMetadata,
  TcbDirectiveMetadata,
  TcbBoundTarget,
  TcbReferenceMetadata,
} from '../api';
import {Environment} from './environment';
import {ImportFlags, ReferenceEmitKind} from '../../imports';
import {ExternalExpr} from '@angular/compiler';
import {requiresInlineTypeCtor} from './type_constructor';
import {TypeParameterEmitter} from './type_parameter_emitter';

/**
 * Adapts the compiler's `TypeCheckBlockMetadata` (which includes full TS AST nodes)
 * into a purely detached `TcbTypeCheckBlockMetadata` that can be mapped to JSON.
 */
export function adaptTypeCheckBlockMetadata(
  meta: TypeCheckBlockMetadata,
  env: Environment,
): TcbTypeCheckBlockMetadata {
  const dirCache = new Map<any, TcbDirectiveMetadata>();

  const convertDir = (dir: any): TcbDirectiveMetadata => {
    if (dirCache.has(dir)) return dirCache.get(dir)!;

    const emitted = env.refEmitter.emit(dir.ref, env.contextFile, ImportFlags.NoAliasing);
    let name = dir.ref.debugName || dir.ref.node.name!.text;
    let moduleName = dir.ref.ownedByModuleGuess;
    let isLocal = true;

    if (emitted.kind === ReferenceEmitKind.Success && emitted.expression instanceof ExternalExpr) {
      name = emitted.expression.value.name!;
      moduleName = emitted.expression.value.moduleName;
      isLocal = false;
    }

    const tcbDir: TcbDirectiveMetadata = {
      isComponent: dir.isComponent,
      name: dir.name,
      selector: dir.selector,
      exportAs: dir.exportAs,
      inputs: dir.inputs, // using the ClassPropertyMapping
      outputs: dir.outputs,
      queries: dir.queries,
      isStructural: dir.isStructural,
      isStandalone: dir.isStandalone,
      isSignal: dir.isSignal,
      isExplicitlyDeferred: dir.isExplicitlyDeferred,
      preserveWhitespaces: dir.preserveWhitespaces,
      ngContentSelectors: dir.ngContentSelectors,
      animationTriggerNames: dir.animationTriggerNames,
      ngTemplateGuards: dir.ngTemplateGuards,
      hasNgTemplateContextGuard: dir.hasNgTemplateContextGuard,
      coercedInputFields: dir.coercedInputFields,
      restrictedInputFields: dir.restrictedInputFields,
      stringLiteralInputFields: dir.stringLiteralInputFields,
      undeclaredInputFields: dir.undeclaredInputFields,
      publicMethods: dir.publicMethods,

      ref: (() => {
        const refMeta = {name, moduleName, isLocal} as TcbReferenceMetadata;
        Object.defineProperty(refMeta, 'node', {value: dir.ref.node, enumerable: false});
        return refMeta;
      })(),
      isGeneric: dir.isGeneric,
      typeParameterCount: dir.ref.node.typeParameters?.length ?? 0,
      get fnTypeParameters() {
        if (!dir.ref.node.typeParameters) return null;
        const emitter = new TypeParameterEmitter(dir.ref.node.typeParameters, env.reflector);
        return emitter.emit((ref) => env.referenceType(ref)) ?? null;
      },
      hasRequiresInlineTypeCtor: requiresInlineTypeCtor(dir.ref.node, env.reflector, env),
    };

    dirCache.set(dir, tcbDir);
    return tcbDir;
  };

  const adaptedBoundTarget: TcbBoundTarget = {
    target: meta.boundTarget.target, // Note: host directives inside target may still contain original `TypeCheckableDirectiveMeta`.
    getUsedDirectives: () => meta.boundTarget.getUsedDirectives().map(convertDir),
    getUsedPipes: () => meta.boundTarget.getUsedPipes(),
    getDirectivesOfNode: (node) => {
      const dirs = meta.boundTarget.getDirectivesOfNode(node);
      return dirs ? dirs.map(convertDir) : null;
    },
    getReferenceTarget: (ref) => {
      const target = meta.boundTarget.getReferenceTarget(ref);
      if (target && 'directive' in target) {
        return {directive: convertDir(target.directive), node: target.node};
      }
      return target;
    },
    getDeferredTriggerTarget: (b, t) => meta.boundTarget.getDeferredTriggerTarget(b, t),
    isDeferred: (node) => meta.boundTarget.isDeferred(node),
    referencedDirectiveExists: (name) => meta.boundTarget.referencedDirectiveExists(name),
    getConsumerOfBinding: (binding) => {
      const consumer = meta.boundTarget.getConsumerOfBinding(binding);
      if (consumer && 'isComponent' in consumer) {
        return convertDir(consumer);
      }
      return consumer;
    },
    getExpressionTarget: (expr) => meta.boundTarget.getExpressionTarget(expr),
    getEagerlyUsedPipes: () => meta.boundTarget.getEagerlyUsedPipes(),
  };

  return {
    id: meta.id,
    boundTarget: adaptedBoundTarget,
    pipes: meta.pipes,
    schemas: meta.schemas,
    isStandalone: meta.isStandalone,
    preserveWhitespaces: meta.preserveWhitespaces,
  };
}
