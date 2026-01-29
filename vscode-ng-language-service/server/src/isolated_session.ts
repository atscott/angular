/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  Connection,
  InitializeParams,
  InitializeResult,
  TextDocuments,
  TextDocumentSyncKind,
  createConnection,
  DidOpenTextDocumentNotification,
  DidChangeTextDocumentNotification,
} from 'vscode-languageserver/node';
import {TextDocument} from 'vscode-languageserver-textdocument';
import {ServerHost} from './server_host';
import {Logger} from './logger';
import ts from 'typescript';

import {NgIsolatedLanguageService} from '@angular/language-service/isolated';
import {documentationToMarkdown} from './text_render';
import * as lsp from 'vscode-languageserver';
import {tsQuickInfoToHover} from './utils/hover';

// Use the interface, not the class, to avoid private property conflicts
export interface IsolatedSessionOptions {
  host: ServerHost;
  logger: ts.server.Logger;
}

export class IsolatedSession {
  private readonly connection: Connection;
  private readonly documents: TextDocuments<TextDocument>;
  private readonly projects = new Map<string, NgIsolatedLanguageService>();
  private readonly tcbVersions = new Map<string, number>();
  private readonly tcbContent = new Map<string, string>();

  constructor(private readonly options: IsolatedSessionOptions) {
    this.connection = createConnection();
    this.documents = new TextDocuments(TextDocument);
    this.documents.listen(this.connection);

    this.addProtocolHandlers(this.connection);

    this.documents.onDidOpen((e) => {
      this.handleFileChange(this.uriToFilePath(e.document.uri));
    });

    this.documents.onDidClose((e) => {
      // Logic to handle close? Maybe do nothing for now as per previous logic
    });

    this.documents.onDidChangeContent((e) => {
      this.handleFileChange(this.uriToFilePath(e.document.uri));
    });
  }

  listen() {
    this.connection.listen();
  }

  info(message: string): void {
    this.options.logger.info(message);
  }

  private addProtocolHandlers(conn: Connection) {
    conn.onInitialize((p) => this.onInitialize(p));
    conn.onDidChangeWatchedFiles((p) => this.onDidChangeWatchedFiles(p));
    conn.onHover((p) => this.onHover(p));
  }

  private onInitialize(params: InitializeParams): InitializeResult {
    return {
      capabilities: {
        textDocumentSync: TextDocumentSyncKind.Incremental,
        hoverProvider: true,
      },
    };
  }

  private onDidChangeWatchedFiles(params: any): void {
    this.info(`[Isolated] Watched files changed: ${JSON.stringify(params)}`);
    // TODO: Handle external file changes, specifically tsconfig changes
    // If tsconfig changes, we should invalidate the project
  }

  private uriToFilePath(uri: string): string | null {
    if (uri.startsWith('file://')) {
      return decodeURIComponent(uri.replace('file://', ''));
    }
    return null;
  }

  private textSpanToLspRange(doc: TextDocument, span: ts.TextSpan): lsp.Range {
    const start = doc.positionAt(span.start);
    const end = doc.positionAt(span.start + span.length);
    return {start, end};
  }

  private async handleFileChange(filePath: string | null) {
    if (!filePath) return;

    // We can't easily rely on just one lookup because a file might belong to multiple projects,
    // or we might need to re-evaluate if the previously found config was a solution config.
    // For now, let's resolve the best config every time we open/change?
    // Optimization: Cache result for a filePath?
    // Let's rely on cached 'projects' map keys.

    const configPath = this.findConfigurationForFile(filePath);
    if (!configPath) {
      this.info(`[Isolated] No tsconfig found for ${filePath}`);
      return;
    }

    await this.updateProject(configPath, filePath);
  }

  private findConfigurationForFile(filePath: string): string | null {
    // 1. Find the nearest tsconfig.json
    const configPath = ts.findConfigFile(filePath, ts.sys.fileExists);
    if (!configPath) return null;

    // 2. Check if it's a solution-style config
    return this.resolveDetailedConfig(configPath, filePath);
  }

  private resolveDetailedConfig(configPath: string, filePath: string): string {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      return configPath; // Return standard one if error, updateProject will diagnose
    }

    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      configPath.replace(/tsconfig\.json$/, ''),
      undefined,
      configPath,
    );

    // If it has project references, check them
    if (parsed.projectReferences && parsed.projectReferences.length > 0) {
      // HTML files are generally not listed in tsconfig (unless strict templates/inputs are used in a specific way),
      // but they belong to the component's module.
      // We probe using the .ts sibling if it's an html file.
      const probePath = filePath.endsWith('.html') ? filePath.replace(/\.html$/, '.ts') : filePath;

      // Simple check: is file in parsed.fileNames?
      // Note: parsed.fileNames includes expanded glob matches if 'include' was present.
      // Solution style configs usually have empty 'files'/'include' or specific ones.

      // Simple check: is file in parsed.fileNames?
      // Note: fileNames are absolute paths.
      if (
        parsed.fileNames.includes(filePath) ||
        (probePath !== filePath && parsed.fileNames.includes(probePath))
      ) {
        return configPath;
      }

      // Check references
      for (const ref of parsed.projectReferences) {
        // ref.path is the referenced tsconfig path
        const refConfigPath = ts.resolveProjectReferencePath(ref);
        if (refConfigPath) {
          // Parse the referenced config to see if it includes the file
          const refConfig = ts.readConfigFile(refConfigPath, ts.sys.readFile);
          if (refConfig.error) continue;

          // We need to match includes/excludes. parsing is the most robust way but expensive?
          // We only do this on file open strings, so maybe acceptable.
          const refParsed = ts.parseJsonConfigFileContent(
            refConfig.config,
            ts.sys,
            refConfigPath.replace(/[^/]+$/, ''),
            undefined,
            refConfigPath,
          );

          if (
            refParsed.fileNames.includes(filePath) ||
            (probePath !== filePath && refParsed.fileNames.includes(probePath))
          ) {
            return refConfigPath;
          }
        }
      }
    }

    return configPath;
  }

  private async updateProject(configPath: string, triggeredFile: string) {
    let service = this.projects.get(configPath);

    // Parse config
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      this.info(`[Isolated] Error reading tsconfig: ${configFile.error.messageText}`);
      return;
    }

    const parsed = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      configPath.replace('tsconfig.json', ''),
    );

    // Create delegate host
    const delegateHost = ts.createCompilerHost(parsed.options);
    const originalReadFile = delegateHost.readFile;
    delegateHost.readFile = (fileName: string) => {
      // Start by checking if we have an open document for this file
      const doc = this.documents.all().find((d) => this.uriToFilePath(d.uri) === fileName);
      if (doc) {
        return doc.getText();
      }
      return originalReadFile.call(delegateHost, fileName);
    };

    // Re-create service (reusing old if exists)
    service = new NgIsolatedLanguageService(
      parsed.fileNames,
      parsed.options,
      delegateHost,
      service,
    );
    this.projects.set(configPath, service);

    this.info(`[Isolated] Analyzing project ${configPath}`);
    await service.analyze();
    const results = service.transformAndPrint();

    for (const file of results) {
      if (file.fileName.endsWith('.ngtypecheck.ts')) {
        const uri = `file://${file.fileName}`;

        let version = this.tcbVersions.get(uri) ?? 0;
        const isNew = version === 0;
        version++;
        this.tcbVersions.set(uri, version);
        this.tcbContent.set(uri, file.content);

        if (isNew) {
          await this.connection.sendNotification('angular/sendTsServerNotification', {
            method: DidOpenTextDocumentNotification.type.method,
            params: {
              textDocument: {
                uri: uri,
                languageId: 'typescript',
                version: version,
                text: file.content,
              },
            },
          });
        } else {
          await this.connection.sendNotification('angular/sendTsServerNotification', {
            method: DidChangeTextDocumentNotification.type.method,
            params: {
              textDocument: {
                uri: uri,
                version: version,
              },
              contentChanges: [{text: file.content}],
            },
          });
        }
      }
    }
    // }
  }

  private async onHover(params: any): Promise<any> {
    const {textDocument, position} = params;
    const fileName = this.uriToFilePath(textDocument.uri);
    if (!fileName) return null;

    const doc = this.documents.get(textDocument.uri);
    if (!doc) return null;

    const configPath = this.findConfigurationForFile(fileName);
    if (!configPath) return null;

    const service = this.projects.get(configPath);
    if (!service) return null;

    const offset = doc.offsetAt(position);

    try {
      const info = await service.getQuickInfoAtPosition(fileName, offset, (f, p) =>
        this.fetchTsQuickInfo(f, p),
      );
      if (info) {
        return tsQuickInfoToHover(
          info,
          (span: ts.TextSpan) => this.textSpanToLspRange(doc, span),
          (_fileName: string) => undefined,
        );
      }
    } catch (e) {
      debugger;
      this.info(`[Isolated] Error in NgIsolatedLanguageService: ${e}`);
    }

    try {
      debugger;
      return await this.connection.sendRequest('angular/sendTsServerRequest', {
        method: lsp.HoverRequest.type.method,
        params,
      });
    } catch (e) {
      this.info(`[Isolated] TsGoClient fallback hover failed: ${e}`);
    }

    return null;
  }

  private async fetchTsQuickInfo(
    fileName: string,
    position: number,
  ): Promise<ts.QuickInfo | undefined> {
    const uri = `file://${fileName}`;
    const content = this.tcbContent.get(uri);
    if (!content) {
      this.info(`[Isolated] No cached TCB content for ${uri}`);
      return undefined;
    }

    const tempDoc = TextDocument.create(uri, 'typescript', 0, content);
    const pos = tempDoc.positionAt(position);

    try {
      const hover = (await this.connection.sendRequest('angular/sendTsServerRequest', {
        method: lsp.HoverRequest.type.method,
        params: {
          textDocument: {uri},
          position: pos,
        },
      })) as lsp.Hover;
      if (!hover) return undefined;

      const contents = hover.contents;
      let textContent = '';
      if (Array.isArray(contents)) {
        textContent = contents.map((c) => (typeof c === 'string' ? c : c.value)).join('\n');
      } else if (lsp.MarkupContent.is(contents)) {
        textContent = contents.value;
      } else if (typeof contents === 'string') {
        textContent = contents;
      } else {
        textContent = contents.value;
      }

      return {
        kind: ts.ScriptElementKind.unknown,
        kindModifiers: '',
        textSpan: {start: position, length: 0},
        displayParts: [{kind: 'text', text: textContent}],
        documentation: [],
      };
    } catch (e) {
      debugger;
      this.options.logger.info(`[Isolated] Error fetching TS QuickInfo: ${e}`);
      return undefined;
    }
  }
}
