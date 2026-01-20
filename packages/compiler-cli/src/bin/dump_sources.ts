#!/usr/bin/env node
/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import 'reflect-metadata';
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import {NodeJSFileSystem, setFileSystem} from '../ngtsc/file_system';
import {readNgcCommandLineAndConfiguration} from '../main';
import * as api from '../transformers/api';

import {createCompilerHost, createProgram} from '../transformers/entry_points';
import {NgtscProgram} from '../ngtsc/program';

async function main() {
  process.title = 'Angular Source Dumper';
  setFileSystem(new NodeJSFileSystem());

  const args = process.argv.slice(2);
  let dumpDir = 'dump_output';

  const dumpDirIndex = args.indexOf('--dumpDir');
  if (dumpDirIndex > -1 && dumpDirIndex + 1 < args.length) {
    dumpDir = args[dumpDirIndex + 1];
  }

  // Filter out --dumpDir so it doesn't confuse the ngc config reader
  const configArgs = args.filter((arg, i) => arg !== '--dumpDir' && args[i - 1] !== '--dumpDir');

  const config = readNgcCommandLineAndConfiguration(configArgs);

  if (config.errors.length) {
    console.error(
      ts.formatDiagnostics(config.errors, {
        getCurrentDirectory: () => ts.sys.getCurrentDirectory(),
        getCanonicalFileName: (f) => f,
        getNewLine: () => '\n',
      }),
    );
    process.exit(1);
  }

  const cwd = process.cwd();
  console.log(`Dumping sources to ${dumpDir}...`);

  const emitCallback: api.TsEmitCallback<ts.EmitResult> = ({
    targetSourceFile,
    customTransformers,
  }) => {
    if (!targetSourceFile) {
      return {diagnostics: [], emitSkipped: true, emittedFiles: []};
    }

    // Skip node_modules
    if (targetSourceFile.fileName.includes('node_modules')) {
      return {diagnostics: [], emitSkipped: true, emittedFiles: []};
    }

    // Calculate path relative to CWD to preserve structure
    const relativePath = path.relative(cwd, targetSourceFile.fileName);

    if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
      // Skip files outside of the current project root to be safe
      return {diagnostics: [], emitSkipped: true, emittedFiles: []};
    }

    const outputPath = path.join(dumpDir, relativePath);
    const outputDir = path.dirname(outputPath);

    fs.mkdirSync(outputDir, {recursive: true});

    // Transform and print
    const transformers = (customTransformers?.before ||
      []) as ts.TransformerFactory<ts.SourceFile>[];
    const result = ts.transform(targetSourceFile, transformers);

    const printer = ts.createPrinter();
    for (const transformedNode of result.transformed) {
      const content = printer.printFile(transformedNode);
      fs.writeFileSync(outputPath, content);
    }
    result.dispose();

    return {diagnostics: [], emitSkipped: false, emittedFiles: []};
  };

  const host = createCompilerHost({options: config.options});
  const program = createProgram({
    rootNames: config.rootNames,
    host,
    options: {...config.options, _enableTemplateTypeChecker: true},
  }) as NgtscProgram;
  program.compiler.getTemplateTypeChecker().generateAllTypeCheckBlocks();

  program.emit({
    emitCallback,
    forceEmit: true, // Dump even if there are errors
  });

  console.log(`Dump completed.`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
