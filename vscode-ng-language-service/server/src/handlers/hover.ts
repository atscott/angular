/*!
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import * as lsp from 'vscode-languageserver';
import {getSCSSLanguageService} from 'vscode-css-languageservice';
import {TextDocument} from 'vscode-languageserver-textdocument';
import * as ts from 'typescript/lib/tsserverlibrary';

import {Session} from '../session';
import {getSCSSVirtualContent, isInlineStyleNode} from '../embedded_support';
import {lspPositionToTsPosition, getTokenAtPosition, tsTextSpanToLspRange} from '../utils';
import {documentationToMarkdown} from '../text_render';
import {tsQuickInfoToHover} from '../utils/hover';

const scssLS = getSCSSLanguageService();

export function onHover(session: Session, params: lsp.HoverParams): lsp.Hover | null {
  const lsInfo = session.getLSAndScriptInfo(params.textDocument);
  if (lsInfo === null) {
    return null;
  }
  const {languageService, scriptInfo} = lsInfo;
  const offset = lspPositionToTsPosition(scriptInfo, params.position);
  const info = languageService.getQuickInfoAtPosition(scriptInfo.fileName, offset);
  if (!info) {
    const sf = session.getDefaultProjectForScriptInfo(scriptInfo)?.getSourceFile(scriptInfo.path);
    if (!sf) {
      return null;
    }
    const node = getTokenAtPosition(sf, offset);
    if (!isInlineStyleNode(node)) {
      return null;
    }
    const virtualScssDocContents = getSCSSVirtualContent(sf);
    const virtualScssDoc = TextDocument.create(
      params.textDocument.uri.toString(),
      'scss',
      0,
      virtualScssDocContents,
    );
    const stylesheet = scssLS.parseStylesheet(virtualScssDoc);
    return scssLS.doHover(virtualScssDoc, params.position, stylesheet);
  }
  return tsQuickInfoToHover(
    info,
    (span: ts.TextSpan) => tsTextSpanToLspRange(scriptInfo, span),
    (fileName: string) => session.getLSAndScriptInfo(fileName)?.scriptInfo,
  );
}
