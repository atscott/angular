/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

/**
 * @fileoverview
 * This file is used as a private API channel to shared Angular FW APIs with @angular/cli.
 *
 * Any changes to this file should be discussed with the Angular CLI team.
 */

import ts from 'typescript';

import {angularJitApplicationTransform} from '../src/ngtsc/transform/jit/index';

/**
 * Known values for global variables in `@angular/core` that Terser should set using
 * https://github.com/terser-js/terser#conditional-compilation
 */
export const GLOBAL_DEFS_FOR_TERSER = {
  ngDevMode: false,
  ngI18nClosureMode: false,
};

export const GLOBAL_DEFS_FOR_TERSER_WITH_AOT = {
  ...GLOBAL_DEFS_FOR_TERSER,
  ngJitMode: false,
};

/**
 * JIT transform used by the Angular CLI.
 *
 * NOTE: Signature is explicitly captured here to highlight the
 * contract various Angular CLI versions are relying on.
 */
export const constructorParametersDownlevelTransform = (
  program: ts.Program,
  isCore = false,
): ts.TransformerFactory<ts.SourceFile> => {
  return angularJitApplicationTransform(program, isCore);
};

export {generateTypeCheckBlock} from '../src/ngtsc/typecheck/src/type_check_block';
export {DetachedTcbEnvironment} from '../src/ngtsc/typecheck/src/detached_tcb_environment';
export {
  TcbComponentMetadata,
  TcbDirectiveMetadata,
  TcbPipeMetadata,
  TcbPropertySet,
  TcbScope,
} from '../src/ngtsc/typecheck/api/tcb_metadata';
export {DomSchemaChecker} from '../src/ngtsc/typecheck/src/dom';
export {OutOfBandDiagnosticRecorder} from '../src/ngtsc/typecheck/src/oob';
export {ClassPropertyMapping} from '../src/ngtsc/metadata/src/property_mapping';
