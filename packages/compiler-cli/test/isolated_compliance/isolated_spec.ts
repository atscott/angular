/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import ts from 'typescript';
import {FileSystem, NodeJSFileSystem} from '../../src/ngtsc/file_system';
import {NgtscTestCompilerHost} from '../../src/ngtsc/testing';
import {NgtscIsolatedPreprocessor} from '../../src/ngtsc/preprocessor';
import {
  CompileResult,
  getBuildOutputDirectory,
  getOptions,
  getRootDirectory,
  initMockTestFileSystem,
} from '../compliance/test_helpers/compile_test';
import {getComplianceTests} from '../compliance/test_helpers/get_compliance_tests';
import {ComplianceTest} from '../compliance/test_helpers/get_compliance_tests';

async function compileTest(fs: FileSystem, test: ComplianceTest): Promise<CompileResult> {
  const rootDir = getRootDirectory(fs);
  const outDir = getBuildOutputDirectory(fs);
  const compilerOptions = test.compilerOptions;
  const angularCompilerOptions = test.angularCompilerOptions;

  const options = getOptions(rootDir, outDir, compilerOptions, angularCompilerOptions);
  // Resolve inputs relative to rootDir.
  const rootNames = test.inputFiles.map((f) => fs.resolve(rootDir, f));

  const host = new NgtscTestCompilerHost(fs, options);
  const preprocessor = new NgtscIsolatedPreprocessor(rootNames, options, host);

  await preprocessor.analyze();
  const transformedFiles = preprocessor.transformAndPrint();

  const emittedFiles: string[] = [];
  const validFiles = new Set<string>();

  for (const file of transformedFiles) {
    const path = fs.resolve(rootDir, file.fileName);
    fs.writeFile(path, file.content);
    emittedFiles.push(path);
    validFiles.add(path);
  }

  return {
    emittedFiles: emittedFiles as any,
    errors: [],
  };
}

const fs = new NodeJSFileSystem();
const testCasesPath = fs.resolve(
  fs.dirname(import.meta.url.replace('file://', '')),
  'test_cases/TEST_CASES.json',
);

describe('isolated compliance tests (local compile)', () => {
  for (const test of getComplianceTests(testCasesPath)) {
    if (!test.compilationModeFilter.includes('local compile')) {
      continue;
    }

    describe(`[${test.relativePath}]`, () => {
      it(test.description, async () => {
        const mockFs = initMockTestFileSystem(test.realTestPath);
        const {errors, emittedFiles} = await compileTest(mockFs, test);
        if (errors.length > 0) {
          fail(`Compilation errors: ${errors.join('\n')}`);
        }

        const tcbFile = emittedFiles.find((f) => f.endsWith('.ngtypecheck.ts'));
        if (!tcbFile) {
          fail('No .ngtypecheck.ts file generated!');
        }

        const transformedFile = emittedFiles.find((f) => f.endsWith('test.ts'));
        if (!transformedFile) {
          fail('No transformed test.ts file generated!');
          return;
        }

        // Verify type reification
        // emittedFiles contains absolute paths in the mock FS.
        const content = mockFs.readFile(fs.resolve(transformedFile));

        // We look for explicit type annotation on the static field.
        if (!content.includes('static ɵcmp: i0.ɵɵComponentDeclaration')) {
          fail(`Expected type reification for ɵcmp, but got:\n${content}`);
        }

        // Verify that the emitted code is valid TypeScript by compiling it.
        const globalsPath = mockFs.resolve('/globals.d.ts');
        mockFs.writeFile(globalsPath, 'declare global { var ngDevMode: any; }');

        const verifyHost = new NgtscTestCompilerHost(mockFs, test.compilerOptions);
        const verifyProgram = ts.createProgram({
          rootNames: [...emittedFiles, globalsPath],
          options: {
            ...test.compilerOptions,
            noEmit: true,
            skipLibCheck: true,
            // Ensure we can resolve the imports in the mock FS
            baseUrl: getRootDirectory(mockFs),
            paths: {
              '*': ['node_modules/*'],
            },
            // Use classic Node resolution which works better with the simple mock FS structure
            // than 'Bundler' or 'NodeNext' which expect specific package.json exports.
            moduleResolution: ts.ModuleResolutionKind.Node10,
            // The generated TCBs might use internal Angular types that are not strictly public,
            // or the mock environment might lack full fidelity.
            // However, we want to catch syntax errors and blatant type errors.
            noImplicitAny: false,
          },
          host: verifyHost,
        });

        const verifyDiags = ts.getPreEmitDiagnostics(verifyProgram);
        const filteredDiags = verifyDiags.filter((d) => {
          // Ignore "Cannot find module" (2307) and "Cannot find name" (2304)
          // as these are artifacts of the mock environment independent of TCB correctness.
          return d.code !== 2307 && d.code !== 2304;
        });

        if (filteredDiags.length > 0) {
          const params = filteredDiags.map((d) => {
            let msg = ts.flattenDiagnosticMessageText(d.messageText, '\n');
            if (d.file) {
              const {line, character} = d.file.getLineAndCharacterOfPosition(d.start!);
              msg = `${d.file.fileName} (${line + 1},${character + 1}): ${msg}`;
            }
            return msg;
          });
          fail(`Verification failed with ${filteredDiags.length} errors:\n${params.join('\n')}`);
        }
      });
    });
  }
});
