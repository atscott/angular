/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import * as ts from 'typescript/lib/tsserverlibrary';
import * as lsp from 'vscode-languageserver';
import {documentationToMarkdown} from '../text_render';

export function tsQuickInfoToHover(
  info: ts.QuickInfo,
  rangeConverter: (span: ts.TextSpan) => lsp.Range,
  getScriptInfo: (fileName: string) => ts.server.ScriptInfo | undefined,
): lsp.Hover {
  const {kind, kindModifiers, textSpan, displayParts, documentation, tags} = info;
  let desc = kindModifiers ? kindModifiers + ' ' : '';
  if (displayParts && displayParts.length > 0) {
    // displayParts does not contain info about kindModifiers
    // but displayParts does contain info about kind
    desc += displayParts.map((dp) => dp.text).join('');
  } else {
    desc += kind;
  }
  const contents: lsp.MarkedString[] = [
    {
      language: 'typescript',
      value: desc,
    },
  ];
  const mds = documentationToMarkdown(documentation, tags, getScriptInfo);
  contents.push(mds.join('\n'));
  return {
    contents,
    range: rangeConverter(textSpan),
  };
}
