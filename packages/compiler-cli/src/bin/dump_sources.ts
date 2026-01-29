#!/usr/bin/env node
import 'reflect-metadata';
import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import {NgtscIsolatedPreprocessor} from '../ngtsc/preprocessor';
import {NodeJSFileSystem, setFileSystem} from '../ngtsc/file_system';
import {readConfiguration} from '../perform_compile';

async function main() {
  setFileSystem(new NodeJSFileSystem());

  const args = process.argv.slice(2);
  let projectPath = '.';
  let dumpDir = 'output';

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '-p') projectPath = args[++i];
    if (args[i] === '--dumpDir') dumpDir = args[++i];
  }

  console.log(`Project: ${projectPath}`);
  console.log(`Dump Dir: ${dumpDir}`);

  const config = readConfiguration(projectPath);
  const options = config.options;
  const rootNames = config.rootNames;

  const preprocessor = new NgtscIsolatedPreprocessor(
    rootNames,
    options,
    ts.createCompilerHost(options),
  );

  await preprocessor.analyze();
  const results = preprocessor.transformAndPrint();

  if (!fs.existsSync(dumpDir)) {
    fs.mkdirSync(dumpDir, {recursive: true});
  }

  for (const res of results) {
    // Naive relative path calculation, might need adjustment based on rootDir
    const relative = path.relative(process.cwd(), res.fileName);
    const outPath = path.join(dumpDir, relative);
    fs.mkdirSync(path.dirname(outPath), {recursive: true});
    fs.writeFileSync(outPath, res.content);
    console.log(`Written ${outPath}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
