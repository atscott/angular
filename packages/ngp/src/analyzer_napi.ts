/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import type * as nga from './types.js';
import type {AnalysisResult, FileInvalidation, CompilationChunk, TemplateUsage} from './types.js';
import type {IAnalyzer} from './hybrid_compiler.js';

export class NapiAnalyzer implements IAnalyzer {
  private analyzer: nga.Analyzer | nga.TestAnalyzer;

  constructor(analyzer: nga.Analyzer | nga.TestAnalyzer) {
    this.analyzer = analyzer;
  }

  /**
   * Creates an analyzer, resolving whichever engine is available.
   *
   * Retained for compatibility; prefer `loadAnalyzer` from `./analyzer_loader.js`,
   * whose options are richer and whose return type reflects that the result may be
   * wasm-backed rather than N-API-backed.
   *
   * The loader is reached through a dynamic `import()` so that merely importing this
   * module does not pull engine resolution into module evaluation.
   */
  public static async create(
    tsconfigPath: string,
    options: import('./analyzer_loader.js').LoadAnalyzerOptions = {},
  ): Promise<IAnalyzer> {
    const {loadAnalyzer} = await import('./analyzer_loader.js');
    return loadAnalyzer(tsconfigPath, options);
  }

  async *analyze(): AsyncGenerator<CompilationChunk, void, unknown> {
    const iterator = this.analyzer.analyze();
    while (true) {
      const res = await iterator.next();
      if (res === null || res === undefined) {
        break;
      }
      yield res;
    }
  }

  async *analyzeOptimized(): AsyncGenerator<CompilationChunk, void, unknown> {
    const iterator = this.analyzer.analyzeOptimized();
    while (true) {
      const res = await iterator.next();
      if (res === null || res === undefined) {
        break;
      }
      yield res;
    }
  }

  async *analyzeDelta(): AsyncGenerator<CompilationChunk, void, unknown> {
    const iterator = this.analyzer.analyzeDelta();
    while (true) {
      const res = await iterator.next();
      if (res === null || res === undefined) {
        break;
      }
      yield res;
    }
  }

  async *analyzeOptimizedDelta(): AsyncGenerator<CompilationChunk, void, unknown> {
    const iterator = this.analyzer.analyzeOptimizedDelta();
    while (true) {
      const res = await iterator.next();
      if (res === null || res === undefined) {
        break;
      }
      yield res;
    }
  }

  async getMetadataForFile(filePath: string): Promise<AnalysisResult | null> {
    return this.analyzer.getMetadataForFile(filePath) ?? null;
  }

  async updateFileContent(updates: {filePath: string; content: string}[]): Promise<string[]> {
    return this.analyzer.updateFileContent(updates);
  }

  async invalidateFiles(updates: FileInvalidation[]): Promise<string[]> {
    return this.analyzer.invalidateFiles(updates);
  }

  async getTsFileForTemplate(templatePath: string): Promise<TemplateUsage[] | null> {
    return this.analyzer.getTsFileForTemplate(templatePath);
  }

  async getFileContent(filePath: string): Promise<string> {
    return this.analyzer.getFileContent(filePath);
  }

  getMetadataForFileSync(filePath: string): AnalysisResult | null {
    return this.analyzer.getMetadataForFile(filePath) ?? null;
  }

  getFileContentSync(filePath: string): string {
    return this.analyzer.getFileContent(filePath);
  }

  getTsFileForTemplateSync(templatePath: string): TemplateUsage[] | null {
    return this.analyzer.getTsFileForTemplate(templatePath);
  }

  close(): void {}
}
