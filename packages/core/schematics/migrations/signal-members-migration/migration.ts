/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {ImportManager, PartialEvaluator} from '@angular/compiler-cli/private/migrations';
import {TypeScriptReflectionHost} from '@angular/compiler-cli/src/ngtsc/reflection';
import ts from 'typescript';
import {
  confirmAsSerializable,
  ProgramInfo,
  Replacement,
  Serializable,
  TsurgeComplexMigration,
} from '../../utils/tsurge';
import {applyImportManagerChanges} from '../../utils/tsurge/helpers/apply_import_manager';
import {
  ClassFieldDescriptor,
  ClassIncompatibilityReason,
  FieldIncompatibilityReason,
} from '../signal-migration/src';
// import {checkIncompatiblePatterns} from '../signal-migration/src/passes/problematic_patterns/common_incompatible_patterns';
import {migrateHostBindings} from '../signal-migration/src/passes/reference_migration/migrate_host_bindings';
import {migrateTemplateReferences} from '../signal-migration/src/passes/reference_migration/migrate_template_references';
import {migrateTypeScriptReferences} from '../signal-migration/src/passes/reference_migration/migrate_ts_references';
import {migrateTypeScriptTypeReferences} from '../signal-migration/src/passes/reference_migration/migrate_ts_type_references';
import {ReferenceMigrationHost} from '../signal-migration/src/passes/reference_migration/reference_migration_host';
import {createFindAllSourceFileReferencesVisitor} from '../signal-migration/src/passes/reference_resolution';
import {
  ClassFieldUniqueKey,
  KnownFields,
} from '../signal-migration/src/passes/reference_resolution/known_fields';
import {
  Reference,
} from '../signal-migration/src/passes/reference_resolution/reference_kinds';
import {ReferenceResult} from '../signal-migration/src/passes/reference_resolution/reference_result';
import {GroupedTsAstVisitor} from '../signal-migration/src/utils/grouped_ts_ast_visitor';
// import {InheritanceGraph} from '../signal-migration/src/utils/inheritance_graph';
import {MigrationConfig} from './migration_config';
import {
  markFieldIncompatibleInMetadata,
} from './incompatibility';
// import {insertTodoForIncompatibility} from '../signal-migration/src/passes/problematic_patterns/incompatibility_todos';

import {getAngularDecorators} from '@angular/compiler-cli/src/ngtsc/annotations';
import {getClassFieldDescriptorForSymbol, getUniqueIDForClassProperty} from '../signal-migration/src/utils/property_key';
import {isTemplateReference, isTsReference, ReferenceKind} from '../signal-migration/src/passes/reference_resolution/reference_kinds';


export interface MemberDescriptor {
  key: ClassFieldUniqueKey; // From signal-migration/src
  node: ts.PropertyDeclaration;
  name: string;
  primitiveType: 'string' | 'number' | 'boolean';
  initializer?: ts.Expression;
}

export interface CompilationUnitData {
  eligibleMembers: Record<ClassFieldUniqueKey, MemberDescriptor>;
  // Track members that are definitely NOT eligible to avoid re-processing
  ineligibleMembers: Record<ClassFieldUniqueKey, true>;
  // TODO: This was in the previous structure, evaluate if needed for members.
  problematicMembers: GlobalUnitData['problematicMembers'];
  reusableAnalysisReferences: Reference<MemberDescriptor>[] | null;
}

export interface GlobalUnitData {
  eligibleMembers: Record<ClassFieldUniqueKey, MemberDescriptor>;
  ineligibleMembers: Record<ClassFieldUniqueKey, true>;
  problematicMembers: Record<
    ClassFieldUniqueKey,
    {classReason: ClassIncompatibilityReason | null; fieldReason: FieldIncompatibilityReason | null}
  >;
  reusableAnalysisReferences: Reference<MemberDescriptor>[] | null;
}

export class SignalMembersMigration extends TsurgeComplexMigration<
  CompilationUnitData,
  GlobalUnitData
> {
  constructor(private readonly config: MigrationConfig = {}) {
    super();
  }

  override async analyze(info: ProgramInfo): Promise<Serializable<CompilationUnitData>> {
    const {templateTypeChecker} = info.ngCompiler?.['ensureAnalyzed']() ?? {
      templateTypeChecker: null,
    };
    const resourceLoader = info.ngCompiler?.['resourceManager'] ?? null;

    if (templateTypeChecker !== null) {
      templateTypeChecker.generateAllTypeCheckBlocks();
    }

    const {sourceFiles, program} = info;
    const checker = program.getTypeChecker();
    const reflector = new TypeScriptReflectionHost(checker);
    const evaluator = new PartialEvaluator(reflector, checker, null);

    const res: CompilationUnitData = {
      eligibleMembers: {},
      ineligibleMembers: {},
      problematicMembers: {}, // Initialize problematicMembers
      reusableAnalysisReferences: null,
    };

    const groupedAstVisitor = new GroupedTsAstVisitor(sourceFiles);

    // Visitor to find member declarations
    const findMemberDeclarationsVisitor = (node: ts.Node) => {
      if (ts.isClassDeclaration(node)) {
        const isAngularComponent = reflector.getDecoratorsOfDeclaration(node)?.some(
          (decorator) => decorator.name === 'Component' && decorator.import?.from === '@angular/core',
        );

        if (isAngularComponent) {
          for (const member of node.members) {
            if (ts.isPropertyDeclaration(member)) {
              const propertyNode = member;
              const key = getUniqueIDForClassProperty(propertyNode, info);
              if (key === null) {
                continue;
              }

              // Prevent re-processing if already marked ineligible.
              if (res.ineligibleMembers[key]) {
                continue;
              }

              const type = checker.getTypeAtLocation(propertyNode.name);
              let primitiveType: MemberDescriptor['primitiveType'] | null = null;

              if (type.flags & ts.TypeFlags.StringLike) {
                primitiveType = 'string';
              } else if (type.flags & ts.TypeFlags.NumberLike) {
                primitiveType = 'number';
              } else if (type.flags & ts.TypeFlags.BooleanLike) {
                primitiveType = 'boolean';
              }

              if (primitiveType) {
                res.eligibleMembers[key] = {
                  key,
                  node: propertyNode,
                  name: propertyNode.name.getText(),
                  primitiveType,
                  initializer: propertyNode.initializer,
                };
              } else {
                res.ineligibleMembers[key] = true;
                // If it was previously eligible, remove it.
                delete res.eligibleMembers[key];
              }
            }
          }
        }
      }
      ts.forEachChild(node, findMemberDeclarationsVisitor);
    };

    this.config.reportProgressFn?.(20, 'Scanning for member declarations..');
    sourceFiles.forEach((sf) => ts.forEachChild(sf, findMemberDeclarationsVisitor));

    // Reference Analysis
    this.config.reportProgressFn?.(40, 'Analyzing member references..');
    const referenceResult: ReferenceResult<MemberDescriptor> = {references: []};
    const potentiallyEligibleKeys = new Set(Object.keys(res.eligibleMembers));

    if (potentiallyEligibleKeys.size === 0) {
      // No eligible members, skip reference analysis.
      return confirmAsSerializable(res);
    }

    const knownFields: KnownFields<MemberDescriptor> = {
      shouldTrackClassReference: (node: ts.ClassDeclaration) =>
        reflector.isClass(node) &&
        reflector
          .getDecoratorsOfDeclaration(node)
          ?.some((d) => d.name === 'Component' && d.import?.from === '@angular/core'),
      attemptRetrieveDescriptorFromSymbol: (symbol: ts.Symbol) => {
        // getClassFieldDescriptorForSymbol expects ClassFieldDescriptor, but we are working with MemberDescriptor
        // We need a way to get MemberDescriptor from a symbol, or adapt this.
        // For now, assuming `getClassFieldDescriptorForSymbol` can give us the `key` and `node`.
        const classFieldDesc = getClassFieldDescriptorForSymbol(symbol, info);
        if (classFieldDesc && potentiallyEligibleKeys.has(classFieldDesc.key)) {
          // We need to ensure that the descriptor returned is of type MemberDescriptor.
          // If eligibleMembers stores MemberDescriptor, we can retrieve it.
          return res.eligibleMembers[classFieldDesc.key as ClassFieldUniqueKey];
        }
        return null;
      },
    };

    const findAllReferencesVisitor = createFindAllSourceFileReferencesVisitor(
      info,
      checker,
      reflector,
      resourceLoader,
      evaluator,
      templateTypeChecker,
      knownFields,
      // Create a set of names of potentially eligible members for optimization
      new Set(
        Object.values(res.eligibleMembers).map((desc: MemberDescriptor) => desc.name),
      ),
      referenceResult,
    ).visitor;

    groupedAstVisitor.register(findAllReferencesVisitor);
    groupedAstVisitor.execute();

    for (const ref of referenceResult.references) {
      const memberKey = ref.target.key;

      // If already marked ineligible by a previous reference, skip.
      if (res.ineligibleMembers[memberKey]) {
        continue;
      }

      let isExternalReference = false;
      const targetComponentFile = ref.target.node.getSourceFile();

      if (isTsReference(ref)) {
        const refLocationNode = ref.from.node;
        const refFile = refLocationNode.getSourceFile();

        if (refFile !== targetComponentFile) {
          isExternalReference = true;
        } else {
          // Check if the reference is outside the class declaration block
          let parent = refLocationNode.parent;
          let withinClassScope = false;
          while (parent) {
            if (parent === ref.target.node.parent) { // ref.target.node.parent is the ClassDeclaration
              withinClassScope = true;
              break;
            }
            parent = parent.parent;
          }
          if (!withinClassScope) {
            isExternalReference = true;
          }
        }
      } else if (isTemplateReference(ref)) {
        // Template references are generally considered within the component's scope.
        // However, if the template is external (separate HTML file),
        // `ref.from.node.getSourceFile()` might differ.
        // For now, we assume template references are not "external" in a way that makes them ineligible.
        // More sophisticated checks could be added if e.g. a template variable is exported somehow.
      } else if (ref.kind === ReferenceKind.HostBinding) {
        // Host binding references are within the component's scope.
      } else {
        // Other kinds of references might exist, treat them cautiously or add specific handling.
        // For now, assume unhandled reference kinds might be external if files differ.
        if (ref.from.node.getSourceFile() !== targetComponentFile) {
           isExternalReference = true;
        }
      }


      if (isExternalReference) {
        res.ineligibleMembers[memberKey] = true;
        delete res.eligibleMembers[memberKey];
      }
    }
    this.config.reportProgressFn?.(80, 'Finalizing analysis..');


    if (this.config.assumeNonBatch) {
      // Ensure that reusableAnalysisReferences stores MemberDescriptor
      res.reusableAnalysisReferences = referenceResult.references.filter(
         (ref): ref is Reference<MemberDescriptor> => ref.target !== null && res.eligibleMembers[ref.target.key] !== undefined
      );
    }

    return confirmAsSerializable(res);
  }

  override async combine(
    unitA: CompilationUnitData,
    unitB: CompilationUnitData,
  ): Promise<Serializable<CompilationUnitData>> {
    const combined: CompilationUnitData = {
      knownMembers: {},
      problematicMembers: {},
      reusableAnalysisReferences: null,
    };

    for (const unit of [unitA, unitB]) {
      for (const [id, value] of Object.entries(unit.knownMembers)) {
        combined.knownMembers[id as ClassFieldUniqueKey] = value;
      }

      for (const [id, info] of Object.entries(unit.problematicMembers)) {
        if (info.fieldReason !== null) {
          markFieldIncompatibleInMetadata(
            combined.problematicMembers,
            id as ClassFieldUniqueKey,
            info.fieldReason,
          );
        }
        if (info.classReason !== null) {
          combined.problematicMembers[id as ClassFieldUniqueKey] ??= {
            classReason: null,
            fieldReason: null,
          };
          combined.problematicMembers[id as ClassFieldUniqueKey].classReason = info.classReason;
        }
      }

      if (unit.reusableAnalysisReferences !== null) {
        combined.reusableAnalysisReferences = unit.reusableAnalysisReferences;
      }
    }
    return confirmAsSerializable(combined);
  }

  override async globalMeta(
    combinedData: CompilationUnitData,
  ): Promise<Serializable<GlobalUnitData>> {
    const globalUnitData: GlobalUnitData = {
      // Correctly map from CompilationUnitData to GlobalUnitData
      eligibleMembers: combinedData.eligibleMembers,
      ineligibleMembers: combinedData.ineligibleMembers,
      problematicMembers: combinedData.problematicMembers,
      reusableAnalysisReferences: combinedData.reusableAnalysisReferences,
    };
    return confirmAsSerializable(globalUnitData);
  }

  override async migrate(globalMetadata: GlobalUnitData, info: ProgramInfo) {
    const {program, sourceFiles, checker, reflector, evaluator, templateTypeChecker, resourceLoader} =
      info;
    const replacements: Replacement[] = [];
    const importManager = new ImportManager();
    const printer = ts.createPrinter();

    this.config.reportProgressFn?.(0, 'Starting migration of members...');

    let membersMigratedCount = 0;
    const totalEligibleMembers = Object.keys(globalMetadata.eligibleMembers).length;

    for (const memberKey in globalMetadata.eligibleMembers) {
      const memberDescriptor = globalMetadata.eligibleMembers[memberKey as ClassFieldUniqueKey];

      const originalSourceFile = program.getSourceFile(
        memberDescriptor.node.getSourceFile().fileName,
      );
      if (!originalSourceFile) {
        console.warn(`Could not find source file ${memberDescriptor.node.getSourceFile().fileName} in current program.`);
        continue;
      }

      let currentPropertyNode: ts.PropertyDeclaration | undefined = undefined;
      originalSourceFile.forEachChild(function visit(node) {
        if (currentPropertyNode) return; // Already found
        if (ts.isClassDeclaration(node) && node.name?.getText() === memberDescriptor.node.parent.name?.getText()) {
          node.members.forEach((m) => {
            if (ts.isPropertyDeclaration(m) && m.name.getText() === memberDescriptor.name) {
              currentPropertyNode = m;
            }
          });
        }
        if (!currentPropertyNode) {
          ts.forEachChild(node, visit);
        }
      });

      if (!currentPropertyNode) {
        console.warn(`Could not re-find property node ${memberDescriptor.name} in class ${memberDescriptor.node.parent.name?.getText()}. Skipping.`);
        continue;
      }

      // 1. Transform Property Declaration
      const owningSourceFile = currentPropertyNode.getSourceFile();
      importManager.addImportToSourceFile(owningSourceFile, 'signal', '@angular/core');

      const newInitializer = memberDescriptor.initializer
        ? memberDescriptor.initializer.getText()
        : 'undefined';
      const signalCall = `signal(${newInitializer})`;
      const modifiers = ts.getModifiers(currentPropertyNode)?.map((m) => m.getText()).join(' ') ?? '';
      const newDeclaration = `${modifiers} ${memberDescriptor.name} = ${signalCall};`;

      replacements.push(
        Replacement.replace(
          owningSourceFile,
          currentPropertyNode.getStart(),
          currentPropertyNode.getWidth(),
          newDeclaration,
        ),
      );

      // 2. Migrate References
      const referenceResult: ReferenceResult<MemberDescriptor> = {references: []};
      const knownFieldsForCurrentMember: KnownFields<MemberDescriptor> = {
        shouldTrackClassReference: (node: ts.ClassDeclaration) =>
          node.name?.getText() === currentPropertyNode!.parent.name?.getText(),
        attemptRetrieveDescriptorFromSymbol: (symbol: ts.Symbol) => {
          const desc = getClassFieldDescriptorForSymbol(symbol, info);
          if (desc && desc.key === memberDescriptor.key) {
            return memberDescriptor;
          }
          return null;
        },
      };

      // We need to scan all source files where this component and its templates might be.
      // For TS files, it's usually just the component's own file.
      // For templates, it could be an external file or inline.
      const filesToScan: ts.SourceFile[] = [owningSourceFile];
      if (templateTypeChecker && resourceLoader) {
        const componentClass = currentPropertyNode.parent as ts.ClassDeclaration;
        const templateResource = reflector.getComponentResources(componentClass);
        if (templateResource && templateResource.template !== null && typeof templateResource.template === 'string') {
            const templateFile = program.getSourceFile(templateResource.template);
            if (templateFile) {
                filesToScan.push(templateFile);
            }
        }
      }


      const groupedVisitor = new GroupedTsAstVisitor(filesToScan);
      groupedVisitor.register(
        createFindAllSourceFileReferencesVisitor(
          info,
          checker,
          reflector,
          resourceLoader,
          evaluator,
          templateTypeChecker,
          knownFieldsForCurrentMember,
          new Set([memberDescriptor.name]),
          referenceResult,
        ).visitor,
      );
      groupedVisitor.execute();

      for (const ref of referenceResult.references) {
        const refSourceFile = ref.from.node.getSourceFile() ?? program.getSourceFile(ref.from.file);
        if (!refSourceFile) continue;

        if (isTsReference(ref)) {
          if (!ref.from.isWrite) {
            // TS Read
            replacements.push(Replacement.add(refSourceFile, ref.from.node.getEnd(), '()'));
          } else {
            // TS Write
            const assignment = ref.from.node.parent;
            if (
              ts.isBinaryExpression(assignment) &&
              assignment.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ) {
              const rhs = assignment.right.getText();
              replacements.push(
                Replacement.replace(
                  refSourceFile,
                  assignment.getStart(),
                  assignment.getWidth(),
                  `${ref.from.node.getText()}.set(${rhs})`,
                ),
              );
            } else {
                // Handle other types of writes if necessary (e.g., ++, --, or updates in method calls)
                // For now, we can add a TODO or log a warning for unhandled write patterns.
                 console.warn(`Unhandled TS write pattern for ${memberDescriptor.name} in ${refSourceFile.fileName}`);
            }
          }
        } else if (isTemplateReference(ref)) {
          if (!ref.from.isWrite) {
            // Template Read
            replacements.push(
              Replacement.add(ref.from.file, ref.from.nodeInfo.node.sourceSpan.end, '()'),
            );
          } else {
            // Template writes are usually through event bindings calling methods.
            // The method in the component would then call .set().
            // Direct assignment in template `${foo = bar}` is not standard Angular.
            console.warn(`Unhandled template write pattern for ${memberDescriptor.name} in ${ref.from.file}. Template writes should typically go through methods.`);
          }
        }
      }
      membersMigratedCount++;
      this.config.reportProgressFn?.(Math.round((membersMigratedCount / totalEligibleMembers) * 80) + 10, // Progress from 10% to 90%
         `Migrated ${memberDescriptor.name} (${membersMigratedCount}/${totalEligibleMembers})`);
    }

    this.config.reportProgressFn?.(95, 'Applying import changes...');
    applyImportManagerChanges(importManager, replacements, sourceFiles, info);

    this.config.reportProgressFn?.(100, 'Migration complete.');
    return {replacements};
  }

  override async stats(globalMetadata: GlobalUnitData) {
    let membersCount = 0;
    let incompatibleMembers = 0;

    const fieldIncompatibleCounts: Partial<Record<`incompat-field-${string}`, number>> = {};
    const classIncompatibleCounts: Partial<Record<`incompat-class-${string}`, number>> = {};

    for (const _member of Object.values(globalMetadata.knownMembers)) {
      membersCount++;
      // Add any specific member type counting if needed
    }

    for (const [id, info] of Object.entries(globalMetadata.problematicMembers)) {
      if (globalMetadata.knownMembers[id as ClassFieldUniqueKey] === undefined) {
        continue;
      }

      // TODO: Adapt best-effort mode logic if necessary
      // if (
      //   this.config.bestEffortMode &&
      //   (info.fieldReason === null ||
      //     !nonIgnorableFieldIncompatibilities.includes(info.fieldReason))
      // ) {
      //   continue;
      // }

      incompatibleMembers++;

      if (info.classReason !== null) {
        const reasonName = ClassIncompatibilityReason[info.classReason];
        const key = `incompat-class-${reasonName}` as const;
        classIncompatibleCounts[key] ??= 0;
        classIncompatibleCounts[key]++;
      }

      if (info.fieldReason !== null) {
        const reasonName = FieldIncompatibilityReason[info.fieldReason];
        const key = `incompat-field-${reasonName}` as const;
        fieldIncompatibleCounts[key] ??= 0;
        fieldIncompatibleCounts[key]++;
      }
    }

    return confirmAsSerializable({
      membersCount,
      incompatibleMembers,
      ...fieldIncompatibleCounts,
      ...classIncompatibleCounts,
    });
  }
}
