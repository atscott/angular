import ts from 'typescript';

const typeStringCache = new Map<string, ts.TypeNode>();
export function parseTypeStringAsNode(typeStr: string): ts.TypeNode {
  if (typeStringCache.has(typeStr)) {
    return typeStringCache.get(typeStr)!;
  }
  const statementStr = `let x: ${typeStr};`;
  const file = ts.createSourceFile('type.ts', statementStr, ts.ScriptTarget.Latest, false);
  const varStatement = file.statements[0] as ts.VariableStatement;
  const typeNode = varStatement.declarationList.declarations[0].type!;
  typeStringCache.set(typeStr, typeNode);
  return typeNode;
}

const typeParamsCache = new Map<string, ts.TypeParameterDeclaration[]>();
export function parseTypeParametersAsNodes(typeParamsStr: string): ts.TypeParameterDeclaration[] {
  if (typeParamsCache.has(typeParamsStr)) {
    return typeParamsCache.get(typeParamsStr)!;
  }
  const statementStr = `function f<${typeParamsStr}>() {}`;
  const file = ts.createSourceFile('type.ts', statementStr, ts.ScriptTarget.Latest, false);
  const functionDecl = file.statements[0] as ts.FunctionDeclaration;
  const nodes = Array.from(functionDecl.typeParameters || []);
  typeParamsCache.set(typeParamsStr, nodes);
  return nodes;
}

const typeArgsCache = new Map<string, ts.TypeNode[]>();
export function parseTypeArgumentsAsNodes(typeArgsStr: string): ts.TypeNode[] {
  if (typeArgsCache.has(typeArgsStr)) {
    return typeArgsCache.get(typeArgsStr)!;
  }
  const statementStr = `let x: Dummy<${typeArgsStr}>;`;
  const file = ts.createSourceFile('type.ts', statementStr, ts.ScriptTarget.Latest, false);
  const varStatement = file.statements[0] as ts.VariableStatement;
  const typeRef = varStatement.declarationList.declarations[0].type as ts.TypeReferenceNode;
  const nodes = Array.from(typeRef.typeArguments || []);
  typeArgsCache.set(typeArgsStr, nodes);
  return nodes;
}
