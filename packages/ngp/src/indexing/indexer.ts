/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  AST,
  ASTWithSource,
  BoundTarget,
  CombinedRecursiveAstVisitor,
  ImplicitReceiver,
  ParseSourceSpan,
  PropertyRead,
  SafePropertyRead,
  ThisReceiver,
  TmplAstBoundAttribute,
  TmplAstBoundEvent,
  TmplAstElement,
  TmplAstLetDeclaration,
  TmplAstNode,
  TmplAstReference,
  TmplAstTemplate,
  TmplAstTextAttribute,
  TmplAstVariable,
  TcbDirectiveMetadata,
  TmplAstComponent,
  TmplAstDirective,
  BindingPipe,
} from '@angular/compiler';
import {
  AbsoluteSourceSpan,
  AttributeIdentifier,
  BoundAttributeIdentifier,
  ClassEntity,
  DirectiveHostIdentifier,
  IdentifierKind,
  IndexedComponent,
  LetDeclarationIdentifier,
  PipeIdentifier,
  PropertyIdentifier,
  ReferenceIdentifier,
  TopLevelIdentifier,
  VariableIdentifier,
  UrlMetadata,
  IoMetadata,
} from '../indexer_api.js';
import type {HybridCompiler} from '../hybrid_compiler.js';
import {makeClassKey} from '../compiler-utils.js';
import {createInputPropertyMapping, createOutputPropertyMapping} from '../tcb_adapter.js';

type TmplTarget = TmplAstReference | TmplAstVariable | TmplAstLetDeclaration;
type TargetIdentifier = ReferenceIdentifier | VariableIdentifier | LetDeclarationIdentifier;
type TargetIdentifierMap = Map<TmplTarget, TargetIdentifier>;

export class IndexerVisitor extends CombinedRecursiveAstVisitor {
  readonly identifiers = new Set<TopLevelIdentifier>();
  readonly errors: Error[] = [];
  private currentAstWithSource: {source: string | null; absoluteOffset: number} | null = null;

  private readonly targetIdentifierCache: TargetIdentifierMap = new Map();

  private readonly directiveHostIdentifierCache = new Map<
    TmplAstElement | TmplAstTemplate | TmplAstComponent | TmplAstDirective,
    DirectiveHostIdentifier
  >();

  private readonly classEntityCache = new Map<unknown, ClassEntity>();

  constructor(
    private boundTarget?: BoundTarget<TcbDirectiveMetadata>,
    private pipes?: Map<string, ClassEntity>,
  ) {
    super();
  }

  public getClassEntity(dir: TcbDirectiveMetadata): ClassEntity {
    const cacheKey = dir.ref || dir;
    if (this.classEntityCache.has(cacheKey)) {
      return this.classEntityCache.get(cacheKey)!;
    }

    let name = dir.name ?? '';
    let filePath = '';

    if (dir.ref) {
      name = dir.ref.name || name;
      filePath = dir.ref.nodeFilePath || '';
      if (!filePath && typeof dir.ref.key === 'string') {
        const parts = dir.ref.key.split('#');
        if (parts.length > 1) {
          filePath = parts[0];
        }
      }
    }

    const entity: ClassEntity = {name, filePath};
    this.classEntityCache.set(cacheKey, entity);
    return entity;
  }

  override visitElement(element: TmplAstElement) {
    const elementIdentifier = this.directiveHostToIdentifier(element);
    if (elementIdentifier !== null) {
      this.identifiers.add(elementIdentifier);
    }
    super.visitElement(element);
  }

  override visitTemplate(template: TmplAstTemplate) {
    const templateIdentifier = this.directiveHostToIdentifier(template);
    if (templateIdentifier !== null) {
      this.identifiers.add(templateIdentifier);
    }
    super.visitTemplate(template);
  }

  override visitReference(reference: TmplAstReference) {
    const referenceIdentifier = this.targetToIdentifier(reference);
    if (referenceIdentifier !== null) {
      this.identifiers.add(referenceIdentifier);
    }
    super.visitReference(reference);
  }

  override visitVariable(variable: TmplAstVariable) {
    const variableIdentifier = this.targetToIdentifier(variable);
    if (variableIdentifier !== null) {
      this.identifiers.add(variableIdentifier);
    }
    super.visitVariable(variable);
  }

  override visitLetDeclaration(decl: TmplAstLetDeclaration): void {
    const identifier = this.targetToIdentifier(decl);
    if (identifier !== null) {
      this.identifiers.add(identifier);
    }
    super.visitLetDeclaration(decl);
  }

  override visitPropertyRead(ast: PropertyRead) {
    this.visitIdentifier(ast);
    super.visitPropertyRead(ast, null);
  }

  override visitSafePropertyRead(ast: SafePropertyRead) {
    this.visitIdentifier(ast);
    super.visitSafePropertyRead(ast, null);
  }

  override visitPipe(ast: BindingPipe): void {
    this.visitPipeIdentifier(ast);
    super.visitPipe(ast, null);
  }

  private visitPipeIdentifier(ast: BindingPipe): void {
    if (this.currentAstWithSource === null || this.currentAstWithSource.source === null) {
      return;
    }

    const {absoluteOffset, source: expressionStr} = this.currentAstWithSource;
    const identifierStart = ast.nameSpan.start - absoluteOffset;

    if (!expressionStr.startsWith(ast.name, identifierStart)) {
      this.errors.push(
        new Error(
          `Impossible state: "${ast.name}" not found in "${expressionStr}" at location ${identifierStart}`,
        ),
      );
      return;
    }

    const absoluteStart = absoluteOffset + identifierStart;
    const span = new AbsoluteSourceSpan(absoluteStart, absoluteStart + ast.name.length);
    const target = this.pipes?.get(ast.name) ?? null;
    const identifier: PipeIdentifier = {
      name: ast.name,
      span,
      kind: IdentifierKind.Pipe,
      target: target ? {node: target} : null,
    };

    this.identifiers.add(identifier);
  }

  override visitComponent(component: TmplAstComponent) {
    const identifier = this.directiveHostToIdentifier(component);
    if (identifier !== null) {
      this.identifiers.add(identifier);
    }
    super.visitComponent(component);
  }

  override visitDirective(directive: TmplAstDirective) {
    const identifier = this.directiveHostToIdentifier(directive);
    if (identifier !== null) {
      this.identifiers.add(identifier);
    }
    super.visitDirective(directive);
  }

  override visitBoundAttribute(attribute: TmplAstBoundAttribute): void {
    const identifier = this.bindingToIdentifier(attribute, IdentifierKind.Input);
    if (identifier !== null) {
      this.identifiers.add(identifier);
    }
    const previous = this.currentAstWithSource;
    this.currentAstWithSource = {
      source: attribute.valueSpan?.toString() || null,
      absoluteOffset: attribute.valueSpan ? attribute.valueSpan.start.offset : -1,
    };
    this.visit(attribute.value instanceof ASTWithSource ? attribute.value.ast : attribute.value);
    this.currentAstWithSource = previous;
  }

  override visitBoundEvent(event: TmplAstBoundEvent): void {
    const identifier = this.bindingToIdentifier(event, IdentifierKind.Output);
    if (identifier !== null) {
      this.identifiers.add(identifier);
    }
    super.visitBoundEvent(event);
  }

  override visitTextAttribute(attribute: TmplAstTextAttribute): void {
    const identifier = this.bindingToIdentifier(attribute, IdentifierKind.Input);
    if (identifier !== null) {
      this.identifiers.add(identifier);
    }
    super.visitTextAttribute(attribute);
  }

  private bindingToIdentifier(
    node: TmplAstBoundAttribute | TmplAstBoundEvent | TmplAstTextAttribute,
    kind: typeof IdentifierKind.Input | typeof IdentifierKind.Output,
  ): BoundAttributeIdentifier | null {
    const consumer = this.boundTarget?.getConsumerOfBinding(node);
    if (!consumer || consumer instanceof TmplAstElement || consumer instanceof TmplAstTemplate) {
      return null;
    }

    const keySpan = node.keySpan ?? (node instanceof TmplAstTextAttribute ? node.sourceSpan : null);
    if (!keySpan) {
      return null;
    }

    const span = new AbsoluteSourceSpan(
      keySpan.start.offset,
      keySpan.start.offset + node.name.length,
    );
    return {
      name: node.name,
      span,
      kind,
      target: {
        node: this.getClassEntity(consumer),
      },
    };
  }

  private directiveHostToIdentifier(
    node: TmplAstElement | TmplAstTemplate | TmplAstComponent | TmplAstDirective,
  ): DirectiveHostIdentifier | null {
    if (this.directiveHostIdentifierCache.has(node)) {
      return this.directiveHostIdentifierCache.get(node)!;
    }

    let name: string;
    let kind: IdentifierKind;
    if (node instanceof TmplAstTemplate) {
      name = node.tagName ?? 'ng-template';
      kind = IdentifierKind.Template;
    } else if (node instanceof TmplAstElement) {
      name = node.name;
      kind = IdentifierKind.Element;
    } else if (node instanceof TmplAstComponent) {
      name = node.fullName;
      kind = IdentifierKind.Component;
    } else {
      name = node.name;
      kind = IdentifierKind.Directive;
    }

    if (
      (node instanceof TmplAstTemplate || node instanceof TmplAstElement) &&
      name.startsWith(':')
    ) {
      name = name.split(':').pop()!;
    }

    const sourceSpan = node.startSourceSpan;
    const start = this.getStartLocation(name, sourceSpan);
    if (start === null) {
      return null;
    }
    const absoluteSpan = new AbsoluteSourceSpan(start, start + name.length);

    const attributes = node.attributes.map(({name, sourceSpan}): AttributeIdentifier => {
      return {
        name,
        span: new AbsoluteSourceSpan(sourceSpan.start.offset, sourceSpan.end.offset),
        kind: IdentifierKind.Attribute,
      };
    });
    const usedDirectives = this.boundTarget?.getDirectivesOfNode(node) || [];

    const identifier = {
      name,
      span: absoluteSpan,
      kind,
      attributes: new Set(attributes),
      usedDirectives: new Set(
        usedDirectives.map((dir) => {
          return {
            node: this.getClassEntity(dir),
            selector: dir.selector,
          };
        }),
      ),
    } as DirectiveHostIdentifier;

    this.directiveHostIdentifierCache.set(node, identifier);
    return identifier;
  }

  private targetToIdentifier(node: TmplTarget): TargetIdentifier | null {
    if (this.targetIdentifierCache.has(node)) {
      return this.targetIdentifierCache.get(node)!;
    }

    const {name, sourceSpan} = node;
    const start = this.getStartLocation(name, sourceSpan);
    if (start === null) {
      return null;
    }

    const span = new AbsoluteSourceSpan(start, start + name.length);
    let identifier: ReferenceIdentifier | VariableIdentifier | LetDeclarationIdentifier;
    if (node instanceof TmplAstReference) {
      const refTarget = this.boundTarget?.getReferenceTarget(node);
      let target = null;
      if (refTarget) {
        let nodeTarget: DirectiveHostIdentifier | null = null;
        let directive = null;
        if (
          refTarget instanceof TmplAstElement ||
          refTarget instanceof TmplAstTemplate ||
          refTarget instanceof TmplAstComponent ||
          refTarget instanceof TmplAstDirective
        ) {
          nodeTarget = this.directiveHostToIdentifier(refTarget);
        } else {
          const targetNode = refTarget.node;
          if (
            targetNode instanceof TmplAstElement ||
            targetNode instanceof TmplAstTemplate ||
            targetNode instanceof TmplAstComponent ||
            targetNode instanceof TmplAstDirective
          ) {
            nodeTarget = this.directiveHostToIdentifier(targetNode);
          }
          directive = this.getClassEntity(refTarget.directive);
        }

        if (nodeTarget === null) {
          return null;
        }
        target = {
          node: nodeTarget,
          directive,
        };
      }

      identifier = {
        name,
        span,
        kind: IdentifierKind.Reference,
        target,
      };
    } else if (node instanceof TmplAstVariable) {
      identifier = {
        name,
        span,
        kind: IdentifierKind.Variable,
      };
    } else {
      identifier = {
        name,
        span,
        kind: IdentifierKind.LetDeclaration,
      };
    }

    this.targetIdentifierCache.set(node, identifier);
    return identifier;
  }

  private getStartLocation(name: string, context: ParseSourceSpan): number | null {
    const localStr = context.toString();
    const index = localStr.indexOf(name);
    if (index === -1) {
      this.errors.push(new Error(`Impossible state: "${name}" not found in "${localStr}"`));
      return null;
    }
    return context.start.offset + index;
  }

  override visit(node: TmplAstNode | AST): void {
    if (node instanceof ASTWithSource) {
      const previous = this.currentAstWithSource;
      this.currentAstWithSource = {source: node.source, absoluteOffset: node.sourceSpan.start};
      super.visit(node.ast);
      this.currentAstWithSource = previous;
    } else {
      super.visit(node);
    }
  }

  private visitIdentifier(ast: AST & {name: string; receiver: AST}) {
    if (this.currentAstWithSource === null || this.currentAstWithSource.source === null) {
      return;
    }

    if (!(ast.receiver instanceof ImplicitReceiver) && !(ast.receiver instanceof ThisReceiver)) {
      return;
    }

    const {absoluteOffset, source: expressionStr} = this.currentAstWithSource;

    let identifierStart = ast.sourceSpan.start - absoluteOffset;

    if (ast instanceof PropertyRead || ast instanceof SafePropertyRead) {
      identifierStart = ast.nameSpan.start - absoluteOffset;
    }

    if (!expressionStr.startsWith(ast.name, identifierStart)) {
      this.errors.push(
        new Error(
          `Impossible state: "${ast.name}" not found in "${expressionStr}" at location ${identifierStart}`,
        ),
      );
      return;
    }

    const absoluteStart = absoluteOffset + identifierStart;
    const span = new AbsoluteSourceSpan(absoluteStart, absoluteStart + ast.name.length);
    const targetAst = this.boundTarget?.getExpressionTarget(ast);
    const target = targetAst ? this.targetToIdentifier(targetAst) : null;
    const identifier: PropertyIdentifier = {
      name: ast.name,
      span,
      kind: IdentifierKind.Property,
      target,
    };

    this.identifiers.add(identifier);
  }
}

export async function getIndexedComponents(
  compiler: HybridCompiler,
): Promise<Map<string, IndexedComponent>> {
  const indexedComponents = new Map<string, IndexedComponent>();

  for (const [filePath, fileAnalysis] of compiler.fileCache.entries()) {
    const templatesByClass = fileAnalysis?.parsedTemplates;
    if (!templatesByClass) continue;

    const boundTargetsByClass = fileAnalysis?.preparedTcbData?.boundTargetMap;
    const result = await compiler.analyzer.getMetadataForFile(filePath);
    if (!result) continue;

    for (const cls of result.classes) {
      if (!cls.className || !cls.component) continue;

      const classKey = makeClassKey(cls.className, cls.span.start);
      const parsedTemplate = templatesByClass.get(classKey);
      if (!parsedTemplate) continue;

      const boundTarget = boundTargetsByClass?.get(classKey);
      const target = fileAnalysis?.preparedTcbData?.targets.find(
        (t) =>
          t.comp.className === cls.className &&
          (!t.comp.classMeta || t.comp.classMeta.span.start === cls.span.start),
      );
      const pipeMap = new Map<string, ClassEntity>();
      if (target?.comp.pipeRegistry) {
        for (const [name, pipeMeta] of target.comp.pipeRegistry.entries()) {
          pipeMap.set(name, {
            name: pipeMeta.className,
            filePath: pipeMeta.filePath || '',
          });
        }
      }
      const visitor = new IndexerVisitor(boundTarget, pipeMap);
      parsedTemplate.nodes.forEach((node: TmplAstNode) => node.visit(visitor));

      const identifiers = new Set<TopLevelIdentifier>();

      for (const id of visitor.identifiers) {
        identifiers.add(id);
      }

      let templateUrl: UrlMetadata | undefined = undefined;
      if (cls.component.templateUrl && cls.component.templateUrl.stringLiteralSpan) {
        const span = cls.component.templateUrl.stringLiteralSpan;
        templateUrl = {
          url: cls.component.templateUrl.url,
          span: {
            start: span.start + 1,
            end: span.end - 1,
          },
          resolvedPath: cls.component.templateUrl.resolvedPath,
        };
      }

      const styleUrls: UrlMetadata[] = [];
      if (cls.component.styleUrls) {
        for (const s of cls.component.styleUrls) {
          if (s.stringLiteralSpan) {
            styleUrls.push({
              url: s.url,
              span: {
                start: s.stringLiteralSpan.start + 1,
                end: s.stringLiteralSpan.end - 1,
              },
              resolvedPath: s.resolvedPath,
            });
          }
        }
      }

      const inputMapping = createInputPropertyMapping(cls.inputs);
      const outputMapping = createOutputPropertyMapping(cls.outputs);

      const inputs: IoMetadata[] = Array.from(inputMapping).map((m) => ({
        directiveProperty: m.classPropertyName,
        bindingName: m.bindingPropertyName,
      }));
      const outputs: IoMetadata[] = Array.from(outputMapping).map((m) => ({
        directiveProperty: m.classPropertyName,
        bindingName: m.bindingPropertyName,
      }));

      const templatePath = templateUrl?.resolvedPath || filePath;

      indexedComponents.set(cls.className, {
        name: cls.className,
        selector: cls.component.selector || null,
        fileUrl: filePath,
        template: {
          identifiers,
          fileUrl: templatePath,
        },
        errors: visitor.errors,
        templateUrl,
        styleUrls,
        inputs,
        outputs,
      });
    }
  }

  return indexedComponents;
}
