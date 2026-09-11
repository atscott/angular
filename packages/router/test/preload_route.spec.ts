/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  Component,
  DestroyRef,
  EnvironmentInjector,
  inject,
  resource,
  runInInjectionContext,
} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {EMPTY} from 'rxjs';
import {
  ActivatedRouteSnapshot,
  DetachedRouteHandle,
  Event,
  injectPreloadRoute,
  NavigationEnd,
  nonBlocking,
  provideRouter,
  RedirectCommand,
  Route,
  Router,
  RouteReuseStrategy,
  withRouterResources,
} from '@angular/router';
import {RouterTestingHarness} from '../testing';
import {timeout, useAutoTick} from '../../private/testing/src/utils';

@Component({template: '<div>Initial</div>'})
class RootCmp {}

@Component({template: '<div>A</div>'})
class ComponentA {}

@Component({template: '<div>B</div>'})
class ComponentB {}

describe('injectPreloadRoute', () => {
  useAutoTick();

  async function setup(routes: Route[], withResources = true) {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes, ...(withResources ? [withRouterResources()] : []))],
    });
    const harness = await RouterTestingHarness.create();
    const router = TestBed.inject(Router);
    const injector = TestBed.inject(EnvironmentInjector);
    const preloadRoute = runInInjectionContext(injector, () => injectPreloadRoute());
    const preload = (url: string | ReturnType<Router['parseUrl']>, signal?: AbortSignal) =>
      preloadRoute(url, {signal});
    return {harness, router, preload, preloadRoute, injector};
  }

  it('preloads dynamic component imports via loadComponent', async () => {
    let loaderCalled = false;
    const routes: Route[] = [
      {
        path: 'lazy-comp',
        loadComponent: () => {
          loaderCalled = true;
          return Promise.resolve(ComponentA);
        },
      },
    ];
    const {router, preload} = await setup(routes);

    expect(loaderCalled).toBeFalse();
    expect((router.config[0] as any)._loadedComponent).toBeUndefined();

    await preload('/lazy-comp');

    expect(loaderCalled).toBeTrue();
    expect((router.config[0] as any)._loadedComponent).toBe(ComponentA);
  });

  it('returns a function that can be called outside of an injection context', async () => {
    let loaderCalled = false;
    const routes: Route[] = [
      {
        path: 'lazy-comp',
        loadComponent: () => {
          loaderCalled = true;
          return Promise.resolve(ComponentA);
        },
      },
    ];
    const {preloadRoute} = await setup(routes);

    // Called the way an event handler would: no injection context, no injector.
    await preloadRoute('/lazy-comp');

    expect(loaderCalled).toBeTrue();
  });

  it('throws when created outside of an injection context', async () => {
    await setup([{path: 'a', component: ComponentA}]);

    expect(() => injectPreloadRoute()).toThrowError(/inject\(\)/);
  });

  it('accepts a UrlTree', async () => {
    let loaderCalled = false;
    const routes: Route[] = [
      {
        path: 'lazy-comp',
        loadComponent: () => {
          loaderCalled = true;
          return Promise.resolve(ComponentA);
        },
      },
    ];
    const {router, preload} = await setup(routes);

    await preload(router.parseUrl('/lazy-comp'));

    expect(loaderCalled).toBeTrue();
  });

  it('preloads lazy children (loadChildren) and bypasses deprecated canLoad guards', async () => {
    let loadChildrenCalled = false;
    let canLoadCalled = false;

    const routes: Route[] = [
      {
        path: 'lazy-module',
        canLoad: [
          () => {
            canLoadCalled = true;
            return false;
          },
        ],
        loadChildren: () => {
          loadChildrenCalled = true;
          return Promise.resolve([{path: 'child', component: ComponentB}]);
        },
      },
    ];
    const {router, preload} = await setup(routes);

    await preload('/lazy-module/child');

    expect(loadChildrenCalled).toBeTrue();
    expect(canLoadCalled).toBeFalse();
    expect((router.config[0] as any)._loadedRoutes).toBeDefined();
  });

  it('executes canMatch guards during preloading', async () => {
    let canMatchACalled = false;
    let canMatchBCalled = false;
    let resolverBCalled = false;

    const routes: Route[] = [
      {
        path: 'feature',
        canMatch: [
          () => {
            canMatchACalled = true;
            return false;
          },
        ],
        component: ComponentA,
      },
      {
        path: 'feature',
        canMatch: [
          () => {
            canMatchBCalled = true;
            return true;
          },
        ],
        resolve: {
          data: () => {
            resolverBCalled = true;
            return 'b-data';
          },
        },
        component: ComponentB,
      },
    ];
    const {preload} = await setup(routes);

    await preload('/feature');

    expect(canMatchACalled).toBeTrue();
    expect(canMatchBCalled).toBeTrue();
    expect(resolverBCalled).toBeTrue();
  });

  it('follows canMatch redirects (UrlTree)', async () => {
    let targetResolved = false;

    const routes: Route[] = [
      {
        path: 'source',
        canMatch: [
          () => {
            const router = inject(Router);
            return router.parseUrl('/target');
          },
        ],
        component: ComponentA,
      },
      {
        path: 'target',
        resolve: {
          data: () => {
            targetResolved = true;
            return 'target-data';
          },
        },
        component: ComponentB,
      },
    ];
    const {preload} = await setup(routes);

    await preload('/source');

    expect(targetResolved).toBeTrue();
  });

  it('gives up (without throwing) when redirects never settle', async () => {
    const warnSpy = spyOn(console, 'warn');
    const routes: Route[] = [
      {
        path: 'ping',
        canMatch: [() => inject(Router).parseUrl('/pong')],
        component: ComponentA,
      },
      {
        path: 'pong',
        canMatch: [() => inject(Router).parseUrl('/ping')],
        component: ComponentB,
      },
    ];
    const {preload} = await setup(routes);

    await expectAsync(preload('/ping')).toBeResolved();
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.calls.mostRecent().args[0]).toContain('redirects');
  });

  it('follows route config redirectTo', async () => {
    let targetComponentLoaded = false;

    const routes: Route[] = [
      {
        path: 'old-path',
        redirectTo: 'new-path',
        pathMatch: 'full',
      },
      {
        path: 'new-path',
        loadComponent: () => {
          targetComponentLoaded = true;
          return Promise.resolve(ComponentB);
        },
      },
    ];
    const {preload} = await setup(routes);

    await preload('/old-path');

    expect(targetComponentLoaded).toBeTrue();
  });

  it('runs resolvers without executing canActivate guards', async () => {
    let canActivateCalled = false;
    let resolverCalled = false;

    const routes: Route[] = [
      {
        path: 'resolved',
        canActivate: [
          () => {
            canActivateCalled = true;
            return false;
          },
        ],
        resolve: {
          item: () => {
            resolverCalled = true;
            return Promise.resolve({id: 123});
          },
        },
        component: ComponentA,
      },
    ];
    const {preload} = await setup(routes);

    await preload('/resolved');

    expect(resolverCalled).toBeTrue();
    expect(canActivateCalled).toBeFalse();
  });

  it('continues past a resolver that completes without emitting', async () => {
    let childResolverCalled = false;

    const routes: Route[] = [
      {
        path: 'parent',
        resolve: {data: () => EMPTY},
        children: [
          {
            path: 'child',
            resolve: {
              data: () => {
                childResolverCalled = true;
                return 'child-data';
              },
            },
            component: ComponentB,
          },
        ],
      },
    ];
    const {preload} = await setup(routes);

    await expectAsync(preload('/parent/child')).toBeResolved();
    expect(childResolverCalled).toBeTrue();
  });

  it('follows resolver redirects (RedirectCommand)', async () => {
    let targetResolverCalled = false;

    const routes: Route[] = [
      {
        path: 'redirecting-resolver',
        resolve: {
          data: () => {
            const router = inject(Router);
            return new RedirectCommand(router.parseUrl('/target-after-redirect'));
          },
        },
        component: ComponentA,
      },
      {
        path: 'target-after-redirect',
        resolve: {
          data: () => {
            targetResolverCalled = true;
            return 'destination';
          },
        },
        component: ComponentB,
      },
    ];
    const {preload} = await setup(routes);

    await preload('/redirecting-resolver');

    expect(targetResolverCalled).toBeTrue();
  });

  it('runs resources and waits for blocking resources to settle', async () => {
    let resourceLoaded = false;

    const routes: Route[] = [
      {
        path: 'with-resources/:id',
        component: ComponentA,
        resources: ({params}) => ({
          user: resource({
            loader: async () => {
              resourceLoaded = true;
              return {id: params()['id']};
            },
          }),
        }),
      },
    ];
    const {preload} = await setup(routes, true);

    await preload('/with-resources/42');

    expect(resourceLoaded).toBeTrue();
  });

  it('waits for non-blocking resources to settle before destroying their injector', async () => {
    let abortedBeforeCompletion = false;
    let loaderCompleted = false;

    const routes: Route[] = [
      {
        path: 'non-blocking',
        component: ComponentA,
        resources: () => ({
          item: nonBlocking(
            resource({
              loader: async ({abortSignal}) => {
                abortSignal.addEventListener('abort', () => {
                  abortedBeforeCompletion ||= !loaderCompleted;
                });
                await timeout(10);
                loaderCompleted = true;
                return 'value';
              },
            }),
          ),
        }),
      },
    ];
    const {preload} = await setup(routes, true);

    await preload('/non-blocking');

    expect(loaderCompleted).toBeTrue();
    expect(abortedBeforeCompletion).toBeFalse();
  });

  it('does not reject when a non-blocking resource fails', async () => {
    const routes: Route[] = [
      {
        path: 'failing-non-blocking',
        component: ComponentA,
        resources: () => ({
          item: nonBlocking(
            resource({
              loader: async () => {
                throw new Error('nope');
              },
            }),
          ),
        }),
      },
    ];
    const {preload} = await setup(routes, true);

    await expectAsync(preload('/failing-non-blocking')).toBeResolved();
  });

  it('destroys transient injectors created for resources during preloading', async () => {
    let wasDestroyed = false;

    const routes: Route[] = [
      {
        path: 'with-resources-cleanup',
        component: ComponentA,
        resources: () => {
          inject(DestroyRef).onDestroy(() => {
            wasDestroyed = true;
          });
          return {
            item: resource({loader: async () => 'hello'}),
          };
        },
      },
    ];
    const {preload} = await setup(routes, true);

    await preload('/with-resources-cleanup');

    expect(wasDestroyed).toBeTrue();
  });

  it('does not reuse or mutate routes stored by a custom RouteReuseStrategy', async () => {
    let storedHandle: DetachedRouteHandle | null = null;
    let retrieveCalled = false;

    class StoringReuseStrategy implements RouteReuseStrategy {
      shouldDetach(): boolean {
        return true;
      }
      store(_route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
        if (handle) {
          storedHandle = handle;
        }
      }
      shouldAttach(): boolean {
        return storedHandle !== null;
      }
      retrieve(): DetachedRouteHandle | null {
        retrieveCalled = true;
        return storedHandle;
      }
      shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
        return future.routeConfig === curr.routeConfig;
      }
    }

    const routes: Route[] = [
      {path: '', component: RootCmp},
      {path: 'reused', component: ComponentA},
    ];
    TestBed.configureTestingModule({
      providers: [
        provideRouter(routes, withRouterResources()),
        {provide: RouteReuseStrategy, useClass: StoringReuseStrategy},
      ],
    });
    const harness = await RouterTestingHarness.create();
    const router = TestBed.inject(Router);
    const injector = TestBed.inject(EnvironmentInjector);

    await harness.navigateByUrl('/reused');
    await harness.navigateByUrl('/');
    expect(storedHandle).not.toBeNull();

    const routeBeforePreload = (storedHandle as any).route.value;
    retrieveCalled = false;

    const preloadRoute = runInInjectionContext(injector, () => injectPreloadRoute());
    await preloadRoute('/reused');

    expect(retrieveCalled).toBeFalse();
    // The stored route must not have been touched (in particular, it must not be left pending).
    expect((storedHandle as any).route.value).toBe(routeBeforePreload);
    expect(routeBeforePreload.pending?.()).toBeFalsy();
    expect(router.url).toBe('/');
  });

  it('supports concurrent preloads without cancelling each other', async () => {
    let compALoaded = false;
    let compBLoaded = false;

    const routes: Route[] = [
      {
        path: 'comp-a',
        loadComponent: () => {
          compALoaded = true;
          return Promise.resolve(ComponentA);
        },
      },
      {
        path: 'comp-b',
        loadComponent: () => {
          compBLoaded = true;
          return Promise.resolve(ComponentB);
        },
      },
    ];
    const {preload} = await setup(routes);

    await Promise.all([preload('/comp-a'), preload('/comp-b')]);

    expect(compALoaded).toBeTrue();
    expect(compBLoaded).toBeTrue();
  });

  it('deduplicates concurrent preloads of the same URL', async () => {
    let resolverCalls = 0;

    const routes: Route[] = [
      {
        path: 'deduped',
        component: ComponentA,
        resolve: {
          data: async () => {
            resolverCalls++;
            await timeout(10);
            return 'data';
          },
        },
      },
    ];
    const {preload} = await setup(routes);

    await Promise.all([preload('/deduped'), preload('/deduped'), preload('/deduped')]);

    expect(resolverCalls).toBe(1);

    // Once the preload settles, a subsequent call runs again.
    await preload('/deduped');
    expect(resolverCalls).toBe(2);
  });

  it('stops work when every caller aborts', async () => {
    let resolverCalled = false;
    const controller = new AbortController();

    const routes: Route[] = [
      {
        path: 'aborted',
        loadComponent: async () => {
          controller.abort();
          return ComponentA;
        },
        resolve: {
          data: () => {
            resolverCalled = true;
            return 'data';
          },
        },
      },
    ];
    const {preload} = await setup(routes);

    await expectAsync(preload('/aborted', controller.signal)).toBeResolved();
    expect(resolverCalled).toBeFalse();
  });

  it('does not abort a shared preload while another caller is still interested', async () => {
    let resolverCalled = false;
    const controller = new AbortController();

    const routes: Route[] = [
      {
        path: 'shared',
        loadComponent: async () => {
          controller.abort();
          return ComponentA;
        },
        resolve: {
          data: () => {
            resolverCalled = true;
            return 'data';
          },
        },
      },
    ];
    const {preload} = await setup(routes);

    await Promise.all([preload('/shared', controller.signal), preload('/shared')]);

    expect(resolverCalled).toBeTrue();
  });

  it('does not emit Router navigation events during preloading', async () => {
    const emittedEvents: Event[] = [];

    const routes: Route[] = [
      {
        path: 'events-test',
        component: ComponentA,
        resolve: {data: () => 'sample'},
      },
    ];
    const {router, preload} = await setup(routes);

    router.events.subscribe((e) => emittedEvents.push(e));

    await preload('/events-test');

    expect(emittedEvents.length).toBe(0);
  });

  it('does not alter routerState, currentNavigation, or router.url', async () => {
    const routes: Route[] = [
      {path: '', component: RootCmp},
      {
        path: 'other',
        component: ComponentA,
        resolve: {data: () => 'sample'},
      },
    ];
    const {harness, router, preload} = await setup(routes);
    await harness.navigateByUrl('/');

    expect(router.url).toBe('/');
    expect(router.currentNavigation()).toBeNull();

    await preload('/other');

    expect(router.url).toBe('/');
    expect(router.currentNavigation()).toBeNull();
  });

  it('does not interfere with an in-flight navigation', async () => {
    const events: Event[] = [];
    const routes: Route[] = [
      {path: '', component: RootCmp},
      {
        path: 'slow',
        component: ComponentA,
        resolve: {
          data: async () => {
            await timeout(20);
            return 'slow-data';
          },
        },
      },
      {
        path: 'preloaded',
        component: ComponentB,
        resolve: {data: () => 'preloaded-data'},
      },
    ];
    const {router, preload} = await setup(routes);
    router.events.subscribe((e) => events.push(e));

    const navigation = router.navigateByUrl('/slow');
    const preloading = preload('/preloaded');

    await expectAsync(navigation).toBeResolvedTo(true);
    await preloading;

    expect(router.url).toBe('/slow');
    expect(events.filter((e) => e instanceof NavigationEnd).length).toBe(1);
  });

  it('silently absorbs non-redirect errors (404 / no match, resolver failure)', async () => {
    spyOn(console, 'warn');
    const routes: Route[] = [
      {
        path: 'failing-resolver',
        resolve: {
          data: () => Promise.reject(new Error('Resolver failed')),
        },
        component: ComponentA,
      },
    ];
    const {preload} = await setup(routes);

    // Should resolve without rejecting
    await expectAsync(preload('/non-existent-path')).toBeResolved();
    await expectAsync(preload('/failing-resolver')).toBeResolved();
  });

  it('aborts in-flight preloads when the injector is destroyed', async () => {
    let resolverCalled = false;
    const routes: Route[] = [
      {
        path: 'slow-load',
        loadComponent: async () => {
          await timeout(20);
          return ComponentA;
        },
        resolve: {
          data: () => {
            resolverCalled = true;
            return 'data';
          },
        },
      },
    ];
    const {preload} = await setup(routes);

    const preloading = preload('/slow-load');
    // Destroys the environment injector (and prevents the automatic teardown from using it).
    TestBed.resetTestingModule();
    await preloading;

    expect(resolverCalled).toBeFalse();
  });
});
