/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {AngularCompilerOptions} from '@angular/compiler-cli';
import {RegistryDomSchemaChecker} from './dom_schema_checker.js';
import {
  generateTypeCheckBlock,
  isUnsafeObjectKey,
  R3Identifiers,
  TcbExpr,
  TmplAstNode,
  SchemaMetadata,
  TmplAstHostElement,
  BoundTarget,
  TypeCheckingConfig,
  TypeCheckId,
  TcbReferenceMetadata,
  TcbReferenceKey,
  TcbDirectiveMetadata,
  TcbComponentMetadata,
  TcbTypeCheckBlockMetadata,
  TcbEnvironment,
  TcbTypeParameter,
  TypeCtorMetadata,
} from '@angular/compiler';
import {Diagnostic} from './diagnostic.js';

import MagicString from 'magic-string';

import * as nga from './types.js';
import {adaptTcbInput, ExtendedTcbTypeParameter} from './tcb_adapter.js';
import {OutOfBandDiagnosticRecorderImpl} from './oob.js';
import {makeClassKey} from './compiler-utils.js';
import {requiresInlineDeclaration, requiresInlineTypeCheckBlock} from './tcb_util.js';

// TODO(atscott): Export `Reference` from `@angular/compiler-cli` to avoid this local definition.
// Reference is not exported from tooling, so we define a compatible interface for the emit signature.
interface Reference<T> {
  node: T;
}
// TODO(atscott): Export TcbPipeMetadata from @angular/compiler-cli
export interface TcbPipeMetadata {
  name: string;
  ref: TcbReferenceMetadata;
  isExplicitlyDeferred: boolean;
  deferredBlocks?: Set<string> | null;
}

export interface TcbTargetInput {
  classMeta: nga.ClassMetadata;
  className: string;
  template: string;
  templateNodes: TmplAstNode[];
  declarations: nga.DeclarationMetadata[];
  ownDeclaration: nga.DeclarationMetadata;
  hostProperties: nga.HostPropertyMetadata[];
  hostBindings: nga.HostBindingMetadata[];
  hostListeners: nga.HostListenerMetadata[];
  isStandalone: boolean;
  schemas: SchemaMetadata[];
  typeParameters: nga.TypeParameterMetadata[] | null;
  pipeRegistry: Map<string, PipeMeta> | null;
  enableSelectorless?: boolean;
  selectorlessEnabled?: boolean;
}

export interface PreparedTcbTarget {
  comp: TcbTargetInput;
  typeCheckId: TypeCheckId;
  tcbMeta: TcbTypeCheckBlockMetadata;
  targetMeta: TcbComponentMetadata;
}

export interface PreparedTcbData {
  targets: PreparedTcbTarget[];
  boundTargetMap: Map<string, BoundTarget<TcbDirectiveMetadata>>;
  hostElementsMap: Map<string, TmplAstHostElement | null>;
  typeCheckIdMap: Map<string, TypeCheckId>;
  requiresInline: boolean;
}

export interface TcbResult {
  code: string;
  imports?: string;
  // classKey -> TCB code
  tcbMap: Map<string, string>;
  diagnostics: Diagnostic[];
  isInline: boolean;
}

export interface PipeMeta {
  name: string;
  className: string;
  importPath?: string;
  filePath?: string;
  isExported?: boolean;
  hasNonExportedBounds?: boolean;
  isExplicitlyDeferred?: boolean;
  deferredBlocks?: string[];
}

export interface NgpTypeCheckingConfig extends TypeCheckingConfig {
  typeCheckHostBindings?: boolean;
}

export function buildTypeCheckingConfig(
  options: AngularCompilerOptions = {},
  enableTemplateTypeChecker: boolean = false,
): NgpTypeCheckingConfig {
  const strictTemplates = options.strictTemplates !== false;

  let typeCheckingConfig: NgpTypeCheckingConfig;
  if (strictTemplates) {
    typeCheckingConfig = {
      applyTemplateContextGuards: true,
      checkQueries: false,
      checkTemplateBodies: true,
      alwaysCheckSchemaInTemplateBodies: true,
      checkTypeOfInputBindings: true,
      honorAccessModifiersForInputBindings: false,
      checkControlFlowBodies: true,
      strictNullInputBindings: true,
      checkTypeOfAttributes: true,
      checkTypeOfDomBindings: false,
      checkTypeOfOutputEvents: true,
      checkTypeOfAnimationEvents: true,
      checkTypeOfDomEvents: true,
      checkTypeOfDomReferences: true,
      checkTypeOfNonDomReferences: true,
      checkTypeOfPipes: true,
      strictSafeNavigationTypes: true,
      useContextGenericType: true,
      strictLiteralTypes: true,
      enableTemplateTypeChecker,
      useInlineTypeConstructors: false,
      controlFlowPreventingContentProjection:
        options.extendedDiagnostics?.checks?.controlFlowPreventingContentProjection ??
        options.extendedDiagnostics?.defaultCategory ??
        'warning',
      unusedStandaloneImports:
        options.extendedDiagnostics?.checks?.unusedStandaloneImports ??
        options.extendedDiagnostics?.defaultCategory ??
        'warning',
      // These are actually set via version check in ngtsc (ngtsc/core/src/compiler.ts).
      // Since we don't have any of that here we just default to true.
      allowSignalsInTwoWayBindings: true,
      allowDomEventAssertion: true,
      checkUnclaimedEventNames: false,
    };
  } else {
    typeCheckingConfig = {
      applyTemplateContextGuards: false,
      checkQueries: false,
      checkTemplateBodies: false,
      checkControlFlowBodies: false,
      alwaysCheckSchemaInTemplateBodies: !!options.annotateForClosureCompiler,
      checkTypeOfInputBindings: false,
      strictNullInputBindings: false,
      honorAccessModifiersForInputBindings: false,
      checkTypeOfAttributes: false,
      checkTypeOfDomBindings: false,
      checkTypeOfOutputEvents: false,
      checkTypeOfAnimationEvents: false,
      checkTypeOfDomEvents: false,
      checkTypeOfDomReferences: false,
      checkTypeOfNonDomReferences: false,
      checkTypeOfPipes: false,
      strictSafeNavigationTypes: false,
      useContextGenericType: false,
      strictLiteralTypes: false,
      enableTemplateTypeChecker,
      useInlineTypeConstructors: false,
      controlFlowPreventingContentProjection:
        options.extendedDiagnostics?.checks?.controlFlowPreventingContentProjection ??
        options.extendedDiagnostics?.defaultCategory ??
        'warning',
      unusedStandaloneImports:
        options.extendedDiagnostics?.checks?.unusedStandaloneImports ??
        options.extendedDiagnostics?.defaultCategory ??
        'warning',
      // These are actually set via version check in ngtsc (ngtsc/core/src/compiler.ts).
      // Since we don't have any of that here we just default to true.
      allowSignalsInTwoWayBindings: true,
      allowDomEventAssertion: true,
      checkUnclaimedEventNames: false,
    };
  }

  if (options.strictInputTypes !== undefined) {
    typeCheckingConfig.checkTypeOfInputBindings = options.strictInputTypes;
    typeCheckingConfig.applyTemplateContextGuards = options.strictInputTypes;
  }
  if (options.strictInputAccessModifiers !== undefined) {
    typeCheckingConfig.honorAccessModifiersForInputBindings = options.strictInputAccessModifiers;
  }
  if (options.strictNullInputTypes !== undefined) {
    typeCheckingConfig.strictNullInputBindings = options.strictNullInputTypes;
  }
  if (options.strictOutputEventTypes !== undefined) {
    typeCheckingConfig.checkTypeOfOutputEvents = options.strictOutputEventTypes;
    typeCheckingConfig.checkTypeOfAnimationEvents = options.strictOutputEventTypes;
  }
  if (options.strictDomEventTypes !== undefined) {
    typeCheckingConfig.checkTypeOfDomEvents = options.strictDomEventTypes;
  }
  if (options.strictSafeNavigationTypes !== undefined) {
    typeCheckingConfig.strictSafeNavigationTypes = options.strictSafeNavigationTypes;
  }
  if (options.strictDomLocalRefTypes !== undefined) {
    typeCheckingConfig.checkTypeOfDomReferences = options.strictDomLocalRefTypes;
  }
  if (options.strictAttributeTypes !== undefined) {
    typeCheckingConfig.checkTypeOfAttributes = options.strictAttributeTypes;
  }
  if (options.strictContextGenerics !== undefined) {
    typeCheckingConfig.useContextGenericType = options.strictContextGenerics;
  }
  if (options.strictLiteralTypes !== undefined) {
    typeCheckingConfig.strictLiteralTypes = options.strictLiteralTypes;
  }
  typeCheckingConfig.typeCheckHostBindings = options.typeCheckHostBindings ?? true;

  return typeCheckingConfig;
}

function printStatements(expressions: TcbExpr[]): string {
  let result = '';
  for (const expr of expressions) {
    result += `${expr.print()};\n`;
  }
  return result;
}

export class TcbImportManager {
  private readonly imports = new Map<string, string>();
  private nextIndex = 0;

  addImport(moduleSpecifier: string): string {
    let alias = this.imports.get(moduleSpecifier);
    if (alias === undefined) {
      alias = `i${this.nextIndex++}`;
      this.imports.set(moduleSpecifier, alias);
    }
    return alias;
  }

  generateImportStatements(): string {
    let result = '';
    for (const [moduleSpecifier, alias] of this.imports) {
      result += `import * as ${alias} from '${moduleSpecifier}';\n`;
    }
    return result;
  }
}

export function qualifyTypeParameters(
  params: ReadonlyArray<ExtendedTcbTypeParameter> | undefined | null,
  env: TcbEnvironment,
  defaultModuleSpecifier?: string | null,
): ExtendedTcbTypeParameter[] | undefined {
  if (!params || params.length === 0) {
    return params ? [] : undefined;
  }

  return params.map((param) => {
    const typeRefs = param.typeRefs;
    if (!typeRefs || typeRefs.length === 0) {
      return param;
    }

    // Sort descending by start offset so replacing back-to-front preserves earlier offsets
    const sortedRefs = [...typeRefs].sort((a, b) => (b.span?.start ?? 0) - (a.span?.start ?? 0));

    let representation = param.representation;
    let representationWithDefault = param.representationWithDefault;

    for (const ref of sortedRefs) {
      const mod = ref.moduleSpecifier || defaultModuleSpecifier;
      if (!mod || !ref.span) continue;

      const qualified = env.referenceExternalSymbol(mod, ref.symbol).print();
      const {start, end} = ref.span;

      if (start <= representation.length && end <= representation.length) {
        representation = representation.slice(0, start) + qualified + representation.slice(end);
      }
      if (start <= representationWithDefault.length && end <= representationWithDefault.length) {
        representationWithDefault =
          representationWithDefault.slice(0, start) +
          qualified +
          representationWithDefault.slice(end);
      }
    }

    return {
      ...param,
      representation,
      representationWithDefault,
    };
  });
}

function generateGenericArgs(typeParameters: ReadonlyArray<TcbTypeParameter> | undefined): string {
  if (typeParameters === undefined || typeParameters.length === 0) {
    return '';
  }
  return `<${typeParameters.map((param) => param.name).join(', ')}>`;
}

function typeParametersWithDefaultTypes(
  params: ReadonlyArray<TcbTypeParameter> | undefined,
): string {
  if (params === undefined || params.length === 0) {
    return '';
  }
  return `<${params.map((param) => param.representationWithDefault).join(', ')}>`;
}

function constructTypeCtorParameter(
  env: TcbEnvironment,
  meta: TypeCtorMetadata,
  typeRef: string,
  typeRefWithGenerics: string,
): string {
  let initType: string | null = null;

  const plainKeys: string[] = [];
  const coercedKeys: string[] = [];
  const signalInputKeys: string[] = [];

  for (const {classPropertyName, transformType, isSignal} of meta.fields.inputs) {
    if (isSignal) {
      signalInputKeys.push(TcbExpr.quoteAndEscape(classPropertyName));
    } else if (!meta.coercedInputFields.has(classPropertyName)) {
      plainKeys.push(TcbExpr.quoteAndEscape(classPropertyName));
    } else {
      const propName = `ngAcceptInputType_${classPropertyName}`;
      const isUnsafe = isUnsafeObjectKey(classPropertyName);
      const access = isUnsafe ? `[${TcbExpr.quoteAndEscape(propName)}]` : `.${propName}`;
      const coercionType =
        transformType !== undefined ? transformType : `typeof ${typeRef}${access}`;

      coercedKeys.push(
        `${isUnsafe ? TcbExpr.quoteAndEscape(classPropertyName) : classPropertyName}: ${coercionType}`,
      );
    }
  }

  if (plainKeys.length > 0) {
    initType = `Pick<${typeRefWithGenerics}, ${plainKeys.join(' | ')}>`;
  }
  if (coercedKeys.length > 0) {
    let coercedLiteral = '{\n';
    for (const key of coercedKeys) {
      coercedLiteral += `${key};\n`;
    }
    coercedLiteral += '}';
    initType = initType !== null ? `${initType} & ${coercedLiteral}` : coercedLiteral;
  }
  if (signalInputKeys.length > 0) {
    const keyTypeUnion = signalInputKeys.join(' | ');

    const unwrapRef = env.referenceExternalSymbol(
      R3Identifiers.UnwrapDirectiveSignalInputs.moduleName,
      R3Identifiers.UnwrapDirectiveSignalInputs.name,
    );
    const unwrapExpr = `${unwrapRef.print()}<${typeRefWithGenerics}, ${keyTypeUnion}>`;
    initType = initType !== null ? `${initType} & ${unwrapExpr}` : unwrapExpr;
  }

  if (initType === null) {
    initType = '{}';
  }

  return `init: ${initType}`;
}

export function generateTypeCtorDeclarationFn(
  env: TcbEnvironment,
  meta: TypeCtorMetadata,
  nodeTypeRef: TcbExpr,
  typeParams: TcbTypeParameter[] | undefined,
): TcbExpr {
  const typeArgs = generateGenericArgs(typeParams);
  const typeRefWithGenerics = `${nodeTypeRef.print()}${typeArgs}`;
  const initParam = constructTypeCtorParameter(env, meta, nodeTypeRef.print(), typeRefWithGenerics);
  const typeParameters = typeParametersWithDefaultTypes(typeParams);
  let source: string;

  if (meta.body) {
    const fnType = `${typeParameters}(${initParam}) => ${typeRefWithGenerics}`;
    source = `const ${meta.fnName}: ${fnType} = null!`;
  } else {
    source = `declare function ${meta.fnName}${typeParameters}(${initParam}): ${typeRefWithGenerics}`;
  }

  return new TcbExpr(source);
}

export class TcbEnvironmentImpl implements TcbEnvironment {
  private readonly nextIds = {
    pipeInst: 1,
    typeCtor: 1,
  };

  private readonly typeCtors = new Map<TcbReferenceKey, string>();
  private readonly typeCtorStatements: TcbExpr[] = [];

  private readonly pipeInsts = new Map<TcbReferenceKey, string>();
  private readonly pipeInstStatements: TcbExpr[] = [];

  constructor(
    readonly config: TypeCheckingConfig,
    private readonly importManager: TcbImportManager,
    private readonly isInline: boolean = false,
  ) {}

  referenceTcbValue(ref: TcbReferenceMetadata): TcbExpr {
    if (ref.unexportedDiagnostic !== null || ref.isLocal || ref.moduleName === null) {
      if (ref.unexportedDiagnostic !== null) {
        throw new Error(`Unable to import symbol ${ref.name}: ${ref.unexportedDiagnostic}`);
      }
      return new TcbExpr(ref.name);
    }
    return this.referenceExternalSymbol(ref.moduleName, ref.name);
  }

  referenceExternalSymbol(moduleName: string, name: string): TcbExpr {
    const alias = this.importManager.addImport(moduleName);
    return new TcbExpr(`${alias}.${name}`);
  }

  typeCtorFor(dir: TcbDirectiveMetadata): TcbExpr {
    if (this.typeCtors.has(dir.ref.key)) {
      return new TcbExpr(this.typeCtors.get(dir.ref.key)!);
    }

    if (dir.requiresInlineTypeCtor) {
      const typeCtorExpr = `${this.referenceTcbValue(dir.ref).print()}.ngTypeCtor`;
      this.typeCtors.set(dir.ref.key, typeCtorExpr);
      return new TcbExpr(typeCtorExpr);
    } else {
      const fnName = `_ctor${this.nextIds.typeCtor++}`;
      const nodeTypeRef = this.referenceTcbValue(dir.ref);
      const meta: TypeCtorMetadata = {
        fnName,
        body: true,
        fields: {
          inputs: dir.inputs,
        },
        coercedInputFields: dir.coercedInputFields,
      };

      const typeParams = dir.typeParameters
        ? qualifyTypeParameters(dir.typeParameters, this, dir.ref.moduleName)
        : undefined;
      const typeCtor = generateTypeCtorDeclarationFn(this, meta, nodeTypeRef, typeParams);
      this.typeCtorStatements.push(typeCtor);
      this.typeCtors.set(dir.ref.key, fnName);
      return new TcbExpr(fnName);
    }
  }

  pipeInst(pipe: TcbPipeMetadata): TcbExpr {
    if (this.pipeInsts.has(pipe.ref.key)) {
      return new TcbExpr(this.pipeInsts.get(pipe.ref.key)!);
    }

    const pipeType = this.referenceTcbValue(pipe.ref);
    const pipeInstId = `_pipe${this.nextIds.pipeInst++}`;
    this.pipeInsts.set(pipe.ref.key, pipeInstId);
    this.pipeInstStatements.push(new TcbExpr(`var ${pipeInstId} = null! as ${pipeType.print()}`));
    return new TcbExpr(pipeInstId);
  }

  getPreludeStatements(): TcbExpr[] {
    if (this.isInline) {
      return [...this.pipeInstStatements, ...this.typeCtorStatements];
    }
    return [];
  }

  getFileLevelStatements(): TcbExpr[] {
    return [...this.pipeInstStatements, ...this.typeCtorStatements];
  }
}

export function prepareTcbTargets(
  filePath: string,
  tcbTargets: TcbTargetInput[],
  content: string,
  config: TypeCheckingConfig,
  classes?: nga.ClassMetadata[],
  _workspaceName?: string,
  _rootDirs?: string[],
): PreparedTcbData | null {
  if (tcbTargets.length === 0) return null;

  const localClasses = new Map<string, nga.ClassMetadata>();
  if (classes) {
    for (const cls of classes) {
      if (cls.className) localClasses.set(cls.className, cls);
    }
  } else {
    for (const target of tcbTargets) {
      if (target.className) localClasses.set(target.className, target.classMeta);
    }
  }

  let requiresInline = tcbTargets.some((target) => requiresInlineDeclaration(target.classMeta));

  const intermediateTargets: Array<{
    comp: TcbTargetInput;
    typeCheckId: TypeCheckId;
    tcbMeta: TcbTypeCheckBlockMetadata;
    targetMeta: TcbComponentMetadata;
    hostElement: TmplAstHostElement | null;
  }> = [];

  for (let i = 0; i < tcbTargets.length; i++) {
    const comp = tcbTargets[i];
    const typeCheckId = `tcb${i + 1}` as TypeCheckId;
    const adapted = adaptTcbInput(comp, typeCheckId, filePath, config, requiresInline, content);
    intermediateTargets.push({comp, typeCheckId, ...adapted});

    if (
      !requiresInline &&
      requiresInlineTypeCheckBlock(comp, adapted.tcbMeta.boundTarget, localClasses)
    ) {
      requiresInline = true;
    }
  }

  const boundTargetMap = new Map<string, BoundTarget<TcbDirectiveMetadata>>();
  const hostElementsMap = new Map<string, TmplAstHostElement | null>();
  const typeCheckIdMap = new Map<string, TypeCheckId>();
  const targets: PreparedTcbTarget[] = [];

  for (let i = 0; i < tcbTargets.length; i++) {
    const {comp, typeCheckId} = intermediateTargets[i];
    const {tcbMeta, targetMeta, hostElement} = requiresInline
      ? adaptTcbInput(comp, typeCheckId, filePath, config, true, content)
      : intermediateTargets[i];

    const classKey = makeClassKey(comp.className, comp.classMeta.span.start);
    boundTargetMap.set(classKey, tcbMeta.boundTarget);
    hostElementsMap.set(classKey, hostElement);
    typeCheckIdMap.set(classKey, typeCheckId);
    targets.push({comp, typeCheckId, tcbMeta, targetMeta});
  }

  return {targets, boundTargetMap, hostElementsMap, typeCheckIdMap, requiresInline};
}

export function generateTcbCode(
  filePath: string,
  preparedData: PreparedTcbData,
  config: TypeCheckingConfig,
): TcbResult | null {
  const {targets, requiresInline} = preparedData;
  if (targets.length === 0) return null;

  const importManager = new TcbImportManager();
  const oobRecorder = new OutOfBandDiagnosticRecorderImpl();
  const domSchemaChecker = new RegistryDomSchemaChecker();

  let code = '';
  let functionStrings = '';
  const tcbMap = new Map<string, string>();

  const sharedEnv = !requiresInline ? new TcbEnvironmentImpl(config, importManager, false) : null;

  for (const target of targets) {
    const {comp, typeCheckId, tcbMeta, targetMeta} = target;
    const env = sharedEnv || new TcbEnvironmentImpl(config, importManager, true);

    const targetTypeParams = targetMeta.typeParameters
      ? (qualifyTypeParameters(targetMeta.typeParameters, env, targetMeta.ref.moduleName) ?? null)
      : null;
    const qualifiedTargetMeta = targetTypeParams
      ? {...targetMeta, typeParameters: targetTypeParams}
      : targetMeta;

    let tcbString = '';
    try {
      tcbString = generateTypeCheckBlock(
        env,
        qualifiedTargetMeta,
        `_${typeCheckId}`,
        tcbMeta,
        domSchemaChecker,
        oobRecorder,
      );
    } catch (e: any) {
      oobRecorder.error(
        typeCheckId,
        `Error generating TCB for ${comp.className}: ${e?.message || e}`,
        {start: comp.classMeta.span.start, end: comp.classMeta.span.end},
      );
      continue;
    }

    functionStrings += tcbString + '\n\n';
    const classKey = makeClassKey(comp.className, comp.classMeta.span.start);
    tcbMap.set(classKey, tcbString);
  }

  if (!requiresInline) {
    const preludeStatements = sharedEnv!.getFileLevelStatements();
    const preludeStr = printStatements(preludeStatements);
    code += preludeStr + '\n' + functionStrings;
  } else {
    code += functionStrings;
  }

  const importsStr = importManager.generateImportStatements();

  return {
    code: code,
    imports: importsStr,
    tcbMap,
    diagnostics: [...domSchemaChecker.diagnostics, ...oobRecorder.diagnostics],
    isInline: requiresInline,
  };
}

export function combineTcbContent(
  tcbResult: TcbResult,
  filePath: string,
  inlineInfo: {sourceContent: string; classes: nga.ClassMetadata[]},
): string {
  const generatedComment = `/**\n * TCB for ${filePath}\n * @generated\n */\n\n`;
  const importsStr = tcbResult.imports || '';
  const separator = importsStr ? '\n' : '';
  const tcbHeader = generatedComment + importsStr + separator;

  if (tcbResult.isInline) {
    const {sourceContent, classes} = inlineInfo;

    const s = new MagicString(sourceContent);
    for (const classMeta of classes) {
      const classKey = makeClassKey(classMeta.className || '', classMeta.span.start);
      const tcbCode = tcbResult.tcbMap.get(classKey);
      if (tcbCode) {
        s.appendLeft(classMeta.span.end, '\n\n' + tcbCode);
      }
    }
    return tcbHeader + s.toString();
  } else {
    return tcbHeader + tcbResult.code;
  }
}
