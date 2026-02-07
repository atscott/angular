import ts from 'typescript';
import {Reference} from '../../imports';
import {TypeCheckBlockMetadata, TypeCheckableDirectiveMeta} from '../api';
import {
  TcbComponentMetadata,
  TcbDirectiveMetadata,
  TcbScope,
  TcbInputMapping,
  TcbOutputMapping,
  TcbPipeMetadata,
  TcbPropertySet,
} from '../api/tcb_metadata';
import {Environment} from './environment';
import {tsCreateTypeQueryForCoercedInput} from './ts_util';
import {BoundTarget, TransplantedType} from '@angular/compiler';
import {ClassDeclaration} from '../../reflection';
import {requiresInlineTypeCtor} from './type_constructor';

export function adaptTypeCheckBlockMetadata(
  meta: TypeCheckBlockMetadata,
  env: Environment,
  compRef: Reference<ClassDeclaration<ts.ClassDeclaration>>,
): TcbComponentMetadata {
  const directives: TcbDirectiveMetadata[] = [];
  const pipes: TcbPipeMetadata[] = [];
  const dirMap = new Map<TypeCheckableDirectiveMeta, TcbDirectiveMetadata>();
  const pipeMap = new Map<string, TcbPipeMetadata>();

  const template = meta.boundTarget.target.template;
  if (!template) {
    throw new Error('Template is missing');
  }

  // Iterate over all used directives to adapt them
  for (const dir of meta.boundTarget.getUsedDirectives()) {
    const adapted = adaptDirective(dir, env);
    directives.push(adapted);
    dirMap.set(dir, adapted);
  }

  // Iterate over pipes
  if (meta.pipes) {
    for (const [name, pipe] of meta.pipes) {
      const adaptedPipe: TcbPipeMetadata = {
        name: pipe.name!,
        moduleName: pipe.ref.node.getSourceFile().fileName,
        ref: pipe.ref,
        pipeName: pipe.name!, // The template name
        isStandalone: pipe.isStandalone,
        isExplicitlyDeferred: pipe.isExplicitlyDeferred,
        transformType: undefined, // We can extract the transform type if needed
      };
      pipes.push(adaptedPipe);
      pipeMap.set(name, adaptedPipe);
    }
  }

  const scope: TcbScope = {directives, pipes};

  // Construct the component directive metadata directly from the compRef, because the component
  // itself is not naturally part of the `boundTarget.getUsedDirectives()` (unless recursing or checking host bindings).
  const componentDir = {
    name: compRef.node.name.text,
    moduleName: compRef.ownedByModuleGuess || compRef.node.getSourceFile().fileName,
    ref: compRef,
    isComponent: true,
    isStandalone: meta.isStandalone,
    typeParameters: compRef.node.typeParameters
      ? Array.from(compRef.node.typeParameters)
      : undefined,
    inputs: new TcbPropertySet(new Set()),
    outputs: new TcbPropertySet(new Set()),
    tcbInputs: [],
    tcbOutputs: [],
    exportAs: null,
    selector: null,
    isStructural: false,
    isGeneric: compRef.node.typeParameters !== undefined,
    hasNgTemplateContextGuard: false,
    ngTemplateGuards: [],
    requiresInlineTcbConstructor: false,
    coercedInputFields: new Set<string>(),
    restrictedInputFields: new Set<string>(),
    stringLiteralInputFields: new Set<string>(),
    undeclaredInputFields: new Set<string>(),
    hasControlValueAccessorMethods: false,
    isExplicitlyDeferred: false,
    isSignal: false,
    ngContentSelectors: null,
    preserveWhitespaces: meta.preserveWhitespaces,
    animationTriggerNames: null,
  } as unknown as TcbDirectiveMetadata;

  return {
    name: compRef.node.name.text,
    moduleName: compRef.node.getSourceFile().fileName,
    template,
    component: componentDir,
    preserveWhitespaces: meta.preserveWhitespaces,
    scope,
    boundTarget: new TcbBoundTarget(meta.boundTarget, dirMap),
    pipes: pipeMap,
    schemas: meta.schemas,
    isStandalone: meta.isStandalone,
    id: meta.id,
  };
}

class TcbBoundTarget implements BoundTarget<TcbDirectiveMetadata> {
  constructor(
    private delegate: BoundTarget<TypeCheckableDirectiveMeta>,
    private dirMap: Map<TypeCheckableDirectiveMeta, TcbDirectiveMetadata>,
  ) {}

  get target(): any {
    const t = this.delegate.target;
    return {
      template: t.template,
      host: t.host
        ? {
            node: t.host.node,
            directives: t.host.directives.map(
              (d: TypeCheckableDirectiveMeta) => this.dirMap.get(d)!,
            ),
          }
        : undefined,
    };
  }

  getDirectivesOfNode(node: any): TcbDirectiveMetadata[] | null {
    const dirs = this.delegate.getDirectivesOfNode(node);
    return dirs ? dirs.map((d: TypeCheckableDirectiveMeta) => this.dirMap.get(d)!) : null;
  }

  getReferenceTarget(ref: any): any | null {
    const target = this.delegate.getReferenceTarget(ref);
    if (!target) return null;
    if ('directive' in target) {
      return {
        directive: this.dirMap.get(target.directive as TypeCheckableDirectiveMeta)!,
        node: target.node,
      };
    }
    return target;
  }

  getConsumerOfBinding(binding: any): TcbDirectiveMetadata | any | null {
    const consumer = this.delegate.getConsumerOfBinding(binding);
    if (consumer && 'name' in consumer && 'exportAs' in consumer) {
      return this.dirMap.get(consumer as TypeCheckableDirectiveMeta) || null;
    }
    return consumer;
  }

  getExpressionTarget(expr: any): any | null {
    return this.delegate.getExpressionTarget(expr);
  }

  getDefinitionNodeOfSymbol(symbol: any): any | null {
    return this.delegate.getDefinitionNodeOfSymbol(symbol);
  }

  getNestingLevel(node: any): number {
    return this.delegate.getNestingLevel(node);
  }

  getEntitiesInScope(node: any | null): ReadonlySet<any> {
    return this.delegate.getEntitiesInScope(node);
  }

  getUsedDirectives(): TcbDirectiveMetadata[] {
    return this.delegate
      .getUsedDirectives()
      .map((d: TypeCheckableDirectiveMeta) => this.dirMap.get(d)!);
  }

  getEagerlyUsedDirectives(): TcbDirectiveMetadata[] {
    return this.delegate
      .getEagerlyUsedDirectives()
      .map((d: TypeCheckableDirectiveMeta) => this.dirMap.get(d)!);
  }

  getUsedPipes(): string[] {
    return this.delegate.getUsedPipes();
  }

  getEagerlyUsedPipes(): string[] {
    return this.delegate.getEagerlyUsedPipes();
  }

  getDeferBlocks(): any[] {
    return this.delegate.getDeferBlocks();
  }

  getDeferredTriggerTarget(block: any, trigger: any): any | null {
    return this.delegate.getDeferredTriggerTarget(block, trigger);
  }

  isDeferred(node: any): boolean {
    return this.delegate.isDeferred(node);
  }

  referencedDirectiveExists(name: string): boolean {
    return this.delegate.referencedDirectiveExists(name);
  }
}

function adaptDirective(dir: TypeCheckableDirectiveMeta, env: Environment): TcbDirectiveMetadata {
  const tcbInputs: TcbInputMapping[] = [];
  const tcbOutputs: TcbOutputMapping[] = [];

  for (const input of dir.inputs) {
    const fieldName = input.classPropertyName;
    let type: ts.TypeNode | undefined = undefined;

    if (dir.coercedInputFields.has(fieldName)) {
      if (input.transform !== null && input.transform !== undefined) {
        type = env.referenceTransplantedType(new TransplantedType(input.transform.type));
      } else {
        const dirTypeRef: ts.TypeNode = env.referenceType(dir.ref);
        if (ts.isTypeReferenceNode(dirTypeRef)) {
          type = tsCreateTypeQueryForCoercedInput(dirTypeRef.typeName, fieldName);
        }
      }
    }

    tcbInputs.push({
      classPropertyName: input.classPropertyName,
      bindingPropertyName: input.bindingPropertyName,
      required: input.required,
      isSignal: input.isSignal,
      type,
    });
  }

  for (const output of dir.outputs) {
    tcbOutputs.push({
      classPropertyName: output.classPropertyName,
      bindingPropertyName: output.bindingPropertyName,
      type: undefined,
    });
  }

  return {
    ...dir,
    name: dir.name,
    moduleName: dir.ref.ownedByModuleGuess || dir.ref.node.getSourceFile().fileName,
    inputs: new TcbPropertySet(new Set(Array.from(dir.inputs).map((i) => i.bindingPropertyName))),
    outputs: new TcbPropertySet(new Set(Array.from(dir.outputs).map((o) => o.bindingPropertyName))),
    tcbInputs,
    tcbOutputs,
    coercedInputFields: dir.coercedInputFields,
    restrictedInputFields: dir.restrictedInputFields,
    stringLiteralInputFields: dir.stringLiteralInputFields,
    undeclaredInputFields: dir.undeclaredInputFields,
    hasControlValueAccessorMethods:
      dir.publicMethods.has('writeValue') &&
      dir.publicMethods.has('registerOnChange') &&
      dir.publicMethods.has('registerOnTouched'),
    typeParameters: (dir.ref.node as unknown as ts.ClassDeclaration).typeParameters
      ? Array.from((dir.ref.node as unknown as ts.ClassDeclaration).typeParameters!)
      : undefined,
    requiresInlineTcbConstructor: requiresInlineTypeCtor(
      dir.ref.node as unknown as ClassDeclaration<ts.ClassDeclaration>,
      env.reflector,
      env,
    ),
  };
}
