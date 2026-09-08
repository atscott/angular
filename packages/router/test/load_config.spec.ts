/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {Component, inject, InjectionToken} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {
  provideRouter,
  Route,
  Router,
  RouterOutlet,
  PreloadAllModules,
  RouterPreloader,
  withPreloading,
  RouteConfigLoadStart,
  RouteConfigLoadEnd,
} from '../index';
import {RouterTestingHarness} from '../testing';
import {useAutoTick, timeout} from '../../private/testing/src/utils';
import {isConfigLoaded} from '../src/utils/config';

const LAZY_TOKEN = new InjectionToken<string>('LAZY_TOKEN');

@Component({
  template: 'simple-cmp: {{ val }}',
})
class SimpleCmp {
  val = inject(LAZY_TOKEN, {optional: true});
}

@Component({
  template: 'parent: <router-outlet></router-outlet>',
  imports: [RouterOutlet],
})
class ParentCmp {}

@Component({
  template: 'child',
})
class ChildCmp {}

@Component({
  template: 'home',
})
class HomeCmp {}

describe('Route loadConfig', () => {
  useAutoTick();

  it('loads config during recognition, creates route injector, and caches config without emitting load events', async () => {
    let loadCount = 0;
    const events: any[] = [];

    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {path: '', component: HomeCmp},
          {
            path: 'lazy',
            component: SimpleCmp,
            loadConfig: () => {
              loadCount++;
              return Promise.resolve({
                providers: [{provide: LAZY_TOKEN, useValue: 'lazy-val'}],
              });
            },
          },
        ]),
      ],
    });

    const router = TestBed.inject(Router);
    router.events.subscribe((e) => events.push(e));

    const harness = await RouterTestingHarness.create('/lazy');
    expect(loadCount).toBe(1);
    expect(harness.routeNativeElement?.innerHTML).toContain('simple-cmp: lazy-val');

    expect(
      events.some((e) => e instanceof RouteConfigLoadStart || e instanceof RouteConfigLoadEnd),
    ).toBeFalse();

    await harness.navigateByUrl('/');
    await harness.navigateByUrl('/lazy');
    expect(loadCount).toBe(1);
  });

  it('evaluates loadConfig sequentially during recognition and loadComponent in parallel post-recognition', async () => {
    let parentConfigLoaded = false;
    let childConfigLoaded = false;
    let parentComponentStarted = false;
    let childComponentStarted = false;

    let resolveComponents!: () => void;
    const componentPromise = new Promise<void>((resolve) => (resolveComponents = resolve));

    const routes: Route[] = [
      {
        path: 'parent',
        loadConfig: async () => {
          parentConfigLoaded = true;
          expect(childConfigLoaded).toBeFalse();
          return {};
        },
        loadComponent: () => {
          parentComponentStarted = true;
          return componentPromise.then(() => ParentCmp);
        },
        children: [
          {
            path: 'child',
            loadConfig: async () => {
              expect(parentConfigLoaded).toBeTrue();
              childConfigLoaded = true;
              return {};
            },
            loadComponent: () => {
              childComponentStarted = true;
              return componentPromise.then(() => ChildCmp);
            },
          },
        ],
      },
    ];

    TestBed.configureTestingModule({
      providers: [provideRouter(routes)],
    });

    const harness = await RouterTestingHarness.create();
    const nav = harness.navigateByUrl('/parent/child');
    await timeout();

    expect(parentConfigLoaded).toBeTrue();
    expect(childConfigLoaded).toBeTrue();
    expect(parentComponentStarted).toBeTrue();
    expect(childComponentStarted).toBeTrue();

    resolveComponents();
    await nav;

    expect(harness.routeNativeElement?.innerHTML).toContain('parent:');
    expect(harness.routeNativeElement?.innerHTML).toContain('child');
  });

  it('propagates route injector to child routes', async () => {
    @Component({
      template: 'child: {{ val }}',
    })
    class ChildWithInject {
      val = inject(LAZY_TOKEN);
    }

    const routes: Route[] = [
      {
        path: 'parent',
        component: ParentCmp,
        loadConfig: () =>
          Promise.resolve({
            providers: [{provide: LAZY_TOKEN, useValue: 'from-parent'}],
          }),
        children: [{path: 'child', component: ChildWithInject}],
      },
    ];

    TestBed.configureTestingModule({providers: [provideRouter(routes)]});
    const harness = await RouterTestingHarness.create('/parent/child');
    expect(harness.routeNativeElement?.innerHTML).toContain('child: from-parent');
  });

  it('supports canMatch and DI tokens returned from loadConfig', async () => {
    let allow = false;

    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {path: '', component: HomeCmp},
          {
            path: 'guarded',
            component: SimpleCmp,
            loadConfig: () =>
              Promise.resolve({
                providers: [{provide: LAZY_TOKEN, useValue: 'lazy-val'}],
                canMatch: [() => allow && inject(LAZY_TOKEN) === 'lazy-val'],
              }),
          },
          {path: 'guarded', component: HomeCmp},
        ]),
      ],
    });

    const harness = await RouterTestingHarness.create('/guarded');
    expect(harness.routeNativeElement?.innerHTML).toContain('home');

    allow = true;
    await harness.navigateByUrl('/');
    await harness.navigateByUrl('/guarded');
    expect(harness.routeNativeElement?.innerHTML).toContain('simple-cmp: lazy-val');
  });

  it('preloads loadConfig routes with PreloadAllModules', async () => {
    let loaded = false;

    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            {path: '', component: HomeCmp},
            {
              path: 'lazy',
              component: SimpleCmp,
              loadConfig: () => {
                loaded = true;
                return Promise.resolve({data: {preloaded: true}});
              },
            },
          ],
          withPreloading(PreloadAllModules),
        ),
      ],
    });

    await RouterTestingHarness.create('/');
    const preloader = TestBed.inject(RouterPreloader);
    await preloader.preload().toPromise();

    expect(loaded).toBeTrue();
    const router = TestBed.inject(Router);
    expect(isConfigLoaded(router.config[1])).toBeTrue();
    expect(router.config[1].data).toEqual({preloaded: true});
  });

  it('throws error when loadConfig is used with redirectTo', () => {
    expect(() => {
      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {path: 'invalid', redirectTo: 'home', loadConfig: () => Promise.resolve({})},
          ]),
        ],
      });
      TestBed.inject(Router);
    }).toThrowError(/redirectTo and loadConfig cannot be used together/);
  });

  it('throws error when loadConfig returns a disallowed property', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {
            path: 'disallowed',
            loadConfig: () => Promise.resolve({children: []} as any),
          },
        ]),
      ],
    });
    const harness = await RouterTestingHarness.create();
    await expectAsync(harness.navigateByUrl('/disallowed')).toBeRejectedWithError(
      /property 'children' cannot be returned from 'loadConfig'/,
    );
  });

  it('throws error when loadConfig returns a property already defined on the route', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter([
          {
            path: 'override',
            component: SimpleCmp,
            data: {eager: true},
            loadConfig: () => Promise.resolve({data: {lazy: true}}),
          },
        ]),
      ],
    });
    const harness = await RouterTestingHarness.create();
    await expectAsync(harness.navigateByUrl('/override')).toBeRejectedWithError(
      /property 'data' is already defined on the route and cannot be overridden by 'loadConfig'/,
    );
  });
});
