import * as path from 'path';
import * as ts from 'typescript';
import {HybridCompiler} from '../../src/hybrid_compiler.js';
import {isPositionInHostBinding} from './utils.js';
import {makeClassKey} from '../../src/compiler-utils.js';
import {ClassMetadata} from '../../src/types.js';

export function offsetAt(content: string, position: {line: number; character: number}): number {
  const lines = content.split('\n');
  let offset = 0;
  for (let i = 0; i < Math.min(position.line, lines.length); i++) {
    offset += lines[i].length + 1; // +1 for \n
  }
  const currentLine = lines[position.line];
  const charOffset = currentLine
    ? Math.min(position.character, currentLine.length)
    : position.character;
  offset += charOffset;
  return offset;
}

export interface SetupResult {
  tsFilePath: string;
  meta: any;
  parsedTemplate: any;
  offset: number;
  tcbSf: ts.SourceFile;
  tcbCode: string;
  isHostBinding?: boolean;
  hostElement?: any;
}

/**
 * Resolves the TCB (Type Check Block) and associated metadata for a given file and position.
 *
 * This function performs the heavy lifting of mapping a position in a template (or component file)
 * to the corresponding TCB, parsed template, and offsets.
 *
 * **Why it exists in the hybrid preprocessor:**
 * Currently, in the hybrid preprocessor, we operate in a stateless, on-demand mode. This is just
 * how it is while we are building things out; we plan to have persistent state and incremental
 * builds later. We don't maintain a persistent TypeScript program with TCB shims injected. Instead,
 * we query the `HybridCompiler` for the TCB code and parsed template on demand, and create a dummy
 * source file to pass to Angular's `SymbolBuilder`.
 *
 * **Why it does not exist in reference Angular:**
 * In reference Angular (`TemplateTypeCheckerImpl`), this state is managed across the entire program.
 * Angular uses a `ProgramDriver` to inject TCB shims into the TypeScript program and maintains
 * caches for completion engines and symbol builders. It does not need to resolve these on the fly
 * for a specific position in this manner.
 *
 * @param hybridCompiler The hybrid compiler instance to query for data.
 * @param filePath The path to the file (HTML or TS).
 * @param position The line and character position in the file.
 * @returns The setup result containing the TCB source file and mapped offsets, or null if resolution fails.
 */
export function getSetup(
  hybridCompiler: HybridCompiler,
  filePath: string,
  position: {line: number; character: number},
): SetupResult | null {
  try {
    let fileContent: string;
    try {
      fileContent = hybridCompiler.getFileContent(filePath);
    } catch {
      return null;
    }
    const offset = offsetAt(fileContent, position);

    let meta: any = null;
    let tsFilePath = filePath;
    let isHostBinding = false;

    if (filePath.endsWith('.html')) {
      const resolved = hybridCompiler.getTsFileForTemplate(filePath);

      if (!resolved) {
        return null;
      }
      tsFilePath = resolved.tsFilePath;

      const fileResult = hybridCompiler.getClassMetadata(tsFilePath);
      if (!fileResult) {
        return null;
      }

      const compClass = fileResult.classes.find(
        (c: ClassMetadata) => c.symbolId === resolved.symbolId,
      );

      if (!compClass) {
        return null;
      }

      meta = {
        className: compClass.className,
        classKey: makeClassKey(compClass.className, compClass.span.start),
        selector: compClass.component?.selector,
        template: compClass.component?.template,
        isStandalone: compClass.component?.standalone,
        resolvedDeclarations: compClass.component?.resolvedDeclarations || [],
        allDeclarations: fileResult.classes || [],
      };
    } else {
      const fileResult = hybridCompiler.getClassMetadata(filePath);
      if (!fileResult) {
        return null;
      }

      const compClass = fileResult.classes.find((c: ClassMetadata) => {
        if (c.component && c.component.template && c.component.templateOffset !== undefined) {
          const start = c.component.templateOffset;
          const end = start + c.component.template.length;
          if (offset >= start && offset <= end) return true;
        }

        if (isPositionInHostBinding(c, offset)) {
          isHostBinding = true;
          return true;
        }

        return false;
      });

      const targetComp = compClass;
      if (!targetComp) {
        return null;
      }

      meta = {
        className: targetComp.className,
        classKey: makeClassKey(targetComp.className, targetComp.span.start),
        selector: targetComp.component?.selector,
        template: targetComp.component?.template,
        resolvedDeclarations: targetComp.component?.resolvedDeclarations || [],
        allDeclarations: fileResult.classes || [],
        isStandalone: targetComp.component?.standalone,
      };
    }

    if (!meta || (!meta.template && !filePath.endsWith('.html') && !isHostBinding)) {
      return null;
    }

    const tcbCode = hybridCompiler.getTcbForFile(tsFilePath);
    if (!tcbCode) {
      return null;
    }

    let parsedTemplate = hybridCompiler.getParsedTemplate(tsFilePath, meta.classKey);
    if (!parsedTemplate) {
      if (isHostBinding) {
        parsedTemplate = {nodes: [], errors: []};
      } else {
        return null;
      }
    }

    const dummyTcbPath = path.join(path.dirname(tsFilePath), '__tcb__.ts');
    const tcbSf = ts.createSourceFile(
      dummyTcbPath,
      tcbCode,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const hostElement = isHostBinding
      ? hybridCompiler.getHostElement(tsFilePath, meta.classKey)
      : null;

    return {
      tsFilePath,
      meta,
      parsedTemplate,
      offset,
      tcbSf,
      tcbCode,
      isHostBinding,
      hostElement,
    };
  } catch (e) {
    console.error('getSetup CRITICAL ERROR:', e);
    return null;
  }
}
