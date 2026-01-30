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

import {NgIsolatedLanguageService, LSRequestAdapter} from '@angular/language-service/isolated';
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
  private readonly projects = new Map<
    string,
    {
      service: NgIsolatedLanguageService;
      watch: ts.WatchOfConfigFile<ts.SemanticDiagnosticsBuilderProgram>;
    }
  >();
  // TODO: Implement an LRU cache or explicit disposal for projects.
  // Currently, projects are opened on hover/open and never closed, which is fine for typical usage
  // but could leak memory in very long-running sessions with many distinct projects.
  private readonly tcbVersions = new Map<string, number>();
  private readonly tcbContent = new Map<string, string>();
  private readonly lsAdapter: LSRequestAdapter = {
    getQuickInfoAtPosition: (f: string, p: number) => this.fetchTsQuickInfo(f, p),
    getTypeDefinitionAtPosition: (f: string, p: number) => this.fetchTsDefinition(f, p),
  };

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

    const configPath = ts.findConfigFile(filePath, ts.sys.fileExists);
    if (!configPath) {
      this.info(`[Isolated] No tsconfig found for ${filePath}`);
      return;
    }

    await this.getOrCreateProject(configPath);
  }

  private async getOrCreateProject(configPath: string) {
    if (this.projects.has(configPath)) {
      return;
    }

    this.info(`[Isolated] Creating watch for ${configPath}`);

    const host = ts.createWatchCompilerHost(
      configPath,
      {},
      ts.sys,
      ts.createSemanticDiagnosticsBuilderProgram,
      (diag) => {}, // reportDiagnostic
      (diag) => {}, // reportWatchStatus
    );

    // Polyfill missing methods for CompilerHost compatibility
    // WatchCompilerHost from createWatchCompilerHost doesn't implement all CompilerHost methods directly
    const compilerHost = host as unknown as ts.CompilerHost;
    if (!compilerHost.getSourceFile) {
      compilerHost.getSourceFile = (
        fileName,
        languageVersion,
        onError,
        shouldCreateNewSourceFile,
      ) => {
        let text: string | undefined;
        try {
          text = compilerHost.readFile(fileName);
        } catch (e) {
          if (onError) onError(e instanceof Error ? e.message : String(e));
        }
        return text !== undefined
          ? ts.createSourceFile(fileName, text, languageVersion)
          : undefined;
      };
    }
    if (!compilerHost.getCanonicalFileName) {
      compilerHost.getCanonicalFileName = (fileName: string) =>
        ts.sys.useCaseSensitiveFileNames ? fileName : fileName.toLowerCase();
    }
    if (!compilerHost.getNewLine) {
      compilerHost.getNewLine = () => ts.sys.newLine;
    }
    if (!compilerHost.getDefaultLibFileName) {
      compilerHost.getDefaultLibFileName = (options) => ts.getDefaultLibFilePath(options);
    }
    if (!compilerHost.writeFile) {
      compilerHost.writeFile = (fileName, data, writeByteOrderMark, onError, sourceFiles) => {
        return ts.sys.writeFile(fileName, data, writeByteOrderMark);
      };
    }
    if (!compilerHost.getCurrentDirectory) {
      compilerHost.getCurrentDirectory = () => ts.sys.getCurrentDirectory();
    }
    if (!compilerHost.useCaseSensitiveFileNames) {
      compilerHost.useCaseSensitiveFileNames = () => ts.sys.useCaseSensitiveFileNames;
    }
    if (!compilerHost.fileExists) {
      compilerHost.fileExists = (path) => ts.sys.fileExists(path);
    }
    if (!compilerHost.directoryExists) {
      compilerHost.directoryExists = (path) => ts.sys.directoryExists(path);
    }
    if (!compilerHost.getDirectories) {
      compilerHost.getDirectories = (path) => ts.sys.getDirectories(path);
    }

    // Capture the original readFile to wrap it
    const originalReadFile = host.readFile;
    host.readFile = (fileName: string) => {
      const doc = this.documents.all().find((d) => this.uriToFilePath(d.uri) === fileName);
      if (doc) {
        return doc.getText();
      }
      return originalReadFile.call(host, fileName);
    };

    // Hook into afterProgramCreate
    const origAfterProgramCreate = host.afterProgramCreate;
    host.afterProgramCreate = async (builderProgram) => {
      const program = builderProgram.getProgram();
      const fileNames = program.getRootFileNames();
      const options = program.getCompilerOptions();

      this.info(`[Isolated] Project updated: ${configPath} (${fileNames.length} files)`);

      await this.updateIsolatedService(
        configPath,
        fileNames,
        options,
        host as unknown as ts.CompilerHost,
      );

      if (origAfterProgramCreate) origAfterProgramCreate(builderProgram);
    };

    const watchProgram = ts.createWatchProgram(host);
    const entry = this.projects.get(configPath);
    if (entry) {
      entry.watch = watchProgram;
    } else {
      this.projects.set(configPath, {service: undefined!, watch: watchProgram});
    }
  }

  private async updateIsolatedService(
    configPath: string,
    fileNames: readonly string[],
    options: ts.CompilerOptions,
    compilerHost: ts.CompilerHost,
  ) {
    let entry = this.projects.get(configPath);
    let service = entry?.service;

    service = new NgIsolatedLanguageService(
      fileNames,
      options,
      compilerHost as unknown as ts.CompilerHost,
      service,
    );

    if (entry) {
      entry.service = service;
    } else {
      if (!this.projects.has(configPath)) {
        this.projects.set(configPath, {service, watch: undefined!});
      } else {
        this.projects.get(configPath)!.service = service;
      }
    }
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

    return service;
  }

  private async onHover(params: any): Promise<any> {
    const {textDocument, position} = params;
    const fileName = this.uriToFilePath(textDocument.uri);
    if (!fileName) return null;

    const doc = this.documents.get(textDocument.uri);
    if (!doc) return null;

    const configPath = ts.findConfigFile(fileName, ts.sys.fileExists);
    if (!configPath) return null;

    if (!this.projects.has(configPath)) {
      await this.getOrCreateProject(configPath);
    }

    const projectData = this.projects.get(configPath);
    if (!projectData || !projectData.service) return null;
    const service = projectData.service;

    const offset = doc.offsetAt(position);

    try {
      const info = await service.getQuickInfoAtPosition(fileName, offset, this.lsAdapter);
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

  private async fetchTsDefinition(
    fileName: string,
    position: number,
  ): Promise<readonly ts.DefinitionInfo[] | undefined> {
    const uri = `file://${fileName}`;
    const content = this.tcbContent.get(uri);
    let pos: lsp.Position;
    if (content) {
      const tempDoc = TextDocument.create(uri, 'typescript', 0, content);
      pos = tempDoc.positionAt(position);
    } else {
      const doc = this.documents.get(uri);
      if (doc) {
        pos = doc.positionAt(position);
      } else {
        return undefined;
      }
    }

    try {
      const result = (await this.connection.sendRequest('angular/sendTsServerRequest', {
        method: lsp.DefinitionRequest.type.method,
        params: {
          textDocument: {uri},
          position: pos,
        },
      })) as lsp.Location | lsp.Location[] | null;

      if (!result) return undefined;

      const locations = Array.isArray(result) ? result : [result];
      return locations.map((loc) => {
        const locUri = loc.uri;
        let start = 0;
        // precise mapping back isn't super critical for just getting quick info at the destination
        // but we need to try.
        if (this.tcbContent.has(locUri)) {
          start = TextDocument.create(
            locUri,
            'typescript',
            0,
            this.tcbContent.get(locUri)!,
          ).offsetAt(loc.range.start);
        } else {
          const doc = this.documents.get(locUri);
          if (doc) {
            start = doc.offsetAt(loc.range.start);
          }
        }
        return {
          fileName: this.uriToFilePath(locUri) || locUri,
          textSpan: {start, length: 0},
          kind: ts.ScriptElementKind.unknown,
          name: '',
          containerKind: ts.ScriptElementKind.unknown,
          containerName: '',
        };
      });
    } catch (e) {
      this.options.logger.info(`[Isolated] Error fetching TS Definition: ${e}`);
      return undefined;
    }
  }
}
