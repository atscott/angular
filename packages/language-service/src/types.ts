/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';

export type SyncOrAsync<T> = T | Promise<T>;

export interface LSRequestAdapter {
  getQuickInfoAtPosition(fileName: string, position: number): SyncOrAsync<ts.QuickInfo | undefined>;
  getTypeDefinitionAtPosition(
    fileName: string,
    position: number,
  ): SyncOrAsync<readonly ts.DefinitionInfo[] | undefined>;
}
