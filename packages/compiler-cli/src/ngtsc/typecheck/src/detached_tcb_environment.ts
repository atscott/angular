import ts from 'typescript';
import {TypeCheckingConfig} from '../api';
import {TypeCtorMetadata, TcbDirectiveMetadata, TcbPipeMetadata} from '../api';
import {TransplantedType, Type} from '@angular/compiler';
import {TcbEnvironment} from './tcb_environment';
import {Reference} from '../../imports';
import {generateTypeCtorDeclarationFn} from './type_constructor';
import {tsDeclareVariable} from './ts_util';

/**
 * An implementation of `TcbEnvironment` that does not depend on a live `ts.Program` or
 * `ReflectionHost`. It uses the module names provided in detached metadata interfaces
 * (`TcbDirectiveMetadata` and `TcbPipeMetadata`) to generate explicit imports.
 */
export class DetachedTcbEnvironment implements TcbEnvironment {
  private _nextImportId = 1;

  // Maps a moduleName -> `* as identifier`
  private imports = new Map<string, ts.Identifier>();
  private importStatements: ts.Statement[] = [];

  private typeCtors = new Map<TcbDirectiveMetadata, ts.Expression>();
  private typeCtorStatements: ts.Statement[] = [];

  private pipeInsts = new Map<TcbPipeMetadata, ts.Expression>();
  private pipeInstStatements: ts.Statement[] = [];

  private nextIds = {
    pipeInst: 1,
    typeCtor: 1,
  };

  constructor(public readonly config: TypeCheckingConfig) {}

  /**
   * Generates a unique namespace import prefix for a given module path.
   */
  private getNamespaceImport(moduleName: string): ts.Identifier {
    if (this.imports.has(moduleName)) {
      return this.imports.get(moduleName)!;
    }

    const identifier = ts.factory.createIdentifier(`i${this._nextImportId++}`);
    this.imports.set(moduleName, identifier);

    // Create the import statement: `import * as iN from 'moduleName'`
    const importDecl = ts.factory.createImportDeclaration(
      undefined,
      ts.factory.createImportClause(false, undefined, ts.factory.createNamespaceImport(identifier)),
      ts.factory.createStringLiteral(moduleName),
    );

    this.importStatements.push(importDecl);
    return identifier;
  }

  typeCtorFor(dir: TcbDirectiveMetadata): ts.Expression {
    if (this.typeCtors.has(dir)) {
      return this.typeCtors.get(dir)!;
    }

    const fnName = `_ctor${this.nextIds.typeCtor++}`;
    const nodeTypeRef = this.referenceType(dir);
    if (!ts.isTypeReferenceNode(nodeTypeRef)) {
      throw new Error(`Expected TypeReferenceNode from reference to ${dir.name}`);
    }
    const meta: TypeCtorMetadata = {
      fnName,
      body: true,
      fields: {
        inputs: dir.tcbInputs as any,
        queries: (dir as any).queries || [],
      },
      coercedInputFields: dir.coercedInputFields,
    };
    const typeParams = dir.typeParameters;
    const typeCtor = generateTypeCtorDeclarationFn(this, meta, nodeTypeRef.typeName, typeParams);
    this.typeCtorStatements.push(typeCtor);
    const fnId = ts.factory.createIdentifier(fnName);
    this.typeCtors.set(dir, fnId);
    return fnId;
  }

  pipeInst(pipe: TcbPipeMetadata): ts.Expression {
    if (this.pipeInsts.has(pipe)) {
      return this.pipeInsts.get(pipe)!;
    }

    const pipeType = this.referenceType(pipe as any);
    const pipeInstId = ts.factory.createIdentifier(`_pipe${this.nextIds.pipeInst++}`);

    this.pipeInstStatements.push(tsDeclareVariable(pipeInstId, pipeType));
    this.pipeInsts.set(pipe, pipeInstId);

    return pipeInstId;
  }

  reference(ref: Reference<ts.Declaration>): ts.Expression {
    const nameNode = (ref.node as any).name;
    const nameText = nameNode
      ? typeof nameNode === 'string'
        ? nameNode
        : nameNode.text
      : 'UNKNOWN';
    const moduleName = (ref as any).moduleName;
    if (moduleName) {
      const ns = this.getNamespaceImport(moduleName);
      return ts.factory.createPropertyAccessExpression(ns, nameText);
    }
    return ts.factory.createIdentifier(nameText);
  }

  referenceExternalSymbol(moduleName: string, name: string): ts.Expression {
    const ns = this.getNamespaceImport(moduleName);
    return ts.factory.createPropertyAccessExpression(ns, name);
  }

  referenceExternalType(moduleName: string, name: string, typeParams?: Type[]): ts.TypeNode {
    const ns = this.getNamespaceImport(moduleName);
    const identifier = ts.factory.createIdentifier(name);
    // Type[] from @angular/compiler needs to be converted if used. In detached mode we might
    // skip generic args for now, as full conversion requires a translator approach.
    // For simplicity here, we omit `typeParams` or just use `any`.
    return ts.factory.createTypeReferenceNode(
      ts.factory.createQualifiedName(ns, identifier),
      undefined, // We can improve type argument conversion if needed later.
    );
  }

  referenceType(refOrDir: Reference<ts.Declaration> | TcbDirectiveMetadata): ts.TypeNode {
    if ('node' in refOrDir) {
      const ref = refOrDir as Reference<ts.Declaration>;
      const nameNode = (ref.node as any).name;
      const nameText = nameNode
        ? typeof nameNode === 'string'
          ? nameNode
          : nameNode.text
        : 'UNKNOWN';
      const moduleName = (ref as any).moduleName;
      if (moduleName) {
        const ns = this.getNamespaceImport(moduleName);
        return ts.factory.createTypeReferenceNode(
          ts.factory.createQualifiedName(ns, ts.factory.createIdentifier(nameText)),
          undefined,
        );
      }
      return ts.factory.createTypeReferenceNode(ts.factory.createIdentifier(nameText), undefined);
    } else {
      const dir = refOrDir as TcbDirectiveMetadata;
      const ns = this.getNamespaceImport(dir.moduleName);
      return ts.factory.createTypeReferenceNode(
        ts.factory.createQualifiedName(ns, ts.factory.createIdentifier(dir.name)),
        undefined,
      );
    }
  }

  canReferenceType(ref: Reference<ts.Declaration>): boolean {
    return true;
  }

  referenceTransplantedType(type: TransplantedType<any>): ts.TypeNode {
    throw new Error('referenceTransplantedType is not supported in DetachedTcbEnvironment');
  }

  getImports(): ts.Statement[] {
    return this.importStatements;
  }

  getPreludeStatements(): ts.Statement[] {
    return [...this.pipeInstStatements, ...this.typeCtorStatements];
  }
}
