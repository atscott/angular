/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import * as vscode from 'vscode';
import * as lsp from 'vscode-languageclient/node';
import * as path from 'path';
import {isNotTypescriptOrSupportedDecoratorField} from './embedded_support';

let v = 0;
export interface TcbResponse {
  uri: vscode.Uri;
  content: string;
  selections: vscode.Range[];
}

export type TcbProvider = (
  document: vscode.TextDocument,
  position: vscode.Position,
) => Promise<TcbResponse | undefined>;

export type IsInAngularProjectHelper = (document: vscode.TextDocument) => Promise<boolean>;

const openedVirtualFiles = new Set<string>();

async function synchronizeTcbWithTsServer(
  tcb: TcbResponse,
  ts7Client: lsp.LanguageClient,
): Promise<void> {
  const uriString = tcb.uri.toString();
  if (!openedVirtualFiles.has(uriString)) {
    ts7Client.sendNotification(lsp.DidOpenTextDocumentNotification.type, {
      textDocument: {
        uri: uriString,
        languageId: 'typescript',
        version: ++v,
        text: tcb.content,
      },
    });
    openedVirtualFiles.add(uriString);
  } else {
    ts7Client.sendNotification(lsp.DidChangeTextDocumentNotification.type, {
      textDocument: {
        uri: uriString,
        version: ++v, // Must be higher than the previous version
      },
      contentChanges: [
        {text: tcb.content}, // We send the full text for TCBs
      ],
    });
  }

  // Give TS Server a moment to process the update
  await new Promise((resolve) => setTimeout(resolve, 10));
}

export function createOrchestrationMiddleware(
  tcbProvider: TcbProvider,
  isInAngularProject: IsInAngularProjectHelper,
  ts7Client: lsp.LanguageClient,
): lsp.Middleware {
  return {
    provideDefinition: async (
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken,
      next: lsp.ProvideDefinitionSignature,
    ) => {
      if (
        (await isInAngularProject(document)) &&
        isNotTypescriptOrSupportedDecoratorField(document, position)
      ) {
        // We are in a template.
        const tcb = await tcbProvider(document, position);
        if (tcb && tcb.selections.length > 0) {
          await synchronizeTcbWithTsServer(tcb, ts7Client);

          // Map to the virtual file
          // We assume tcb.selections[0] is the mapped position of the cursor
          const mappedPosition = tcb.selections[0].start;
          return vscode.commands.executeCommand<vscode.Definition>(
            'vscode.executeDefinitionProvider',
            tcb.uri,
            mappedPosition,
          );
        }
        return next(document, position, token);
      }
      return next(document, position, token);
    },

    provideHover: async (
      document: vscode.TextDocument,
      position: vscode.Position,
      token: vscode.CancellationToken,
      next: lsp.ProvideHoverSignature,
    ) => {
      if (
        !(await isInAngularProject(document)) ||
        !isNotTypescriptOrSupportedDecoratorField(document, position)
      ) {
        return next(document, position, token);
      }
      const tcb = await tcbProvider(document, position);
      if (!tcb || tcb.selections.length === 0) {
        return next(document, position, token);
      }

      await synchronizeTcbWithTsServer(tcb, ts7Client);

      const mappedPosition = tcb.selections[0].start;
      const result = await ts7Client.sendRequest(
        lsp.HoverRequest.type,
        {
          textDocument: {uri: tcb.uri.with({scheme: 'file'}).toString()},
          position: mappedPosition,
        },
        token,
      );
      return result ? ts7Client.protocol2CodeConverter.asHover(result) : null;
    },

    provideCompletionItem: async (
      document: vscode.TextDocument,
      position: vscode.Position,
      context: vscode.CompletionContext,
      token: vscode.CancellationToken,
      next: lsp.ProvideCompletionItemsSignature,
    ) => {
      if (
        (await isInAngularProject(document)) &&
        isNotTypescriptOrSupportedDecoratorField(document, position)
      ) {
        const tcb = await tcbProvider(document, position);
        if (tcb && tcb.selections.length > 0) {
          await synchronizeTcbWithTsServer(tcb, ts7Client);

          const mappedPosition = tcb.selections[0].start;
          const completions = await vscode.commands.executeCommand<vscode.CompletionList>(
            'vscode.executeCompletionItemProvider',
            tcb.uri,
            mappedPosition,
            context.triggerCharacter,
          );
          return completions;
        }
        return next(document, position, context, token);
      }
      return next(document, position, context, token);
    },
  };
}
