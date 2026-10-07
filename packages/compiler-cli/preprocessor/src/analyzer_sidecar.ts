/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import * as child_process from 'child_process';
import * as readline from 'readline';
import type {AnalysisResult, FileInvalidation, CompilationChunk, TemplateUsage} from './types.js';
import type {IAnalyzer} from './hybrid_compiler.js';

interface SidecarResponse {
  id: number;
  result?: any;
  error?: string;
}

export class SidecarAnalyzer implements IAnalyzer {
  private sidecarProcess: child_process.ChildProcess;
  private pendingRequests = new Map<
    number,
    {resolve: (val: any) => void; reject: (err: any) => void}
  >();
  private requestId = 0;
  private resultQueue: CompilationChunk[] = [];
  private nextResolve: ((val: CompilationChunk | null) => void) | null = null;
  private isAnalyzing = false;
  private activeError: Error | null = null;

  constructor(sidecarPath: string) {
    this.sidecarProcess = child_process.spawn(sidecarPath);

    if (this.sidecarProcess.stdout) {
      const rl = readline.createInterface({
        input: this.sidecarProcess.stdout,
        crlfDelay: Infinity,
      });

      rl.on('line', (line: string) => {
        if (line.trim() === '') return;
        try {
          const parsed = JSON.parse(line) as Record<string, any>;
          if (parsed && typeof parsed === 'object') {
            if ('id' in parsed && parsed['id'] !== undefined && parsed['id'] !== null) {
              const req = this.pendingRequests.get(parsed['id'] as number);
              if (req) {
                if (parsed['error']) {
                  req.reject(new Error(parsed['error'] as string));
                } else {
                  req.resolve(parsed['result']);
                }
                this.pendingRequests.delete(parsed['id'] as number);
              }
            } else if (parsed['method'] === 'analysisResult') {
              this.handleAnalysisResult(parsed['params'] as CompilationChunk);
            } else if (parsed['method'] === 'analysisError') {
              this.handleAnalysisError(parsed['params'] as string);
            } else if (parsed['method'] === 'analysisComplete') {
              this.handleAnalysisComplete();
            }
          }
        } catch (e) {
          console.error(`Failed to parse sidecar output line: ${line}`);
        }
      });
    }

    this.sidecarProcess.stderr?.on('data', (data) => {
      console.error(`Sidecar error: ${data}`);
    });

    this.sidecarProcess.on('error', (err) => {
      console.error(`Sidecar process error: ${err.message}`);
    });

    this.sidecarProcess.on('exit', (code) => {
      // stderr, like the sibling handlers above: this module is library code that can run
      // inside a stdio-transport language server, where stdout carries the LSP framing.
      console.error(`Sidecar exited with code ${code}`);
      if (this.onExit) this.onExit();
    });
  }

  private onExit?: () => void;

  public async wait(): Promise<void> {
    if (this.sidecarProcess.exitCode !== null) {
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.onExit = resolve;
    });
  }

  public close(): void {
    if (this.sidecarProcess.stdin) {
      this.sidecarProcess.stdin.end();
    }
  }

  private async callRpc<T = any>(method: string, params: any): Promise<T> {
    if (!this.sidecarProcess.stdin) {
      throw new Error('Sidecar process not available for RPC');
    }
    const id = ++this.requestId;
    const request = {id, method, params};

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {resolve, reject});
      this.sidecarProcess.stdin!.write(JSON.stringify(request) + '\n');
    });
  }

  async initialize(
    tsconfigPath: string,
    optimize: boolean,
    virtualFiles?: Record<string, string>,
    nodeModulesPathOverride?: string,
    options?: {allowedSources?: string[]; workspaceName?: string; rootDirs?: string[]},
  ): Promise<void> {
    await this.callRpc('initialize', {
      tsconfigPath,
      optimize,
      virtualFiles,
      nodeModulesPathOverride,
      allowedSources: options?.allowedSources,
      workspaceName: options?.workspaceName,
      rootDirs: options?.rootDirs,
    });
  }

  async *analyze(): AsyncGenerator<CompilationChunk, void, unknown> {
    this.resultQueue = [];
    this.isAnalyzing = true;
    this.activeError = null;
    await this.callRpc('analyze', {});
    while (true) {
      const res = await this.next_internal();
      if (res === null || res === undefined) {
        break;
      }
      yield res;
    }
  }

  async *analyzeOptimized(): AsyncGenerator<CompilationChunk, void, unknown> {
    this.resultQueue = [];
    this.isAnalyzing = true;
    this.activeError = null;
    await this.callRpc('analyze_optimized', {});
    while (true) {
      const res = await this.next_internal();
      if (res === null || res === undefined) {
        break;
      }
      yield res;
    }
  }

  async *analyzeDelta(): AsyncGenerator<CompilationChunk, void, unknown> {
    this.resultQueue = [];
    this.isAnalyzing = true;
    this.activeError = null;
    await this.callRpc('analyze_delta', {});
    while (true) {
      const res = await this.next_internal();
      if (res === null || res === undefined) {
        break;
      }
      yield res;
    }
  }

  async *analyzeOptimizedDelta(): AsyncGenerator<CompilationChunk, void, unknown> {
    this.resultQueue = [];
    this.isAnalyzing = true;
    this.activeError = null;
    await this.callRpc('analyze_optimized_delta', {});
    while (true) {
      const res = await this.next_internal();
      if (res === null || res === undefined) {
        break;
      }
      yield res;
    }
  }

  private async next_internal(): Promise<CompilationChunk | null> {
    if (this.activeError) {
      const err = this.activeError;
      this.activeError = null;
      throw err;
    }
    if (this.resultQueue.length > 0) {
      return this.resultQueue.shift()!;
    }
    if (!this.isAnalyzing) {
      return null;
    }
    return new Promise((resolve, reject) => {
      this.nextResolve = (chunk) => {
        if (this.activeError) {
          const err = this.activeError;
          this.activeError = null;
          reject(err);
        } else {
          resolve(chunk);
        }
      };
    });
  }

  private handleAnalysisResult(result: CompilationChunk) {
    if (this.nextResolve) {
      const resolve = this.nextResolve;
      this.nextResolve = null;
      resolve(result);
    } else {
      this.resultQueue.push(result);
    }
  }

  private handleAnalysisComplete() {
    this.isAnalyzing = false;
    if (this.nextResolve) {
      const resolve = this.nextResolve;
      this.nextResolve = null;
      resolve(null);
    }
  }

  private handleAnalysisError(errorStr: string) {
    this.isAnalyzing = false;
    this.activeError = new Error(errorStr);
    if (this.nextResolve) {
      const resolve = this.nextResolve;
      this.nextResolve = null;
      resolve(null);
    }
  }

  async getMetadataForFile(filePath: string): Promise<AnalysisResult | null> {
    return this.callRpc<AnalysisResult | null>('getMetadataForFile', {filePath});
  }

  async updateFileContent(updates: {filePath: string; content: string}[]): Promise<string[]> {
    return this.callRpc('updateFileContent', updates);
  }

  async invalidateFiles(updates: FileInvalidation[]): Promise<string[]> {
    return this.callRpc('invalidateFiles', updates);
  }

  async getTsFileForTemplate(templatePath: string): Promise<TemplateUsage[] | null> {
    return this.callRpc('getTsFileForTemplate', {templatePath});
  }

  async getFileContent(filePath: string): Promise<string> {
    return this.callRpc('getFileContent', {filePath});
  }

  getMetadataForFileSync(filePath: string): AnalysisResult | null {
    throw new Error('Synchronous AST lookups are not supported in Sidecar mode');
  }

  getFileContentSync(filePath: string): string {
    throw new Error('Synchronous AST lookups are not supported in Sidecar mode');
  }

  getTsFileForTemplateSync(templatePath: string): TemplateUsage[] | null {
    throw new Error('Synchronous AST lookups are not supported in Sidecar mode');
  }
}
