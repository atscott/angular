/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {ParseSourceSpan} from '@angular/compiler';
import * as ts from 'typescript';

import {readSpanComment} from './diagnostics';

export function findNodeWithSourceSpan<T extends ts.Node>(
    sourceSpan: ParseSourceSpan, tcb: ts.Node, filter: (node: ts.Node) => node is T): T|null {
  function visitor(node: ts.Node): T|undefined {
    const comment = readSpanComment(tcb.getSourceFile(), node);
    if (sourceSpan.start.offset === comment?.start && sourceSpan.end.offset === comment?.end &&
        filter(node)) {
      return node;
    }
    return node.forEachChild(visitor);
  }
  return tcb.forEachChild(visitor) ?? null;
}
