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

/** The wasm-bindgen `WasmAnalyzer` surface this adapter drives. */
export interface WasmInner {
  free(): void;
  pump(): string | undefined;
  analyze(): number;
  analyze_optimized?(): number;
  analyzeOptimized?(): number;
  analyze_delta?(): number;
  analyzeDelta?(): number;
  analyze_optimized_delta?(): number;
  analyzeOptimizedDelta?(): number;
  updateFileContent?(updatesJson: string): string;
  update_file_content?(updatesJson: string): string;
  invalidateFiles?(updatesJson: string): string;
  invalidate_files?(updatesJson: string): string;
  getMetadataForFile?(filePath: string): string | undefined;
  get_metadata_for_file?(filePath: string): string | undefined;
  getFileContent?(filePath: string): string;
  get_file_content?(filePath: string): string;
  getTsFileForTemplate?(templatePath: string): string | undefined;
  get_ts_file_for_template?(templatePath: string): string | undefined;
}

interface WasmEvent {
  id: number;
  event: 'analysisResult' | 'analysisComplete' | 'analysisError';
  data?: CompilationChunk;
  error?: string;
}

export class WasmAnalyzer implements IAnalyzer {
  private inner: WasmInner;
  private streams = new Map<
    number,
    {
      queue: (CompilationChunk | null)[];
      nextResolve: ((val: CompilationChunk | null) => void) | null;
      error?: Error;
    }
  >();
  private isPumping = false;

  constructor(inner: WasmInner) {
    this.inner = inner;
  }

  private schedulePump() {
    if (this.isPumping) {
      return;
    }
    this.isPumping = true;
    setTimeout(this.pumpLoop, 0);
  }

  private pumpLoop = () => {
    if (this.streams.size === 0) {
      this.isPumping = false;
      return;
    }

    const start = Date.now();
    let idleCount = 0;
    while (this.streams.size > 0 && Date.now() - start < 15) {
      const eventStr = this.inner.pump();
      if (!eventStr) {
        idleCount++;
        if (idleCount > 1000) {
          break;
        }
        continue;
      }
      idleCount = 0;
      try {
        const event = JSON.parse(eventStr) as WasmEvent;
        const stream = this.streams.get(event.id);
        if (stream) {
          if (event.event === 'analysisResult' && event.data) {
            stream.queue.push(event.data);
          } else if (event.event === 'analysisComplete') {
            stream.queue.push(null);
          } else if (event.event === 'analysisError' && event.error) {
            stream.error = new Error(event.error);
          }
          if (stream.nextResolve) {
            const resolve = stream.nextResolve;
            stream.nextResolve = null;
            resolve(null);
          }
        }
      } catch (e) {
        console.error('Failed to parse WASM pump event', e);
      }
    }

    if (this.streams.size > 0) {
      setTimeout(this.pumpLoop, 0);
    } else {
      this.isPumping = false;
    }
  };

  async *analyze(): AsyncGenerator<CompilationChunk, void, unknown> {
    const id = this.inner.analyze();
    const stream: {
      queue: (CompilationChunk | null)[];
      nextResolve: ((val: CompilationChunk | null) => void) | null;
      error?: Error;
    } = {queue: [], nextResolve: null};
    this.streams.set(id, stream);
    this.schedulePump();

    while (true) {
      if (stream.error) {
        this.streams.delete(id);
        throw stream.error;
      }
      if (stream.queue.length > 0) {
        const item = stream.queue.shift();
        if (item === null) {
          this.streams.delete(id);
          break;
        }
        yield item!;
      } else {
        await new Promise<void>((resolve) => {
          stream.nextResolve = (val) => resolve();
        });
      }
    }
  }

  async *analyzeOptimized(): AsyncGenerator<CompilationChunk, void, unknown> {
    const id = this.inner.analyze_optimized
      ? this.inner.analyze_optimized()
      : this.inner.analyzeOptimized?.();
    if (id === undefined) {
      throw new Error('WasmInner does not support analyzeOptimized');
    }
    const stream: {
      queue: (CompilationChunk | null)[];
      nextResolve: ((val: CompilationChunk | null) => void) | null;
      error?: Error;
    } = {queue: [], nextResolve: null};
    this.streams.set(id, stream);
    this.schedulePump();

    while (true) {
      if (stream.error) {
        this.streams.delete(id);
        throw stream.error;
      }
      if (stream.queue.length > 0) {
        const item = stream.queue.shift();
        if (item === null) {
          this.streams.delete(id);
          break;
        }
        yield item!;
      } else {
        await new Promise<void>((resolve) => {
          stream.nextResolve = (val) => resolve();
        });
      }
    }
  }

  async *analyzeDelta(): AsyncGenerator<CompilationChunk, void, unknown> {
    const id = this.inner.analyze_delta ? this.inner.analyze_delta() : this.inner.analyzeDelta?.();
    if (id === undefined) {
      throw new Error('WasmInner does not support analyzeDelta');
    }
    const stream: {
      queue: (CompilationChunk | null)[];
      nextResolve: ((val: CompilationChunk | null) => void) | null;
      error?: Error;
    } = {queue: [], nextResolve: null};
    this.streams.set(id, stream);
    this.schedulePump();

    while (true) {
      if (stream.error) {
        this.streams.delete(id);
        throw stream.error;
      }
      if (stream.queue.length > 0) {
        const item = stream.queue.shift();
        if (item === null) {
          this.streams.delete(id);
          break;
        }
        yield item!;
      } else {
        await new Promise<void>((resolve) => {
          stream.nextResolve = (val) => resolve();
        });
      }
    }
  }

  async *analyzeOptimizedDelta(): AsyncGenerator<CompilationChunk, void, unknown> {
    const id = this.inner.analyze_optimized_delta
      ? this.inner.analyze_optimized_delta()
      : this.inner.analyzeOptimizedDelta?.();
    if (id === undefined) {
      throw new Error('WasmInner does not support analyzeOptimizedDelta');
    }
    const stream: {
      queue: (CompilationChunk | null)[];
      nextResolve: ((val: CompilationChunk | null) => void) | null;
      error?: Error;
    } = {queue: [], nextResolve: null};
    this.streams.set(id, stream);
    this.schedulePump();

    while (true) {
      if (stream.error) {
        this.streams.delete(id);
        throw stream.error;
      }
      if (stream.queue.length > 0) {
        const item = stream.queue.shift();
        if (item === null) {
          this.streams.delete(id);
          break;
        }
        yield item!;
      } else {
        await new Promise<void>((resolve) => {
          stream.nextResolve = (val) => resolve();
        });
      }
    }
  }

  async getMetadataForFile(filePath: string): Promise<AnalysisResult | null> {
    return Promise.resolve(this.getMetadataForFileSync(filePath));
  }

  async updateFileContent(updates: {filePath: string; content: string}[]): Promise<string[]> {
    const jsonStr = JSON.stringify(updates);
    const fn = this.inner.updateFileContent ?? this.inner.update_file_content;
    if (!fn) {
      throw new Error('WasmInner does not support updateFileContent');
    }
    const res = fn.call(this.inner, jsonStr);
    return Promise.resolve(JSON.parse(res) as string[]);
  }

  async invalidateFiles(updates: FileInvalidation[]): Promise<string[]> {
    const stringNames = ['Created', 'Deleted', 'Changed'];
    const mapped = updates.map((u) => ({
      filePath: u.filePath,
      updateType:
        typeof u.updateType === 'number'
          ? (stringNames[u.updateType] ?? u.updateType)
          : u.updateType,
    }));
    const jsonStr = JSON.stringify(mapped);
    const fn = this.inner.invalidateFiles ?? this.inner.invalidate_files;
    if (!fn) {
      throw new Error('WasmInner does not support invalidateFiles');
    }
    const res = fn.call(this.inner, jsonStr);
    return Promise.resolve(JSON.parse(res) as string[]);
  }

  async getTsFileForTemplate(templatePath: string): Promise<TemplateUsage[] | null> {
    return Promise.resolve(this.getTsFileForTemplateSync(templatePath));
  }

  async getFileContent(filePath: string): Promise<string> {
    return Promise.resolve(this.getFileContentSync(filePath));
  }

  getMetadataForFileSync(filePath: string): AnalysisResult | null {
    const fn = this.inner.getMetadataForFile ?? this.inner.get_metadata_for_file;
    if (!fn) {
      throw new Error('WasmInner does not support getMetadataForFile');
    }
    const res = fn.call(this.inner, filePath);
    return res ? (JSON.parse(res) as AnalysisResult) : null;
  }

  getFileContentSync(filePath: string): string {
    const fn = this.inner.getFileContent ?? this.inner.get_file_content;
    if (!fn) {
      throw new Error('WasmInner does not support getFileContent');
    }
    return fn.call(this.inner, filePath);
  }

  getTsFileForTemplateSync(templatePath: string): TemplateUsage[] | null {
    const fn = this.inner.getTsFileForTemplate ?? this.inner.get_ts_file_for_template;
    if (!fn) {
      throw new Error('WasmInner does not support getTsFileForTemplate');
    }
    const res = fn.call(this.inner, templatePath);
    return res ? (JSON.parse(res) as TemplateUsage[]) : null;
  }

  close(): void {}
}
