import ts from 'typescript';
import {TypeCheckingConfig} from '../api';
import {TcbDirectiveMetadata, TcbPipeMetadata} from '../api/tcb_metadata';
import {TransplantedType, Type} from '@angular/compiler';

export interface TcbEnvironment {
  readonly config: TypeCheckingConfig;
  typeCtorFor(dir: TcbDirectiveMetadata): ts.Expression;
  pipeInst(pipe: TcbPipeMetadata): ts.Expression;
  referenceExternalSymbol(moduleName: string, name: string): ts.Expression;
  reference(
    ref: import('../../imports').Reference<import('typescript').Declaration>,
  ): import('typescript').Expression;
  referenceExternalType(moduleName: string, name: string, typeParams?: Type[]): ts.TypeNode;
  referenceType(dir: TcbDirectiveMetadata): ts.TypeNode;
  referenceTransplantedType(type: TransplantedType<any>): ts.TypeNode;
  getPreludeStatements(): ts.Statement[];
}
