/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {initMockFileSystem} from '@angular/compiler-cli/src/ngtsc/file_system/testing';
import {setupTsurgeJasmineHelpers} from '../../utils/tsurge/testing/jasmine';
import {runTsurgeMigration} from '../../utils/tsurge/testing';
import {diffText} from '../../utils/tsurge/testing/diff';
import {absoluteFrom} from '@angular/compiler-cli';
import {FunctionalGuardsMigration} from './functional-guards-migration';

describe('functional guards migration', () => {
  beforeEach(() => {
    initMockFileSystem('Native');
    setupTsurgeJasmineHelpers();
  });

  it('should migrate canActivate with only class-based guards', async () => {
    await verify({
      before: `
          export class MyGuard {
          }

          const route = {
            path: '',
            canActivate: [MyGuard],
          };
        `,
      after: `import { mapToCanActivate } from '@angular/router';
          export class MyGuard {
          }

          const route = {
            path: '',
            canActivate: mapToCanActivate([MyGuard]),
          };`,
    });
  });

  it('should migrate not canActivate with only functional guards', async () => {
    await verify({
      before: `
          const route = {
            path: '',
            canActivate: [() => true],
          };
        `,
      after: `const route = {
            path: '',
            canActivate: [() => true],
          };`,
    });
  });

  it('should migrate when using a matcher instead of path on the route', async () => {
    await verify({
      before: `
          export class MyGuard { }

          const route = {
            matcher: () => {},
            canActivate: [MyGuard],
          };
        `,
      after: `import { mapToCanActivate } from '@angular/router';
          export class MyGuard { }

          const route = {
            matcher: () => {},
            canActivate: mapToCanActivate([MyGuard]),
          };`,
    });
  });

  it('should not migrate when there is no path or matcher (these are required on the route)', async () => {
    await verify({
      before: `
          export class MyGuard { }

          const route = {
            canActivate: [MyGuard],
          };
        `,
      after: `export class MyGuard { }

          const route = {
            canActivate: [MyGuard],
          };`,
    });
  });

  it('should migrate canActivate with mixed guards', async () => {
    await verify({
      before: `
          export class MyGuard {}

          const route = {
            path: '',
            canActivate: [() => true, MyGuard],
          };
        `,
      after: `import { mapToCanActivate } from '@angular/router';
          export class MyGuard {}

          const route = {
            path: '',
            canActivate: [() => true, ...mapToCanActivate([MyGuard])],
          };`,
    });
  });

  it('should migrate resolve properties', async () => {
    await verify({
      before: `
          export class ResolveMyData2 {}
          export class ResolveMyData3 {}

          const route = {
            path: '',
            resolve: {
              'data1': () => 'data1',
              'data2': ResolveMyData2,
              data3: ResolveMyData3,
            }
          };
        `,
      after: `import { mapToResolve } from '@angular/router';
          export class ResolveMyData2 {}
          export class ResolveMyData3 {}

          const route = {
            path: '',
            resolve: {
              'data1': () => 'data1',
              'data2': mapToResolve(ResolveMyData2),
              data3: mapToResolve(ResolveMyData3),
            }
          };`,
    });
  });

  it('should migrate title resolvers', async () => {
    await verify({
      before: `
          export class ResolveTitle {}

          const route = {
            path: '',
            title: ResolveTitle,
          };
        `,
      after: `import { mapToResolve } from '@angular/router';
          export class ResolveTitle {}

          const route = {
            path: '',
            title: mapToResolve(ResolveTitle),
          };`,
    });
  });

  it('should migrate all properties at once', async () => {
    await verify({
      before: `
          export class MyClass {}

          const route = {
            path: '',
            title: MyClass,
            resolve: {
              data: MyClass
            },
            canActivate: [MyClass],
            canActivateChild: [MyClass],
            canDeactivate: [MyClass],
            canMatch: [MyClass],
          };
        `,
      after: `import { mapToResolve, mapToCanActivate, mapToCanActivateChild, mapToCanDeactivate, mapToCanMatch } from '@angular/router';
          export class MyClass {}

          const route = {
            path: '',
            title: mapToResolve(MyClass),
            resolve: {
              data: mapToResolve(MyClass)
            },
            canActivate: mapToCanActivate([MyClass]),
            canActivateChild: mapToCanActivateChild([MyClass]),
            canDeactivate: mapToCanDeactivate([MyClass]),
            canMatch: mapToCanMatch([MyClass]),
          };`,
    });
  });

  it('migrates injection token guards and resolvers', async () => {
    await verify({
      before: `
    import {InjectionToken} from '@angular/core';

    const resolveTitleToken = new InjectionToken<() => string>('');
    const canActivateToken = new InjectionToken<() => boolean>('');

    const route = {
      path: '',
      title: resolveTitleToken,
      canActivate: [canActivateToken],
    };
  `,
      after: `import {InjectionToken} from '@angular/core';

    const resolveTitleToken = new InjectionToken<() => string>('');
    const canActivateToken = new InjectionToken<() => boolean>('');

    const route = {
      path: '',
      title: resolveTitleToken,
      canActivate: [canActivateToken],
    };`,
    });
  });

  // TODO: test imported classes
});

async function verify(testCase: {before: string; after: string}) {
  const {fs} = await runTsurgeMigration(new FunctionalGuardsMigration(), [
    {
      name: absoluteFrom('/app.component.ts'),
      isProgramRootFile: true,
      contents: testCase.before,
    },
  ]);

  const actual = fs.readFile(absoluteFrom('/app.component.ts')).trim();
  const expected = testCase.after.trim();

  expect(actual).withContext(diffText(expected, actual)).toEqual(expected);
}
