/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Type} from '@angular/core';
import {
  AnyRoute,
  BaseRoute,
  CanActivateChildFn,
  CanActivateFn,
  CanDeactivateFn,
  CreateRouteOptions,
  ResolvedData,
  ResolverDataFor,
  Route,
  RouteParams,
  RouteParamsFor,
  ResolverMap,
  PathParams,
} from '../src/typed_router';
import {Route as UntypedRoute} from '../src/index';
import * as fs from 'fs';
import * as path from 'path';

export interface FileRoutesByPath {}

export type ParentRouteFromFilePath<
  TPath extends string,
  TRouteMap = FileRoutesByPath,
> = TPath extends keyof TRouteMap
  ? TRouteMap[TPath] extends {parentRoute: infer P}
    ? P extends Route
      ? P
      : AnyRoute
    : AnyRoute
  : AnyRoute;

export function createFileRoute<
  TFileRoutesByPath = FileRoutesByPath,
  TPath extends string = string,
>(path: TPath) {
  type TParentRoute = ParentRouteFromFilePath<TPath, TFileRoutesByPath>;

  return <
    TData extends Record<string, unknown> = {},
    TResolvers extends ResolverMap<
      RouteParamsFor<TParentRoute, TPath>,
      ResolverDataFor<TParentRoute, TData>
    > = {},
    TComponent = unknown,
  >(
    options: CreateRouteOptions<
      TParentRoute extends Route ? TParentRoute : undefined,
      TPath,
      TData,
      TResolvers,
      TComponent
    >,
  ): BaseRoute<
    TPath,
    TPath,
    TPath,
    RouteParamsFor<TParentRoute, TPath>,
    ResolvedData<TParentRoute>,
    TData,
    {[K in keyof TResolvers]: ReturnType<TResolvers[K]>}
  > => {
    return new BaseRoute({path, ...options} as any) as any;
  };
}

interface RouteNode {
  id: string;
  fileId: string;
  filePath: string; // relative to routes dir
  variableName: string;
  importPath: string;
  pathSegment: string;
  fullPath: string;
  parent?: RouteNode;
  children: RouteNode[];
}

function findRouteFiles(dir: string, rootDir?: string): string[] {
  rootDir ??= dir;
  let files: string[] = [];
  for (const file of fs.readdirSync(dir)) {
    const fullPath = path.join(dir, file);
    if (fs.statSync(fullPath).isDirectory()) {
      files = files.concat(findRouteFiles(fullPath, rootDir));
    } else if (file.endsWith('.ts')) {
      files.push(path.relative(rootDir, fullPath));
    }
  }
  return files;
}

function createRouteNodes(files: string[], routesDir: string): RouteNode[] {
  return files.map((filePath) => {
    const filePathNoExt = filePath.substring(0, filePath.length - 3);

    let fileId = `/${filePathNoExt}`;
    if (fileId === '/__root') {
      fileId = '/';
    } else if (fileId.endsWith('/index')) {
      fileId = fileId.slice(0, -'index'.length);
    } else if (fileId === '/index') {
      fileId = '/';
    }

    const id = filePathNoExt.replace(/[^a-zA-Z0-9_]/g, '_');
    const variableName = `${id}Route`;
    // a/b/c -> a/b/c
    const importPath = path.join(path.dirname(filePath), path.basename(filePathNoExt));

    let pathSegment = path.basename(filePathNoExt);
    if (pathSegment === '_layout') {
      pathSegment = path.basename(path.dirname(filePath));
    } else if (pathSegment === 'index') {
      pathSegment = '';
    }

    return {
      id,
      fileId,
      filePath,
      variableName,
      importPath: `./${importPath}`,
      pathSegment,
      fullPath: '',
      children: [],
    };
  });
}

function linkParents(nodes: RouteNode[]) {
  const rootNode = nodes.find((n) => n.filePath === '__root.ts');
  if (!rootNode) {
    throw new Error('Could not find __root.ts in routes directory.');
  }

  for (const node of nodes) {
    if (node === rootNode) continue;

    let parentDir = path.dirname(node.filePath);
    if (node.filePath.endsWith('/_layout.ts')) {
      parentDir = path.dirname(parentDir);
    }

    let parentNode: RouteNode | undefined;
    while (parentDir !== '.') {
      parentNode = nodes.find((n) => n.filePath === path.join(parentDir, '_layout.ts'));
      if (parentNode) break;
      parentDir = path.dirname(parentDir);
    }

    parentNode ??= rootNode;
    node.parent = parentNode;
    parentNode.children.push(node);
  }
}

function calculateFullPaths(node: RouteNode, parentPath: string = '') {
  node.fullPath = parentPath === '/' ? `/${node.pathSegment}` : `${parentPath}/${node.pathSegment}`;
  if (node.fullPath.endsWith('/') && node.fullPath !== '/') {
    node.fullPath = node.fullPath.slice(0, -1);
  }

  for (const child of node.children) {
    calculateFullPaths(child, node.fullPath);
  }
}

function generateImports(nodes: RouteNode[]): string {
  return nodes
    .map((n) => `import { Route as ${n.variableName}Import } from '${n.importPath}';`)
    .join('\n');
}

function generateRouteDefinitions(rootNode: RouteNode): string {
  let code = '';
  const nodesToProcess = [rootNode];
  while (nodesToProcess.length > 0) {
    const node = nodesToProcess.shift()!;
    if (node.filePath !== '__root.ts') {
      code += `const ${node.variableName} = ${node.variableName}Import.update({ path: '${
        node.pathSegment
      }', getParentRoute: () => ${node.parent!.variableName} } as any);
`;
    } else {
      code += `const ${node.variableName} = ${node.variableName}Import;
`;
    }
    nodesToProcess.push(...node.children);
  }
  return code;
}

function generateRouteTree(rootNode: RouteNode): string {
  const definitions = generateRouteDefinitions(rootNode);

  function buildChildren(node: RouteNode): string {
    if (node.children.length === 0) {
      return '';
    }
    const children = node.children
      .map((child) => `${child.variableName}${buildChildren(child)}`)
      .join(',\n');
    return `.addChildren([\n${children}\n])`;
  }

  const routeTree = `export const routeTree = ${rootNode.variableName}${buildChildren(rootNode)};`;

  return `${definitions}\n${routeTree}`;
}

function generateTypes(nodes: RouteNode[]): string {
  const routeMap = nodes
    .filter((n) => n.filePath !== '__root.ts')
    .map(
      (n) =>
        `    '${n.fileId}': {\n      parentRoute: typeof ${n.parent!.variableName}Import\n    },`,
    )
    .join('\n');

  return `
declare module '@angular/router' {
  interface FileRoutesByPath {
${routeMap}
  }
}
  `;
}

export function generateFileBasedRoutes(routesDir: string): string {
  const files = findRouteFiles(routesDir);
  const nodes = createRouteNodes(files, routesDir);
  linkParents(nodes);
  const rootNode = nodes.find((n) => n.filePath === '__root.ts');
  if (!rootNode) {
    throw new Error('Could not find __root.ts in routes directory.');
  }
  // root node path is '/'
  rootNode.fullPath = '/';
  for (const child of rootNode.children) {
    calculateFullPaths(child, rootNode.fullPath);
  }

  const imports = generateImports(nodes);
  const routeTree = generateRouteTree(rootNode);
  const types = generateTypes(nodes);

  return `
// This file is generated and should not be edited manually.

${imports}

${routeTree}

${types}
  `;
}
