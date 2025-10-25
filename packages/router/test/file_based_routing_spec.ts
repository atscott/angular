/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {createFileRoute, generateFileBasedRoutes} from '../tools/file_based_routing';
import mockFs from 'mock-fs';

describe('file-based routing', () => {
  afterEach(() => {
    mockFs.restore();
  });

  it('should generate a route tree for a basic file structure', () => {
    mockFs({
      'routes/__root.ts': `import { createRootRoute } from '@angular/router';
export const Route = createRootRoute();`,
      'routes/index.ts': `import { createFileRoute } from '@angular/router';
export const Route = createFileRoute('/')({ component: () => 'Index' });`,
      'routes/posts/_layout.ts': `import { createFileRoute } from '@angular/router';
export const Route = createFileRoute('/posts')({ component: () => 'Posts Layout' });`,
      'routes/posts/index.ts': `import { createFileRoute } from '@angular/router';
export const Route = createFileRoute('/posts/')({ component: () => 'Posts Index' });`,
      'routes/posts/:postId.ts': `import { createFileRoute } from '@angular/router';
export const Route = createFileRoute('/posts/:postId')({ component: () => 'Post' });`,
    });

    const generatedRoutes = generateFileBasedRoutes('routes');
    expect(generatedRoutes).toContain(`import { Route as __rootRouteImport } from './__root';`);
    expect(generatedRoutes).toContain(
      `import { Route as posts__layoutRouteImport } from './posts/_layout';`,
    );
    expect(generatedRoutes).toContain(
      `const posts__layoutRoute = posts__layoutRouteImport.update({ path: 'posts', getParentRoute: () => __rootRoute } as any);`,
    );
    expect(generatedRoutes).toContain(
      `const posts__postIdRoute = posts__postIdRouteImport.update({ path: ':postId', getParentRoute: () => posts__layoutRoute } as any);`,
    );
    expect(generatedRoutes).toContain('export const routeTree = __rootRoute.addChildren([');
    expect(generatedRoutes).toContain('posts__layoutRoute.addChildren([');
    expect(generatedRoutes).toContain(
      `'/posts': {
      parentRoute: typeof __rootRouteImport
    },`,
    );
    expect(generatedRoutes).toContain(
      `'/posts/:postId': {
      parentRoute: typeof posts__layoutRouteImport
    },`,
    );
  });

  it('should handle nested directories', () => {
    mockFs({
      'routes/__root.ts': `export const Route = {};`,
      'routes/a/b/c/index.ts': `export const Route = {};`,
    });
    const generatedRoutes = generateFileBasedRoutes('routes');
    expect(generatedRoutes).toContain(
      `import { Route as a_b_c_indexRouteImport } from './a/b/c/index';`,
    );
    expect(generatedRoutes).toContain(
      `const a_b_c_indexRoute = a_b_c_indexRouteImport.update({ path: '', getParentRoute: () => __rootRoute } as any);`,
    );
  });

  it('should throw an error if __root.ts is missing', () => {
    mockFs({
      'routes/index.ts': `export const Route = {};`,
    });
    expect(() => generateFileBasedRoutes('routes')).toThrowError(
      'Could not find __root.ts in routes directory.',
    );
  });
});
