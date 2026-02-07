import ts from 'typescript';
import {TypeCheckingConfig} from '../api';
import {TcbDirectiveMetadata, TcbPipeMetadata} from '../api/tcb_metadata';
import {TransplantedType, Type} from '@angular/compiler';
import {TcbEnvironment} from './tcb_environment';
import {Reference} from '../../imports';

/**
 * An implementation of `TcbEnvironment` that does not depend on a live `ts.Program` or
 * `ReflectionHost`. It uses the module names provided in detached metadata interfaces
 * (`TcbDirectiveMetadata` and `TcbPipeMetadata`) to generate explicit imports.
 */
export class DetachedTcbEnvironment implements TcbEnvironment {
  private _nextImportId = 1;

  // Maps a moduleName -> `* as identifier`
  private imports = new Map<string, ts.Identifier>();

  // Optional: keep track of statements you want to insert into the TCB file
  private preludeStatements: ts.Statement[] = [];

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

    this.preludeStatements.push(importDecl);
    return identifier;
  }

  typeCtorFor(dir: TcbDirectiveMetadata): ts.Expression {
    const ns = this.getNamespaceImport(dir.moduleName);
    // Assuming the type constructor is implicitly available or we just cast the directive class
    return ts.factory.createPropertyAccessExpression(ns, dir.name);
  }

  pipeInst(pipe: TcbPipeMetadata): ts.Expression {
    const ns = this.getNamespaceImport(pipe.moduleName);
    return ts.factory.createPropertyAccessExpression(ns, pipe.name);
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
      if (!dir.moduleName) {
        return ts.factory.createTypeReferenceNode(
          ts.factory.createIdentifier(dir.name || 'UNKNOWN'),
          undefined,
        );
      }
      const ns = this.getNamespaceImport(dir.moduleName);
      return ts.factory.createTypeReferenceNode(
        ts.factory.createQualifiedName(ns, ts.factory.createIdentifier(dir.name || 'UNKNOWN')),
        undefined,
      );
    }
  }

  referenceTransplantedType(type: TransplantedType<any>): ts.TypeNode {
    throw new Error('referenceTransplantedType is not supported in DetachedTcbEnvironment');
  }

  getPreludeStatements(): ts.Statement[] {
    return this.preludeStatements;
  }
}
