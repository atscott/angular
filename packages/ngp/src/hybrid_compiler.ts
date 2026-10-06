/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import * as fs from 'node:fs/promises';
import * as path from 'path';
import type * as nga from './types.js';

export function getDiagnosticPath(tsconfigPath: string): string {
  if (tsconfigPath.endsWith('.json')) {
    return tsconfigPath.slice(0, -5) + '.ngdiag.json';
  }
  return tsconfigPath + '.ngdiag.json';
}

/**
 * Serialize collected diagnostics to the `.ngdiag.json` payload. The map is keyed by
 * completion order of the parallel analysis chunks, which varies from run to run (and across
 * transports), so entries are sorted (file path, then span start) to keep the serialized file
 * deterministic; the sort is stable, so a file's diagnostics sharing a span keep their
 * reporting order.
 */
export function serializeDiagnostics(
  tsconfigPath: string,
  diagnosticsMap: ReadonlyMap<string, nga.NgDiagnostic[]>,
): string {
  const allDiagnostics: Array<nga.NgDiagnostic> = [];
  for (const diags of diagnosticsMap.values()) {
    allDiagnostics.push(...diags);
  }
  allDiagnostics.sort(
    (a, b) =>
      (a.filePath ?? '').localeCompare(b.filePath ?? '') ||
      (a.span?.start ?? -1) - (b.span?.start ?? -1),
  );
  return (
    JSON.stringify(
      {
        tsconfigPath,
        diagnostics: allDiagnostics.map((d) => ({
          filePath: d.filePath,
          category: d.category === 1 ? 'error' : 'warning',
          code: d.code,
          messageText: d.messageText,
          span: d.span,
        })),
      },
      null,
      2,
    ) + '\n'
  );
}
import {
  ParsedTemplate,
  ParseTemplateOptions,
  TcbDirectiveMetadata,
  TypeCheckingConfig,
  TmplAstHostElement,
  BoundTarget,
  MatchSource,
  LEGACY_OPTIONAL_CHAINING_DEFAULT,
} from '@angular/compiler';
import {AnalysisResult, FileInvalidation, CompilationChunk, TemplateUsage} from './types.js';
import {
  prepareTcbTargets,
  generateTcbCode,
  buildTypeCheckingConfig,
  combineTcbContent,
  type NgpTypeCheckingConfig,
} from './tcb.js';
import {processFile, buildTcbTargets, type ProcessedFile} from './processor.js';
import {FileAnalysis, getOrCreateFileAnalysis, ChunkContext} from './file_analysis.js';
import {getIndexedComponents} from './indexing/indexer.js';
import {IndexedComponent} from './indexer_api.js';
import {makeClassKey} from './compiler-utils.js';
export interface IAnalyzer {
  analyze(): AsyncIterable<CompilationChunk>;
  analyzeOptimized(): AsyncIterable<CompilationChunk>;
  analyzeDelta(): AsyncIterable<CompilationChunk>;
  analyzeOptimizedDelta(): AsyncIterable<CompilationChunk>;
  getMetadataForFile(filePath: string): Promise<AnalysisResult | null>;
  updateFileContent(updates: {filePath: string; content: string}[]): Promise<string[]>;
  invalidateFiles(updates: FileInvalidation[]): Promise<string[]>;
  getTsFileForTemplate(templatePath: string): Promise<TemplateUsage[] | null>;
  getFileContent(filePath: string): Promise<string>;

  // Synchronous lookups (supported in NAPI mode, throws in Sidecar mode)
  getMetadataForFileSync(filePath: string): AnalysisResult | null;
  getFileContentSync(filePath: string): string;
  getTsFileForTemplateSync(templatePath: string): TemplateUsage[] | null;
  close(): void;
}
export interface HybridCompilerOptions {
  optimize?: boolean;
  tsconfigPath?: string;
  tcbConfig?: NgpTypeCheckingConfig;
  virtualFiles?: Record<string, string>;
  templateParseOptions?: Partial<ParseTemplateOptions>;
  legacyOptionalChaining?: boolean;
  isClosureCompilerEnabled?: boolean;
  externalRuntimeStyles?: boolean;
  /** Project root used to compute the relative `filePath` emitted in `ɵsetClassDebugInfo`. */
  rootDir?: string;
  /** If true, runs in compliance mode (emits trailing setClassMetadata to match Angular compiler goldens). */
  complianceMode?: boolean;
  workspaceName?: string;
  rootDirs?: string[];
}

export class HybridCompiler {
  public analyzer: IAnalyzer;
  public fileCache = new Map<string, FileAnalysis>();
  public optimize: boolean;
  public tsconfigPath?: string;
  public diagnosticsMap = new Map<string, nga.NgDiagnostic[]>();
  public virtualFiles?: Record<string, string>;
  public tcbConfig: NgpTypeCheckingConfig;
  public templateParseOptions: Partial<ParseTemplateOptions>;
  public legacyOptionalChaining: boolean;
  public isClosureCompilerEnabled: boolean;
  public externalRuntimeStyles: boolean;
  public rootDir?: string;
  public complianceMode: boolean;
  public workspaceName?: string;
  public rootDirs?: string[];
  private pendingCompilation: Promise<void> = Promise.resolve();

  constructor(analyzer: IAnalyzer, options: HybridCompilerOptions = {}) {
    this.optimize = options.optimize ?? true;
    this.tsconfigPath = options.tsconfigPath;
    this.virtualFiles = options.virtualFiles;
    this.templateParseOptions = options.templateParseOptions ?? {};
    this.analyzer = analyzer;
    this.tcbConfig = options.tcbConfig ?? buildTypeCheckingConfig({});
    this.legacyOptionalChaining =
      options.legacyOptionalChaining ?? LEGACY_OPTIONAL_CHAINING_DEFAULT;
    this.isClosureCompilerEnabled = options.isClosureCompilerEnabled ?? false;
    this.externalRuntimeStyles = options.externalRuntimeStyles ?? false;
    this.rootDir = options.rootDir;
    this.complianceMode = options.complianceMode ?? false;
    this.workspaceName = options.workspaceName;
    if (options.rootDirs) {
      const baseDir = options.rootDir ? options.rootDir.replace(/\\/g, '/') : '/';
      this.rootDirs = options.rootDirs.map((d) => {
        const norm = d.replace(/\\/g, '/');
        if (norm.startsWith('/') || /^[a-zA-Z]:/.test(norm)) {
          return norm;
        }
        return path.posix.join(baseDir, norm);
      });
    } else {
      this.rootDirs = undefined;
    }
  }

  public async writeDiagnosticsFile(): Promise<void> {
    if (!this.tsconfigPath) {
      return;
    }
    const diagPath = getDiagnosticPath(this.tsconfigPath);
    const content = serializeDiagnostics(this.tsconfigPath, this.diagnosticsMap);
    if (this.virtualFiles) {
      this.virtualFiles[diagPath] = content;
    } else {
      await fs.writeFile(diagPath, content, 'utf-8');
    }
  }

  public async prepareChunk(chunk: CompilationChunk): Promise<ChunkContext> {
    for (const file of chunk.files) {
      if (file.diagnostics) {
        this.diagnosticsMap.set(file.filePath, file.diagnostics);
      }
    }
    await this.writeDiagnosticsFile();

    const remoteScopedClasses = new Set<string>();
    const eagerlyUsedDeclarations = new Map<string, nga.DeclarationMetadata[]>();

    // 1. Ensure all files in the chunk are bound and get their fileAnalysis.
    const boundFiles = await Promise.all(
      chunk.files.map(async (file) => ({
        file,
        analysis: await this.ensureBoundWithMetadata(file),
      })),
    );

    // 2. Identify template dependencies of components in the chunk and check cycleProne.
    const chunkFileIds = new Set(chunk.files.map((f) => f.fileId));
    const dynamicGraph = new Map<number, Set<number>>();

    // 2a. Pre-seed graph with intra-chunk static TypeScript import edges from Rust
    if (chunk.staticEdges) {
      for (const [fromIdStr, targets] of Object.entries(chunk.staticEdges)) {
        const fromId = Number(fromIdStr);
        let edges = dynamicGraph.get(fromId);
        if (!edges) {
          edges = new Set<number>();
          dynamicGraph.set(fromId, edges);
        }
        for (const target of targets) {
          if (chunkFileIds.has(target) && target !== fromId) {
            edges.add(target);
          }
        }
      }
    }

    for (const {file, analysis} of boundFiles) {
      if (!analysis) continue;

      for (const classMeta of file.classes) {
        if (!classMeta.component || !classMeta.className) continue;
        const className = classMeta.className;

        const classKey = makeClassKey(className, classMeta.span.start);
        const boundTarget = analysis.preparedTcbData?.boundTargetMap.get(classKey);
        if (!boundTarget) continue;

        // Remote scoping replaces the component's own dependency list, so it carries the
        // eager set only — deferred dependencies keep their dynamic imports and do not create static cycles.
        const eagerDirs = new Set(
          boundTarget
            .getEagerlyUsedDirectives()
            .filter((d) => d.matchSource === MatchSource.Selector)
            .map((d) => d.name),
        );
        const eagerPipes = new Set(boundTarget.getEagerlyUsedPipes());
        const eagerDecls = (classMeta.component.resolvedDeclarations || []).filter((d) =>
          d.declarationType === 'pipe'
            ? !!d.pipeName && eagerPipes.has(d.pipeName)
            : d.declarationType !== 'ngmodule' && eagerDirs.has(d.name),
        );
        eagerlyUsedDeclarations.set(`${file.filePath}#${className}`, eagerDecls);

        // Check if any eagerly used dependency is statically cycleProne
        let hasStaticCycle = false;
        for (const decl of eagerDecls) {
          if (decl.cycleProne) {
            hasStaticCycle = true;
            break;
          }
        }

        if (hasStaticCycle) {
          remoteScopedClasses.add(`${file.filePath}#${className}`);
          continue;
        }

        // Add eager dependencies to local dynamic graph
        let edges = dynamicGraph.get(file.fileId);
        if (!edges) {
          edges = new Set<number>();
          dynamicGraph.set(file.fileId, edges);
        }
        for (const decl of eagerDecls) {
          if (chunkFileIds.has(decl.fileId) && decl.fileId !== file.fileId) {
            edges.add(decl.fileId);
          }
        }
      }
    }

    // 3. Detect cycles in the local dynamic graph
    const cyclicFiles = findCyclicNodes(dynamicGraph);

    // Mark all component classes declared in the cyclic files as remotely scoped
    for (const file of chunk.files) {
      if (cyclicFiles.has(file.fileId)) {
        for (const classMeta of file.classes) {
          if (classMeta.component && classMeta.className) {
            remoteScopedClasses.add(`${file.filePath}#${classMeta.className}`);
          }
        }
      }
    }

    const metadataMap = new Map<string, nga.AnalysisResult>();
    for (const file of chunk.files) {
      metadataMap.set(file.filePath, file);
    }

    return {remoteScopedClasses, metadataMap, eagerlyUsedDeclarations};
  }

  public async init() {
    const iterator = this.optimize ? this.analyzer.analyzeOptimized() : this.analyzer.analyze();
    for await (const _ of iterator) {
    }
  }

  public async ensureReady() {
    await this.pendingCompilation;
  }

  public async updateFileContent(updates: {filePath: string; content: string}[]): Promise<void> {
    if (updates.length === 0) {
      return;
    }
    const promise = this.pendingCompilation.then(async () => {
      const invalidatedTsFiles = await this.analyzer.updateFileContent(updates);
      for (const filePath of invalidatedTsFiles) {
        this.fileCache.delete(filePath);
      }
      const iterator = this.optimize
        ? this.analyzer.analyzeOptimizedDelta()
        : this.analyzer.analyzeDelta();
      for await (const chunk of iterator) {
        for (const res of chunk.files) {
          this.fileCache.delete(res.filePath);
        }
      }
    });
    this.pendingCompilation = promise;
    await promise;
  }

  public async invalidateFiles(updates: FileInvalidation[]): Promise<void> {
    if (updates.length === 0) {
      return;
    }
    const promise = this.pendingCompilation.then(async () => {
      const invalidatedTsFiles = await this.analyzer.invalidateFiles(updates);
      for (const filePath of invalidatedTsFiles) {
        this.fileCache.delete(filePath);
      }
      const iterator = this.optimize
        ? this.analyzer.analyzeOptimizedDelta()
        : this.analyzer.analyzeDelta();
      for await (const chunk of iterator) {
        for (const res of chunk.files) {
          this.fileCache.delete(res.filePath);
        }
      }
    });
    this.pendingCompilation = promise;
    await promise;
  }

  public analyze(): AsyncIterable<CompilationChunk> {
    return this.analyzer.analyze();
  }

  public analyzeOptimized(): AsyncIterable<CompilationChunk> {
    return this.analyzer.analyzeOptimized();
  }

  public analyzeDelta(): AsyncIterable<CompilationChunk> {
    return this.analyzer.analyzeDelta();
  }

  public analyzeOptimizedDelta(): AsyncIterable<CompilationChunk> {
    return this.analyzer.analyzeOptimizedDelta();
  }

  public getTcbForFile(filePath: string): string | null {
    return this.ensureTcb(filePath).tcb || null;
  }

  /**
   * Ensures that the targets for the given file are bound, resolving all selectors,
   * bindings, and template AST relationships. This phase does NOT perform TCB code
   * generation or printing, which is useful when indexing templates because the indexer
   * only requires a `BoundTarget` (to map identifiers, variables, references, inputs, and outputs)
   * rather than generating/compiling a full TCB representation.
   */
  private ensureBoundSync(filePath: string): FileAnalysis {
    const result = this.analyzer.getMetadataForFileSync(filePath);
    const normalized = result ? result.filePath : filePath;
    const fileAnalysis = getOrCreateFileAnalysis(this.fileCache, normalized);
    if (fileAnalysis.preparedTcbData !== undefined) {
      return fileAnalysis;
    }

    const content = this.analyzer.getFileContentSync(filePath);
    return this.populateBoundData(normalized, fileAnalysis, result, content);
  }

  /**
   * Asynchronously ensures that the targets for the given file are bound.
   * This is used in sidecar/async mode to avoid blocking CPU tasks.
   */
  public async ensureBound(filePath: string): Promise<FileAnalysis> {
    const result = await this.analyzer.getMetadataForFile(filePath);
    if (!result) {
      const fileAnalysis = getOrCreateFileAnalysis(this.fileCache, filePath);
      fileAnalysis.preparedTcbData = null;
      return fileAnalysis;
    }
    return this.ensureBoundWithMetadata(result);
  }

  /**
   * Asynchronously ensures that the targets for the given file analysis result are bound.
   * This avoids re-querying metadata for files whose AnalysisResult is already available
   * from the chunk stream.
   */
  public async ensureBoundWithMetadata(
    result: AnalysisResult,
    content?: string,
  ): Promise<FileAnalysis> {
    const normalized = result.filePath;
    const fileAnalysis = getOrCreateFileAnalysis(this.fileCache, normalized);
    if (fileAnalysis.preparedTcbData !== undefined) {
      return fileAnalysis;
    }

    const fileContent =
      content !== undefined ? content : await this.analyzer.getFileContent(result.filePath);
    return this.populateBoundData(normalized, fileAnalysis, result, fileContent);
  }

  /**
   * Helper that populates template parsing options and runs template target binding.
   */
  private populateBoundData(
    filePath: string,
    fileAnalysis: FileAnalysis,
    result: AnalysisResult | null,
    content: string,
  ): FileAnalysis {
    if (!result) {
      fileAnalysis.preparedTcbData = null;
      return fileAnalysis;
    }

    let templatesByClass = fileAnalysis.parsedTemplates;
    if (!templatesByClass) {
      templatesByClass = new Map<string, ParsedTemplate>();
      fileAnalysis.parsedTemplates = templatesByClass;
    }

    const tcbTargets = buildTcbTargets(
      filePath,
      result.classes,
      templatesByClass,
      this.templateParseOptions,
      this.tcbConfig,
    );

    const prepared = prepareTcbTargets(
      filePath,
      tcbTargets,
      content,
      this.tcbConfig,
      result.classes,
      this.workspaceName,
      this.rootDirs,
    );
    if (prepared) {
      fileAnalysis.preparedTcbData = prepared;
    } else {
      fileAnalysis.preparedTcbData = null;
    }
    return fileAnalysis;
  }

  /**
   * Ensures that the Type Check Block (TCB) code has been generated and cached for the file.
   * This builds upon the bound targets and performs string generation and import management
   * only when requested (lazy-loaded), ensuring optimal performance for non-diagnostics/compilation tasks.
   */
  private ensureTcb(filePath: string): FileAnalysis {
    const fileAnalysis = this.ensureBoundSync(filePath);

    if (fileAnalysis.tcb !== undefined) {
      return fileAnalysis;
    }

    if (!this.optimize || !fileAnalysis.preparedTcbData) {
      fileAnalysis.tcb = null;
      return fileAnalysis;
    }

    const normPath = fileAnalysis.filePath;
    const result = this.analyzer.getMetadataForFileSync(normPath);
    if (!result) {
      fileAnalysis.tcb = null;
      return fileAnalysis;
    }

    const tcbResult = generateTcbCode(normPath, fileAnalysis.preparedTcbData, this.tcbConfig);
    if (!tcbResult) {
      fileAnalysis.tcb = null;
      return fileAnalysis;
    }

    let inlineTcbInfo = {sourceContent: '', classes: [] as nga.ClassMetadata[]};
    if (tcbResult.isInline) {
      const content = this.analyzer.getFileContentSync(normPath);
      inlineTcbInfo = {
        sourceContent: content,
        classes: result.classes,
      };
    }

    const tcbCode = combineTcbContent(tcbResult, normPath, inlineTcbInfo);
    fileAnalysis.tcb = tcbCode;

    return fileAnalysis;
  }

  public getParsedTemplate(filePath: string, classKey: string): any | null {
    return this.ensureBoundSync(filePath).parsedTemplates?.get(classKey) ?? null;
  }

  public getHostElement(filePath: string, classKey: string): any | null {
    return this.ensureBoundSync(filePath).preparedTcbData?.hostElementsMap.get(classKey) ?? null;
  }

  public getTypeCheckIdMap(filePath: string): Map<string, string> | null {
    return this.ensureBoundSync(filePath).preparedTcbData?.typeCheckIdMap ?? null;
  }

  public getClassMetadata(filePath: string): AnalysisResult | null {
    return this.analyzer.getMetadataForFileSync(filePath);
  }

  public async processFile(
    filePath: string,
    content: string,
    readResource?: (file: string) => string | undefined,
    metadata?: nga.AnalysisResult,
    chunkContext?: ChunkContext,
  ): Promise<ProcessedFile> {
    const result = metadata || (await this.analyzer.getMetadataForFile(filePath));
    const normPath = result ? result.filePath : filePath;
    const processed = await processFile(
      this,
      normPath,
      content,
      readResource,
      result || undefined,
      chunkContext,
    );
    if (processed.diagnostics && processed.diagnostics.length > 0) {
      for (const diag of processed.diagnostics) {
        const targetPath = diag.filePath || normPath;
        const existing = this.diagnosticsMap.get(targetPath) || [];
        existing.push(diag);
        this.diagnosticsMap.set(targetPath, existing);
      }
    }
    return processed;
  }

  public getBoundTarget(
    filePath: string,
    classKey: string,
  ): BoundTarget<TcbDirectiveMetadata> | null {
    return this.ensureBoundSync(filePath).preparedTcbData?.boundTargetMap.get(classKey) || null;
  }

  public async getIndexedComponents(): Promise<Map<string, IndexedComponent>> {
    // Drain any remaining items from the analyzer queue first.
    const iterator = this.optimize ? this.analyzer.analyzeOptimized() : this.analyzer.analyze();
    for await (const chunk of iterator) {
      for (const result of chunk.files) {
        await this.ensureBound(result.filePath);
      }
    }

    return getIndexedComponents(this);
  }

  public getTsFileForTemplate(templatePath: string): TemplateUsage | null {
    const res = this.analyzer.getTsFileForTemplateSync(templatePath);
    return res?.[0] ?? null;
  }

  public getFileContent(filePath: string): string {
    return this.analyzer.getFileContentSync(filePath);
  }
}

export function findCyclicNodes(graph: ReadonlyMap<number, ReadonlySet<number>>): Set<number> {
  const cyclic = new Set<number>();
  const index = new Map<number, number>();
  const lowLink = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  let nextIndex = 0;

  for (const root of graph.keys()) {
    if (index.has(root)) {
      continue;
    }

    const frames: {
      node: number;
      edges: Iterator<number>;
    }[] = [];
    const enter = (node: number): void => {
      index.set(node, nextIndex);
      lowLink.set(node, nextIndex);
      nextIndex++;
      stack.push(node);
      onStack.add(node);
      frames.push({node, edges: (graph.get(node) ?? new Set<number>())[Symbol.iterator]()});
    };
    enter(root);

    while (frames.length > 0) {
      const frame = frames[frames.length - 1];
      const step = frame.edges.next();

      if (!step.done) {
        const neighbor = step.value;
        if (neighbor === frame.node) {
          // A one-node cycle, which an SCC of size one cannot express.
          cyclic.add(neighbor);
        } else if (!index.has(neighbor)) {
          enter(neighbor);
        } else if (onStack.has(neighbor)) {
          lowLink.set(frame.node, Math.min(lowLink.get(frame.node)!, index.get(neighbor)!));
        }
        continue;
      }

      frames.pop();
      const caller = frames[frames.length - 1];
      if (caller !== undefined) {
        lowLink.set(caller.node, Math.min(lowLink.get(caller.node)!, lowLink.get(frame.node)!));
      }

      if (lowLink.get(frame.node) !== index.get(frame.node)) {
        continue;
      }

      // The node roots a strongly connected component: itself and everything stacked above it.
      const component: number[] = [];
      for (;;) {
        const member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
        if (member === frame.node) {
          break;
        }
      }
      if (component.length > 1) {
        for (const member of component) {
          cyclic.add(member);
        }
      }
    }
  }

  return cyclic;
}
