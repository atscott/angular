/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import {
  confirmAsSerializable,
  ProgramInfo,
  Replacement,
  Serializable,
  TsurgeFunnelMigration,
  TextUpdate,
  ProjectFile,
  projectFile,
} from '../../utils/tsurge';
import ts from 'typescript';
import {PartialEvaluator, Reference, ImportManager} from '@angular/compiler-cli/private/migrations';
import {TypeScriptReflectionHost} from '@angular/compiler-cli/src/ngtsc/reflection';
import {applyImportManagerChanges} from '../../utils/tsurge/helpers/apply_import_manager';
import {getAngularDecorators} from '@angular/compiler-cli/src/ngtsc/annotations';
import {findLiteralProperty} from '../../utils/typescript/property_name';
import {getRelativePath} from '../../utils/typescript/imports';

interface CompilationUnitData {
  replacements: Replacement[];
}

export class BootstrapOptionsMigration extends TsurgeFunnelMigration<
  CompilationUnitData,
  CompilationUnitData
> {
  override async analyze(info: ProgramInfo): Promise<Serializable<CompilationUnitData>> {
    const replacements: Replacement[] = [];
    const checker = info.program.getTypeChecker();
    const reflector = new TypeScriptReflectionHost(checker);
    const evaluator = new PartialEvaluator(reflector, checker, null);
    const importManager = new ImportManager();
    const hasExistingChangeDetectionProvider = hasChangeDetectionProviderInProgram(
      info.program,
      checker,
    );

    for (const sourceFile of info.program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile) {
        continue;
      }

      ts.forEachChild(sourceFile, function walk(node) {
        if (ts.isCallExpression(node)) {
          const isBootstrapModule =
            ts.isPropertyAccessExpression(node.expression) &&
            node.expression.name.text === 'bootstrapModule';
          const isBootstrapApplication =
            ts.isIdentifier(node.expression) && node.expression.text === 'bootstrapApplication';

          if (isBootstrapModule) {
            const moduleType = evaluator.evaluate(node.arguments[0]);

            if (!(moduleType instanceof Reference) || !ts.isClassDeclaration(moduleType.node)) {
              return;
            }

            const moduleClass = moduleType.node;
            const moduleSourceFile = moduleClass.getSourceFile();
            const moduleProjectFile = projectFile(moduleSourceFile, info);
            const ngModule = findNgModule(moduleClass, reflector);
            if (!ngModule) {
              return;
            }

            // Always remove the options argument
            replacements.push(
              new Replacement(
                projectFile(sourceFile, info),
                new TextUpdate({
                  position: node.arguments[0].getEnd(),
                  end: node.getEnd() - 1,
                  toInsert: '',
                }),
              ),
            );

            if (hasExistingChangeDetectionProvider) {
              return;
            }

            importManager.addImport({
              exportModuleSpecifier: '@angular/core',
              exportSymbolName: 'provideZoneChangeDetection',
              requestedFile: moduleSourceFile,
            });

            const optionsNode = node.arguments[1];
            const options =
              optionsNode && ts.isObjectLiteralExpression(optionsNode)
                ? evaluator.evaluate(optionsNode)
                : null;

            let zoneCdProvider = `provideZoneChangeDetection()`;
            let zoneInstanceProvider: string | null = null;

            if (options instanceof Map) {
              const ngZoneOption = options.get('ngZone');
              if (options.has('ngZoneRunCoalescing') || options.has('ngZoneEventCoalescing')) {
                const config: string[] = [];
                if (options.get('ngZoneRunCoalescing')) {
                  config.push('runCoalescing: true');
                }
                if (options.get('ngZoneEventCoalescing')) {
                  config.push('eventCoalescing: true');
                }
                zoneCdProvider = `provideZoneChangeDetection(${config.length > 0 ? `{ ${config.join(', ')} }` : ''})`;
              }

              if (ngZoneOption instanceof Reference) {
                importManager.addImport({
                  exportModuleSpecifier: '@angular/core',
                  exportSymbolName: 'NgZone',
                  requestedFile: moduleSourceFile,
                });
                const clazz = ngZoneOption.node;
                if (ts.isClassDeclaration(clazz) && clazz.name) {
                  const customZoneSourceFile = clazz.getSourceFile();
                  const exportModuleSpecifier =
                    ngZoneOption.bestGuessOwningModule?.specifier ??
                    getRelativePath(moduleSourceFile.fileName, customZoneSourceFile.fileName);
                  importManager.addImport({
                    exportModuleSpecifier,
                    exportSymbolName: clazz.name.text,
                    requestedFile: moduleSourceFile,
                  });

                  zoneInstanceProvider = `{provide: NgZone, useClass: ${clazz.name.text}}`;
                }
              } else if (typeof ngZoneOption === 'string' && ngZoneOption === 'noop') {
                importManager.addImport({
                  exportModuleSpecifier: '@angular/core',
                  exportSymbolName: 'NgZone',
                  requestedFile: moduleSourceFile,
                });
                importManager.addImport({
                  exportModuleSpecifier: '@angular/core',
                  exportSymbolName: 'ɵNoopNgZone',
                  requestedFile: moduleSourceFile,
                });
                zoneInstanceProvider = `{provide: NgZone, useClass: ɵNoopNgZone}`;
              }
            }

            const providers = [zoneCdProvider];
            if (zoneInstanceProvider) {
              providers.push(zoneInstanceProvider);
            }

            if (providers.length > 0) {
              addProvidersToNgModule(
                moduleProjectFile,
                ngModule,
                providers.join(',\n'),
                replacements,
              );
            }
          } else if (isBootstrapApplication) {
            if (hasExistingChangeDetectionProvider) {
              return;
            }

            importManager.addImport({
              exportModuleSpecifier: '@angular/core',
              exportSymbolName: 'provideZoneChangeDetection',
              requestedFile: sourceFile,
            });

            const providersText = 'provideZoneChangeDetection()';
            const optionsNode = node.arguments[1];
            const currentProjectFile = projectFile(sourceFile, info);

            if (optionsNode) {
              if (ts.isObjectLiteralExpression(optionsNode)) {
                addProvidersToApplicationConfig(
                  currentProjectFile,
                  optionsNode,
                  providersText,
                  replacements,
                );
              } else {
                // Not handling identifiers for options for now.
                // TODO: this _has_ to be done. The CLI generates apps with appConfig in separate file.
              }
            } else {
              // No options object, add it.
              const text = `, {providers: [${providersText}]}`;
              replacements.push(
                new Replacement(
                  currentProjectFile,
                  new TextUpdate({
                    position: node.arguments[0].getEnd(),
                    end: node.arguments[0].getEnd(),
                    toInsert: text,
                  }),
                ),
              );
            }
          }
        }
        ts.forEachChild(node, walk);
      });
    }
    applyImportManagerChanges(importManager, replacements, info.sourceFiles, info);
    return confirmAsSerializable({replacements});
  }

  override async combine(
    unitA: CompilationUnitData,
    unitB: CompilationUnitData,
  ): Promise<Serializable<CompilationUnitData>> {
    return confirmAsSerializable({
      replacements: [...unitA.replacements, ...unitB.replacements],
    });
  }

  override async globalMeta(data: CompilationUnitData): Promise<Serializable<CompilationUnitData>> {
    return confirmAsSerializable(data);
  }

  override async stats(data: CompilationUnitData) {
    return confirmAsSerializable({});
  }

  override async migrate(data: CompilationUnitData) {
    return {replacements: data.replacements};
  }
}

function addProvidersToNgModule(
  projectFile: ProjectFile,
  ngModule: ts.ObjectLiteralExpression,
  providersText: string,
  replacements: Replacement[],
) {
  const sourceFile = ngModule.getSourceFile();
  const newModuleText = `@NgModule({ providers: [ ${providersText} ] })
export class ZoneChangeDetectionModule {}`;

  replacements.push(
    new Replacement(
      projectFile,
      new TextUpdate({
        position: sourceFile.getEnd(),
        end: sourceFile.getEnd(),
        toInsert: newModuleText,
      }),
    ),
  );

  const importsNode = findLiteralProperty(ngModule, 'imports');
  if (importsNode && ts.isPropertyAssignment(importsNode)) {
    if (ts.isArrayLiteralExpression(importsNode.initializer)) {
      const initializer = importsNode.initializer;
      const text = `ZoneChangeDetectionModule,`;
      replacements.push(
        new Replacement(
          projectFile,
          new TextUpdate({
            position: initializer.elements[0]?.getStart() ?? initializer.getEnd() - 1,
            end: initializer.elements[0]?.getStart() ?? initializer.getEnd() - 1,
            toInsert: text,
          }),
        ),
      );
    } else if (ts.isIdentifier(importsNode.initializer)) {
      const newImports = `[ZoneChangeDetectionModule, ...${importsNode.initializer.text}]`;
      replacements.push(
        new Replacement(
          projectFile,
          new TextUpdate({
            position: importsNode.initializer.getStart(),
            end: importsNode.initializer.getEnd(),
            toInsert: newImports,
          }),
        ),
      );
    }
  } else {
    const text = `imports: [ZoneChangeDetectionModule]`;
    let toInsert = `${text},\n`;
    let position = ngModule.getStart() + 1;

    if (ngModule.properties.length > 0) {
      const firstProperty = ngModule.properties[0];
      position = firstProperty.getStart();
    }
    replacements.push(
      new Replacement(
        projectFile,
        new TextUpdate({
          position,
          end: position,
          toInsert,
        }),
      ),
    );
  }
}

function addProvidersToApplicationConfig(
  projectFile: ProjectFile,
  optionsNode: ts.ObjectLiteralExpression,
  providersText: string,
  replacements: Replacement[],
) {
  const providersProp = findLiteralProperty(optionsNode, 'providers');
  if (providersProp && ts.isPropertyAssignment(providersProp)) {
    if (ts.isArrayLiteralExpression(providersProp.initializer)) {
      const initializer = providersProp.initializer;
      const text = `${providersText},`;
      replacements.push(
        new Replacement(
          projectFile,
          new TextUpdate({
            position: initializer.elements[0]?.getStart() ?? initializer.getEnd() - 1,
            end: initializer.elements[0]?.getStart() ?? initializer.getEnd() - 1,
            toInsert: text,
          }),
        ),
      );
    } else if (ts.isIdentifier(providersProp.initializer)) {
      const newProviders = `[${providersText}, ...${providersProp.initializer.text}]`;
      replacements.push(
        new Replacement(
          projectFile,
          new TextUpdate({
            position: providersProp.initializer.getStart(),
            end: providersProp.initializer.getEnd(),
            toInsert: newProviders,
          }),
        ),
      );
    }
  } else {
    const text = `providers: [${providersText}]`;
    let toInsert: string;
    let position: number;

    if (optionsNode.properties.length > 0) {
      const lastProperty = optionsNode.properties[optionsNode.properties.length - 1];
      toInsert = `,\n  ${text}`;
      position = lastProperty.getEnd();
    } else {
      toInsert = `\n  ${text}\n`;
      position = optionsNode.getStart() + 1;
    }
    replacements.push(
      new Replacement(
        projectFile,
        new TextUpdate({
          position,
          end: position,
          toInsert,
        }),
      ),
    );
  }
}

function findNgModule(
  node: ts.ClassDeclaration,
  reflector: TypeScriptReflectionHost,
): ts.ObjectLiteralExpression | null {
  const decorators = reflector.getDecoratorsOfDeclaration(node);
  if (decorators) {
    const ngModuleDecorator = getAngularDecorators(decorators, ['NgModule'], true)[0];
    if (
      ngModuleDecorator &&
      ngModuleDecorator.args &&
      ngModuleDecorator.args.length > 0 &&
      ts.isObjectLiteralExpression(ngModuleDecorator.args[0])
    ) {
      return ngModuleDecorator.args[0];
    }
  }
  return null;
}

function hasChangeDetectionProviderInProgram(
  program: ts.Program,
  checker: ts.TypeChecker,
): boolean {
  for (const sourceFile of program.getSourceFiles()) {
    if (sourceFile.isDeclarationFile) {
      continue;
    }

    let hasProvider = false;
    ts.forEachChild(sourceFile, function walk(node) {
      if (hasProvider) {
        return;
      }
      if (ts.isCallExpression(node)) {
        const symbol = checker.getSymbolAtLocation(node.expression);
        if (
          symbol &&
          (symbol.name === 'provideZoneChangeDetection' ||
            symbol.name === 'provideZonelessChangeDetection')
        ) {
          hasProvider = true;
        }
      }
      if (!hasProvider) {
        ts.forEachChild(node, walk);
      }
    });

    if (hasProvider) {
      return true;
    }
  }
  return false;
}
