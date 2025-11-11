/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  ApplicationRef,
  Component,
  computed,
  DestroyRef,
  Injector,
  Injectable,
  inject,
  ɵpromiseWithResolvers as promiseWithResolvers,
  signal,
} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {NavigationError} from '../src/events';
import {provideRouter, withRouterConfig} from '../src/provide_router';
import {Router} from '../src/router';
import {RouterTestingHarness} from '../testing';
import {ResourceContext, Route, Routes} from '../src/models';
import {blocking, routerResource} from '../src/router_resource';
import {timeout, useAutoTick} from './helpers';
import {Event} from '../src/events';
import {ActivatedRouteSnapshot} from '../src/router_state';
import {
  DetachedRouteHandle,
  destroyDetachedRouteHandle,
  RouteReuseStrategy,
} from '../src/route_reuse_strategy';
import {ActivatedRoute} from '../src/router_state';

const userLoader = (ctx: ResourceContext) => ({
  user: routerResource({
    params: computed(() => ctx.params()['id']),
    loader: ({params: id}) => Promise.resolve({name: `user ${id}`}),
  }),
});

describe('resources', () => {
  useAutoTick();

  async function setup(routes: Route[]) {
    TestBed.configureTestingModule({
      providers: [provideRouter(routes)],
    });
    const harness = await RouterTestingHarness.create();
    const router: Router = TestBed.inject(Router);
    return {harness, router};
  }

  describe('Basic Functionality', () => {
    it('should execute resources on initial navigation', async () => {
      const resourcesSpy = jasmine.createSpy('loader').and.callFake(() => ({
        data: routerResource({loader: () => Promise.resolve('loaded')}),
      }));

      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const {harness, router} = await setup([
        {path: '', component: TargetCmp, resources: resourcesSpy},
      ]);
      await harness.navigateByUrl('/');
      expect(resourcesSpy).toHaveBeenCalled();
      expect((router.routerState.root.firstChild!.snapshot as any).resourceResult).toEqual({
        data: jasmine.anything(),
      });
    });

    it('should not execute resources on subsequent navigations to the same route', async () => {
      const resourcesSpy = jasmine.createSpy('loader').and.callFake(() => ({
        data: routerResource({loader: () => Promise.resolve('loaded')}),
      }));

      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const {harness} = await setup([{path: ':id', component: TargetCmp, resources: resourcesSpy}]);
      await harness.navigateByUrl('/1');
      expect(resourcesSpy).toHaveBeenCalledTimes(1);
      await harness.navigateByUrl('/2');
      expect(resourcesSpy).toHaveBeenCalledTimes(1);
    });

    it('should commit transaction on successful navigation', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const {harness, router} = await setup([
        {path: ':id', component: TargetCmp, resources: userLoader},
      ]);
      await harness.navigateByUrl('/1');
      await timeout();
      const resource = router.routerState.root.firstChild?.resources?.['user'] as any;
      await timeout();

      expect(resource.status()).toBe('resolved');
      expect(resource.value()).toEqual({name: 'user 1'});
    });

    it('should rollback transaction on failed navigation', async () => {
      let canActivate = true;

      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const {harness, router} = await setup([
        {
          path: ':id',
          component: TargetCmp,
          resources: userLoader,
          canActivate: [() => canActivate],
        },
      ]);
      await harness.navigateByUrl('/1');
      await timeout();
      const resource = router.routerState.root.firstChild?.resources?.['user'] as any;
      expect(resource.value()).toEqual({name: 'user 1'});

      canActivate = false;
      await harness.navigateByUrl('/2');
      await timeout();
      // The navigation is cancelled so the resource should not have updated.
      expect(resource.value()).toEqual({name: 'user 1'});
    });

    it('should wait for blocking resources', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      let resolve: (val: any) => void;
      const promise = new Promise((r) => (resolve = r));
      const resources = () => ({
        user: routerResource.blocking({
          params: () => 'test',
          loader: () => promise,
        }),
      });

      const {harness} = await setup([{path: 'user', component: TargetCmp, resources}]);
      let completed = false;
      const nav = harness.navigateByUrl('/user').then(() => {
        completed = true;
      });

      await timeout();
      expect(completed).toBe(false);

      resolve!({name: 'test'});
      await nav;
      expect(completed).toBe(true);
    });

    it('should cancel navigation when blocking resource promise rejects', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const resources = () => ({
        user: routerResource.blocking({
          params: signal('test'),
          loader: () => Promise.reject<any>('test error'),
        }),
      });

      const {harness, router} = await setup([{path: 'user', component: TargetCmp, resources}]);
      const nav = harness.navigateByUrl('/user').catch(() => {});
      await nav;
      expect(router.url).not.toContain('/user');
    });

    it('should emit NavigationError when blocking resource promise rejects', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const resources = () => ({
        user: routerResource.blocking({
          params: () => 'test',
          loader: () => Promise.reject<any>('test error'),
        }),
      });

      const {harness, router} = await setup([{path: 'user', component: TargetCmp, resources}]);
      const error = await new Promise((resolve) => {
        router.events.subscribe((e) => {
          if (e instanceof NavigationError) resolve((e as NavigationError).error);
        });
        harness.navigateByUrl('/user').catch(() => {});
      });
      expect((error as Error).cause).toBe('test error');
    });

    it('should work with resolvers', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const resources = (ctx: ResourceContext) => ({
        user: routerResource({
          params: ctx.data,
          loader: ({params: data}) => Promise.resolve({name: `user ${data['id']}`}),
        }),
      });

      const {harness, router} = await setup([
        {path: 'user', component: TargetCmp, resources, resolve: {id: () => '123'}},
      ]);
      await harness.navigateByUrl('/user');
      await timeout(2);
      const userResource = router.routerState.root.firstChild?.resources?.['user'] as any;
      expect(userResource.status()).toBe('resolved');
      expect(userResource.value()).toEqual({name: 'user 123'});
    });
  });

  describe('Transactional Behavior', () => {
    it('never executes resources if a new navigation comes in before loader triggers', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const loaderSpy = jasmine.createSpy('loaderSpy').and.returnValue('atscott');

      const {harness, router} = await setup([
        {
          path: 'user/:id',
          component: TargetCmp,
          resources: (ctx: ResourceContext) => ({
            user: routerResource.blocking({
              params: ctx.params,
              loader: loaderSpy,
            }),
          }),
        },
      ]);
      harness.navigateByUrl('/user/1');
      // wait enough for setting up the loader but not enough for the loader effect to execute yet
      await timeout();

      await harness.navigateByUrl('/user/2');
      await whenStable();

      expect(loaderSpy).toHaveBeenCalledTimes(1);
      const userResource = router.routerState.root.firstChild?.resources?.['user'] as any;
      expect(userResource.status()).toBe('resolved');
      expect(userResource.value()).toEqual('atscott');
    });

    it('should abort previous request when a new navigation comes in', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      let resolve!: (val: any) => void;
      const promise = new Promise((r) => (resolve = r));
      let aborted = false;
      const resources = (ctx: ResourceContext) => ({
        user: routerResource.blocking({
          params: ctx.params,
          loader: ({params, abortSignal}) => {
            abortSignal.addEventListener('abort', () => {
              aborted = true;
            });
            if (params['id'] === '1') {
              return promise;
            } else {
              return Promise.resolve({name: 'user 2'});
            }
          },
        }),
      });

      const {harness, router} = await setup([{path: 'user/:id', component: TargetCmp, resources}]);
      harness.navigateByUrl('/user/1');
      await timeout(2);

      await harness.navigateByUrl('/user/2');
      expect(aborted).toBe(true);

      const userResource = router.routerState.root.firstChild?.resources?.['user'] as any;
      expect(userResource.status()).toBe('resolved');
      expect(userResource.value()).toEqual({name: 'user 2'});

      // resolving the old promise should have no effect
      resolve({name: 'user 1'});
      await timeout();
      expect(userResource.status()).toBe('resolved');
      expect(userResource.value()).toEqual({name: 'user 2'});
    });

    it('public signals should not change while a navigation is pending', async () => {
      @Component({standalone: true, template: 'component'})
      class TestCmp {}

      const promise = promiseWithResolvers();
      const resources = () => ({
        data: routerResource.blocking({
          loader: () => promise.promise,
        }),
      });

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {path: 'a', component: TestCmp},
            {path: 'b', component: TestCmp, resources},
          ]),
        ],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);
      await harness.navigateByUrl('/a');

      const navigation = harness.navigateByUrl('/b');
      await timeout(); // allow navigation and loaders to start

      const dataResource = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(dataResource).toBeUndefined();

      promise.resolve('loaded');
      await navigation;

      const resource2 = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(resource2.status()).toBe('resolved');
      expect(resource2.value()).toBe('loaded');
    });

    it('should not update public signals if navigation is cancelled', async () => {
      @Component({standalone: true, template: 'component'})
      class TestCmp {}

      const promise = promiseWithResolvers();

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {path: 'a', component: TestCmp},
            {
              path: 'b',
              component: TestCmp,
              resources: () => ({
                data: routerResource.blocking({
                  loader: () => promise.promise,
                }),
              }),
            },
            {path: 'c', component: TestCmp},
          ]),
        ],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);
      await harness.navigateByUrl('/a');

      harness.navigateByUrl('/b');
      await timeout(); // allow navigation and loaders to start

      await harness.navigateByUrl('/c');
      await timeout();

      expect(router.url).toBe('/c');
      const dataResource = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(dataResource).toBeUndefined();
    });

    it('should wait for blocking loader to finish before updating any signals', async () => {
      @Component({standalone: true, template: 'component'})
      class TestCmp {}

      const slowPromise = promiseWithResolvers();

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {path: 'a', component: TestCmp},
            {
              path: 'b',
              component: TestCmp,
              resources: () => ({
                slow: routerResource.blocking({
                  loader: () => slowPromise.promise,
                }),
                fast: routerResource({
                  loader: () => Promise.resolve('fast resolve'),
                }),
              }),
            },
          ]),
        ],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);
      await harness.navigateByUrl('/a');

      const navigation = harness.navigateByUrl('/b');
      await timeout(); // allow navigation and loaders to start

      const slowResource = router.routerState.root.firstChild?.resources?.['slow'] as any;
      const fastResource = router.routerState.root.firstChild?.resources?.['fast'] as any;
      expect(slowResource).toBeUndefined();
      expect(fastResource).toBeUndefined();

      slowPromise.resolve('slow resolve');
      await navigation;
      await timeout(); // allow non-blocking fast resource to resolve

      const slowResource2 = router.routerState.root.firstChild?.resources?.['slow'] as any;
      const fastResource2 = router.routerState.root.firstChild?.resources?.['fast'] as any;
      expect(slowResource2.value()).toBe('slow resolve');
      expect(fastResource2.value()).toBe('fast resolve');
    });

    it('should ignore stale loads when params change mid-transaction', async () => {
      const externalSignal = signal('initial');
      const promise1 = promiseWithResolvers<string>();
      const promise2 = promiseWithResolvers<string>();
      let promiseCount = 0;
      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {path: 'a', children: []},
            {
              path: 'b/:id',
              children: [],
              resources: (ctx: ResourceContext) => ({
                data: routerResource.blocking({
                  params: computed(() => {
                    const params = ctx.params();
                    expect(params['id']).toBe('123');
                    return {id: params['id'], external: externalSignal()};
                  }),
                  loader: () => {
                    promiseCount++;
                    return promiseCount === 1 ? promise1.promise : promise2.promise;
                  },
                }),
              }),
            },
          ]),
        ],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);
      await harness.navigateByUrl('/a');

      void harness.navigateByUrl('/b/123');
      await timeout(2);

      // While first load is pending, change the external signal, triggering a second load
      externalSignal.set('updated');
      await timeout();

      // Resolve the first, now-stale promise. This should have no effect.
      promise1.resolve('stale data');
      await timeout();

      // Resolve the second promise to complete the navigation
      promise2.resolve('correct data');
      await whenStable();

      const finalResource = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(finalResource.value()).toBe('correct data');
    });

    it('should ignore stale non-blocking loader from a superseded navigation', async () => {
      @Component({standalone: true, template: 'component'})
      class TestCmp {}

      const promise1 = promiseWithResolvers<string>();

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {path: '', component: TestCmp},
            {
              path: 'a',
              component: TestCmp,
              resources: () => ({
                data: routerResource({
                  loader: () => promise1.promise,
                }),
              }),
            },
            {
              path: 'b',
              component: TestCmp,
              resources: () => ({
                data: routerResource.blocking({
                  loader: () => Promise.resolve('correct data'),
                }),
              }),
            },
          ]),
        ],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);
      await harness.navigateByUrl('/');

      // Start a navigation to 'a' with a slow non-blocking loader
      harness.navigateByUrl('/a');
      await timeout();

      // Before 'a' can resolve, start a new navigation to 'b', which completes successfully
      await harness.navigateByUrl('/b');

      const dataResource = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(dataResource.value()).toBe('correct data');

      // Now, resolve the original slow loader from the superseded navigation 'a'
      promise1.resolve('stale data');
      await whenStable();

      // Assert that the stale data did NOT overwrite the correct data
      expect(dataResource.value()).toBe('correct data');
    });

    it('should run loader on rollback of a reused route (treated like a reload)', async () => {
      @Component({standalone: true, template: 'component'})
      class TestCmp {}

      const loaderSpy = jasmine.createSpy('loader').and.callFake(({params}: {params: any}) => {
        return new Promise((r) => setTimeout(() => r({id: params}), 10));
      });

      const routes: Route[] = [
        {path: '', component: TestCmp},
        {
          path: 'user/:id',
          component: TestCmp,
          resources: (ctx: ResourceContext) => ({
            user: routerResource.blocking({
              params: computed(() => ctx.params()['id']),
              loader: loaderSpy,
            }),
          }),
        },
      ];

      TestBed.configureTestingModule({providers: [provideRouter(routes)]});
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);
      await harness.navigateByUrl('/user/1');
      await whenStable();

      expect(loaderSpy).toHaveBeenCalledTimes(1);
      const userResource = router.routerState.root.firstChild?.resources?.['user'] as any;
      expect(userResource.value()).toEqual({id: '1'});

      // Start a new navigation that will be aborted
      harness.navigateByUrl('/user/2');
      await timeout(2);
      // Abort the navigation after it has started
      harness.navigateByUrl('/user/1');
      await whenStable();

      // The navigation should have been cancelled and rolled back.
      // The loader should NOT have been called again because we optimized the rollback.
      expect(loaderSpy).toHaveBeenCalledTimes(2);
      expect(router.url).toBe('/user/1');
      expect(userResource.value()).toEqual({id: '1'});
    });

    it('public signals of a reused route should not change while a navigation is pending', async () => {
      @Component({standalone: true, template: 'component'})
      class TestCmp {}

      const promise = promiseWithResolvers();
      const resources = (ctx: ResourceContext) => ({
        slow: routerResource.blocking({
          params: () => ctx.params()['id'],
          loader: ({params: id}) => (id === 'a' ? Promise.resolve('slow a') : promise.promise),
        }),
        fast: routerResource({
          params: () => ctx.params()['id'],
          loader: ({params: id}) => Promise.resolve(`fast ${id}`),
        }),
      });

      TestBed.configureTestingModule({
        providers: [provideRouter([{path: ':id', component: TestCmp, resources}])],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);
      await harness.navigateByUrl('/a');
      await whenStable();

      const slowResource = router.routerState.root.firstChild?.resources?.['slow'] as any;
      const fastResource = router.routerState.root.firstChild?.resources?.['fast'] as any;
      expect(slowResource.value()).toBe('slow a');
      expect(fastResource.value()).toBe('fast a');

      const navigation = harness.navigateByUrl('/b');
      await timeout(); // allow navigation and fast loader to resolve

      // While the navigation to 'b' is pending (blocked by the slow resource),
      // the public signals of BOTH resources should not have changed.
      // Even though the fast resource has resolved its new value internally,
      // the commit has not happened, so the UI state is stable.
      expect(router.url).toBe('/a');
      expect(slowResource.status()).toBe('resolved');
      expect(slowResource.value()).toBe('slow a');
      expect(fastResource.status()).toBe('resolved');
      expect(fastResource.value()).toBe('fast a');

      promise.resolve('slow b');
      await navigation;

      // After the navigation completes, the signals should be updated.
      expect(slowResource.status()).toBe('resolved');
      expect(slowResource.value()).toBe('slow b');
      expect(fastResource.status()).toBe('resolved');
      expect(fastResource.value()).toBe('fast b');
    });

    it('should correctly rollback a reused resource that depends on external signals', async () => {
      @Component({standalone: true, template: 'component'})
      class TestCmp {}
      const externalSignal = signal('external-a');
      let loaderExecutionCount = 0;

      const resources = (ctx: ResourceContext) => ({
        data: routerResource.blocking({
          params: computed(() => ({id: ctx.params()['id'], external: externalSignal()})),
          loader: ({params}) => {
            loaderExecutionCount++;
            return new Promise((r) => setTimeout(() => r(params), 10));
          },
        }),
      });

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {path: 'other', component: TestCmp},
            {path: ':id', component: TestCmp, resources},
          ]),
        ],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      // 1. Initial navigation to /a
      await harness.navigateByUrl('/a');
      await whenStable();
      const dataResource = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(loaderExecutionCount).toBe(1);
      expect(dataResource.value()).toEqual({id: 'a', external: 'external-a'});

      // 2. Start navigation to /b, which will be cancelled
      harness.navigateByUrl('/b');
      await timeout(2);
      expect(loaderExecutionCount).toBe(2);
      expect(router.url).toBe('/a');

      // 3. Mid-transaction, update the external signal
      externalSignal.set('external-b');
      await timeout();
      expect(loaderExecutionCount).toBe(3);
      expect(router.url).toBe('/a');

      // 4. Cancel the navigation by navigating somewhere else
      TestBed.inject(Router).currentNavigation()?.abort?.();
      await whenStable();

      // 5. Assert that the resource state is correct
      // We had loaded /a with external-a, but after rollback, of the navigation to /b,
      // the external signal had changed to external-b, so the resource should reflect that.
      expect(router.url).toBe('/a');
      expect(loaderExecutionCount).toBe(4);
      expect(dataResource.value()).toEqual({id: 'a', external: 'external-b'});
    });

    it('should rollback reused route resource on cancelled navigation', async () => {
      @Component({standalone: true, template: 'component'})
      class TestCmp {}
      let shouldActivate = true;

      const resources = (ctx: ResourceContext) => ({
        data: routerResource({
          params: () => ctx.params()['id'],
          loader: ({params: id}) => Promise.resolve(id),
        }),
      });

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {
              path: ':id',
              component: TestCmp,
              resources,
              canActivate: [() => shouldActivate],
            },
          ]),
        ],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/a');
      await whenStable();
      const dataResource = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(dataResource.value()).toBe('a');

      // Attempt to navigate to 'b', but the guard will cancel it
      shouldActivate = false;
      await harness.navigateByUrl('/b');
      await whenStable();

      // The navigation was cancelled. The resource should have rolled back its pending state
      // and still reflect the last committed state from '/a'.
      expect(router.url).toBe('/a');
      expect(dataResource.value()).toBe('a');
    });

    it('should handle rapid multiple navigations and only commit the last one', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const loaderSpy = jasmine.createSpy('loader').and.callFake(({params}) => {
        return new Promise((r) => setTimeout(() => r(params), 10));
      });

      const resources = (ctx: ResourceContext) => ({
        data: routerResource.blocking({
          params: ctx.params,
          loader: loaderSpy,
        }),
      });

      const {harness, router} = await setup([{path: ':id', component: TargetCmp, resources}]);

      harness.navigateByUrl('/1');
      harness.navigateByUrl('/2');
      harness.navigateByUrl('/3');

      await timeout(50); // Wait for all to potentially complete

      expect(router.url).toBe('/3');
      const dataResource = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(dataResource.value()).toEqual({id: '3'});
    });
  });

  describe('ResourceContext Integrity', () => {
    it('waits for legacy resolver to complete before running resources', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const resolveSpy = jasmine.createSpy('resolve');
      const loaderSpy = jasmine.createSpy('loader');
      let resolverFinished = false;

      const resources = (ctx: ResourceContext) => {
        loaderSpy();
        expect(resolverFinished).toBe(true);
        return {
          user: routerResource({
            params: ctx.data,
            loader: ({params}) => Promise.resolve({name: `user ${params['id']}`}),
          }),
        };
      };
      const resolver = () => {
        resolveSpy();
        return timeout(50).then(() => {
          resolverFinished = true;
          return '123';
        });
      };

      const {harness, router} = await setup([
        {path: 'user', component: TargetCmp, resources, resolve: {id: resolver}},
      ]);
      await harness.navigateByUrl('/user');
      await timeout();
      await timeout();

      expect(resolveSpy).toHaveBeenCalled();
      expect(loaderSpy).toHaveBeenCalled();
      const userResource = router.routerState.root.firstChild?.resources?.['user'] as any;
      expect(userResource.status()).toBe('resolved');
      expect(userResource.value()).toEqual({name: 'user 123'});
    });

    it('refetches resource when queryParams change', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const resources = (ctx: ResourceContext) => {
        return {
          data: routerResource({
            params: computed(() => ctx.queryParams()['q']),
            loader: ({params: q}) => Promise.resolve({q}),
          }),
        };
      };
      const {harness, router} = await setup([{path: 'test', component: TargetCmp, resources}]);
      await harness.navigateByUrl('/test?q=foo');
      await timeout();
      const dataResource = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(dataResource.value()).toEqual({q: 'foo'});

      await harness.navigateByUrl('/test?q=bar');
      await timeout();
      expect(dataResource.value()).toEqual({q: 'bar'});
    });

    it('refetches resource when fragment changes', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const resources = (ctx: ResourceContext) => {
        return {
          data: routerResource({
            params: computed(() => ctx.fragment()),
            loader: ({params: f}) => Promise.resolve({f}),
          }),
        };
      };
      const {harness, router} = await setup([{path: 'test', component: TargetCmp, resources}]);
      await harness.navigateByUrl('/test#1');
      await timeout();
      const dataResource = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(dataResource.value()).toEqual({f: '1'});

      await harness.navigateByUrl('/test#2');
      await timeout();
      expect(dataResource.value()).toEqual({f: '2'});
    });

    it('should have access to resolvedData from legacy resolvers', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const resources = (ctx: ResourceContext) => {
        return {
          data: routerResource({
            params: ctx.data,
            loader: ({params}) => Promise.resolve(`resolved: ${params['id']}`),
          }),
        };
      };

      const {harness, router} = await setup([
        {
          path: 'test',
          component: TargetCmp,
          resolve: {id: () => '123'},
          resources,
        },
      ]);
      await harness.navigateByUrl('/test');
      await timeout();
      const dataResource = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(dataResource.value()).toBe('resolved: 123');
    });
  });

  describe('resource() API and Manual Reloading', () => {
    it('does not refetch resource without params signal on param change', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const loaderSpy = jasmine.createSpy('loader').and.resolveTo('loaded');
      const resources = () => ({
        data: routerResource({
          loader: loaderSpy,
        }),
      });

      const {harness} = await setup([{path: 'test/:id', component: TargetCmp, resources}]);
      await harness.navigateByUrl('/test/1');
      expect(loaderSpy).toHaveBeenCalledTimes(1);

      await harness.navigateByUrl('/test/2');
      expect(loaderSpy).toHaveBeenCalledTimes(1);
    });

    it('can manually reload a resource without a params signal', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      let count = 0;
      const resources = () => ({
        data: routerResource({
          loader: () => Promise.resolve(++count),
        }),
      });

      const {harness, router} = await setup([{path: 'test', component: TargetCmp, resources}]);
      await harness.navigateByUrl('/test');
      await timeout();
      const dataResource = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(dataResource.value()).toBe(1);

      dataResource.reload();
      await timeout();
      expect(dataResource.value()).toBe(2);
    });

    it('should report reloading status during reload', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const resources = () => ({
        data: routerResource({
          loader: () => new Promise((resolve) => setTimeout(() => resolve('loaded'), 50)),
        }),
      });

      const {harness, router} = await setup([{path: 'test', component: TargetCmp, resources}]);
      await harness.navigateByUrl('/test');
      await timeout(60); // wait for load

      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(resourceRef.status()).toBe('resolved');
      expect(resourceRef.value()).toBe('loaded');

      // Trigger reload
      resourceRef.reload();

      // Should be reloading immediately
      expect(resourceRef.status()).toBe('reloading');

      await timeout(60);
      expect(resourceRef.status()).toBe('resolved');
    });

    it('should transition status correctly during explicit reload', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      let resolveLoader!: (val: string) => void;
      let loaderPromise = new Promise<string>((r) => (resolveLoader = r));

      const resources = () => ({
        data: routerResource({
          loader: () => loaderPromise,
        }),
      });

      const {harness, router} = await setup([{path: 'test', component: TargetCmp, resources}]);

      // 1. Initial load
      await harness.navigateByUrl('/test');
      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;

      // Initially loading (non-blocking)
      expect(resourceRef.status()).toBe('loading');

      resolveLoader('one');
      await timeout();
      expect(resourceRef.status()).toBe('resolved');
      expect(resourceRef.value()).toBe('one');

      // 2. Reload
      // Reset promise for next load
      loaderPromise = new Promise<string>((r) => (resolveLoader = r));

      resourceRef.reload();
      await timeout(); // Wait for reload to start/propagate

      // Should be 'reloading' immediately
      expect(resourceRef.status()).toBe('reloading');
      // Value should be preserved
      expect(resourceRef.value()).toBe('one');

      resolveLoader('two');
      await timeout();

      expect(resourceRef.status()).toBe('resolved');
      expect(resourceRef.value()).toBe('two');
    });

    it('should transition status correctly during param update', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const paramsSignal = signal('1');
      let resolveLoader!: (val: string) => void;
      let loaderPromise = new Promise<string>((r) => (resolveLoader = r));

      const resources = () => ({
        data: routerResource({
          params: paramsSignal,
          loader: () => loaderPromise,
        }),
      });

      const {harness, router} = await setup([{path: 'test', component: TargetCmp, resources}]);

      // 1. Initial load
      await harness.navigateByUrl('/test');
      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;

      expect(resourceRef.status()).toBe('loading');
      resolveLoader('one');
      await timeout();
      expect(resourceRef.status()).toBe('resolved');

      // 2. Update params
      loaderPromise = new Promise<string>((r) => (resolveLoader = r));
      paramsSignal.set('2');
      await timeout(); // Allow effect to run

      // Should be 'loading' because params changed (new request)
      expect(resourceRef.status()).toBe('loading');
      expect(resourceRef.value()).toBe(undefined);

      resolveLoader('two');
      await timeout();
      expect(resourceRef.status()).toBe('resolved');
      expect(resourceRef.value()).toBe('two');
    });

    it('should transition status correctly during router param update', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      let resolveLoader!: (val: string) => void;
      let loaderPromise = new Promise<string>((r) => (resolveLoader = r));

      const resources = (ctx: ResourceContext) => ({
        data: routerResource({
          params: ctx.params,
          loader: ({params}) => {
            return loaderPromise;
          },
        }),
      });

      const {harness, router} = await setup([{path: ':id', component: TargetCmp, resources}]);

      // 1. Initial load
      const nav1 = harness.navigateByUrl('/1');
      await timeout(); // Wait for loader to start
      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;

      expect(resourceRef.status()).toBe('loading');
      resolveLoader('one');
      await nav1;
      await timeout();
      expect(resourceRef.status()).toBe('resolved');
      expect(resourceRef.value()).toBe('one');

      // 2. Update params via navigation
      loaderPromise = new Promise<string>((r) => (resolveLoader = r));
      const nav2 = harness.navigateByUrl('/2');
      await timeout(); // Allow effect to run

      // For non-blocking resource on reused route, it should be 'loading' after commit of navigation?
      // Wait, if it's non-blocking, navigation commits immediately.
      expect(resourceRef.status()).toBe('loading');
      expect(resourceRef.value()).toBe(undefined);

      resolveLoader('two');
      await nav2;
      await timeout();
      expect(resourceRef.status()).toBe('resolved');
      expect(resourceRef.value()).toBe('two');
    });
  });

  describe('Hierarchical & Nested Resources', () => {
    it('should run parent and child resources in parallel', async () => {
      @Component({standalone: true, template: '<router-outlet/>'})
      class ParentCmp {}
      @Component({standalone: true, template: 'child'})
      class ChildCmp {}

      const parentLoader = () => ({
        data: routerResource.blocking({
          params: () => 'parent',
          loader: () => timeout(50).then(() => 'p'),
        }),
      });
      const childLoader = () => ({
        data: routerResource.blocking({
          params: () => 'child',
          loader: () => timeout(50).then(() => 'c'),
        }),
      });

      const routes: Route[] = [
        {
          path: 'parent',
          component: ParentCmp,
          resources: parentLoader,
          children: [{path: 'child', component: ChildCmp, resources: childLoader}],
        },
      ];

      const {harness} = await setup(routes);
      const start = Date.now();
      await harness.navigateByUrl('/parent/child');
      const end = Date.now();

      // If loaders run in series, it would take >100ms.
      // In parallel, it should take just over 50ms.
      expect(end - start).toBeGreaterThanOrEqual(50);
      expect(end - start).toBeLessThan(100);
    });

    it('waits for blocking parent resource but not for non-blocking child', async () => {
      @Component({standalone: true, template: '<router-outlet/>'})
      class ParentCmp {}
      @Component({standalone: true, template: 'child'})
      class ChildCmp {}

      let parentResolved = false;
      const parentLoader = () => ({
        data: routerResource.blocking({
          params: () => 'parent',
          loader: () =>
            timeout(50).then(() => {
              parentResolved = true;
              return 'p';
            }),
        }),
      });
      let childCompleted = false;
      const childLoader = () => ({
        data: routerResource({
          params: () => 'child',
          loader: () =>
            timeout(100).then(() => {
              childCompleted = true;
              return 'c';
            }),
        }),
      });

      const routes: Route[] = [
        {
          path: 'parent',
          component: ParentCmp,
          resources: parentLoader,
          children: [{path: 'child', component: ChildCmp, resources: childLoader}],
        },
      ];

      const {harness} = await setup(routes);
      let navigationCompleted = false;
      const nav = harness.navigateByUrl('/parent/child').then(() => {
        navigationCompleted = true;
      });

      await timeout(60);
      expect(parentResolved).toBe(true);
      expect(navigationCompleted).toBe(true);
      expect(childCompleted).toBe(false);

      await nav;
      await timeout(50);
      expect(childCompleted).toBe(true);
    });

    it('waits for blocking child resource but not for non-blocking parent', async () => {
      @Component({standalone: true, template: '<router-outlet/>'})
      class ParentCmp {}
      @Component({standalone: true, template: 'child'})
      class ChildCmp {}

      let parentCompleted = false;
      const parentLoader = () => ({
        data: routerResource({
          params: () => 'parent',
          loader: () =>
            timeout(100).then(() => {
              parentCompleted = true;
              return 'p';
            }),
        }),
      });
      let childResolved = false;
      const childLoader = () => ({
        data: routerResource.blocking({
          params: () => 'child',
          loader: () =>
            timeout(50).then(() => {
              childResolved = true;
              return 'c';
            }),
        }),
      });

      const routes: Route[] = [
        {
          path: 'parent',
          component: ParentCmp,
          resources: parentLoader,
          children: [{path: 'child', component: ChildCmp, resources: childLoader}],
        },
      ];

      const {harness} = await setup(routes);
      let navigationCompleted = false;
      harness.navigateByUrl('/parent/child').then(() => {
        navigationCompleted = true;
      });

      await timeout();
      expect(navigationCompleted).toBe(false);

      await timeout(60);
      expect(childResolved).toBe(true);
      expect(navigationCompleted).toBe(true);
      expect(parentCompleted).toBe(false);

      await timeout(50);
      expect(parentCompleted).toBe(true);
    });

    it('only runs child resource when navigating from parent to child', async () => {
      @Component({standalone: true, template: '<router-outlet/>'})
      class ParentCmp {}
      @Component({standalone: true, template: 'child'})
      class ChildCmp {}

      const parentLoaderSpy = jasmine.createSpy('parentLoader').and.callFake(() => ({
        data: routerResource({loader: () => Promise.resolve('p')}),
      }));
      const childLoaderSpy = jasmine.createSpy('childLoader').and.callFake(() => ({
        data: routerResource({loader: () => Promise.resolve('c')}),
      }));

      const routes: Route[] = [
        {
          path: 'parent',
          component: ParentCmp,
          resources: parentLoaderSpy,
          children: [{path: 'child', component: ChildCmp, resources: childLoaderSpy}],
        },
      ];

      const {harness} = await setup(routes);
      await harness.navigateByUrl('/parent');
      expect(parentLoaderSpy).toHaveBeenCalledTimes(1);
      expect(childLoaderSpy).not.toHaveBeenCalled();

      await harness.navigateByUrl('/parent/child');
      expect(parentLoaderSpy).toHaveBeenCalledTimes(1);
      expect(childLoaderSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe('Integration with Guards and Redirects', () => {
    it('does not run resources if canActivate guard returns false', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const loaderSpy = jasmine.createSpy('loader');

      const {harness, router} = await setup([
        {path: 'test', component: TargetCmp, resources: loaderSpy, canActivate: [() => false]},
      ]);
      await harness.navigateByUrl('/test');

      expect(loaderSpy).not.toHaveBeenCalled();
      expect(router.url).toBe('/');
    });

    it('does not run resources if canDeactivate guard returns false', async () => {
      @Component({standalone: true, template: 'a'})
      class CmpA {}
      @Component({standalone: true, template: 'b'})
      class CmpB {}

      const resourcesSpy = jasmine.createSpy('resources');

      const {harness, router} = await setup([
        {path: 'a', component: CmpA, canDeactivate: [() => false]},
        {path: 'b', component: CmpB, resources: resourcesSpy},
      ]);
      await harness.navigateByUrl('/a');
      expect(router.url).toBe('/a');

      await harness.navigateByUrl('/b');

      expect(resourcesSpy).not.toHaveBeenCalled();
      expect(router.url).toBe('/a');
    });

    it('cannot have resources on a route with redirectTo', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const loaderSpyA = jasmine.createSpy('loaderA').and.returnValue({});
      const loaderSpyB = jasmine.createSpy('loaderB').and.returnValue({});

      await expectAsync(
        setup([
          {path: 'a', redirectTo: 'b', resources: loaderSpyA},
          {path: 'b', component: TargetCmp, resources: loaderSpyB},
        ]),
      ).toBeRejectedWithError(/Invalid configuration/);
    });
  });

  describe('Error Handling Scenarios', () => {
    it('fails navigation if resources function throws synchronously', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const resources = (ctx: ResourceContext) => {
        throw new Error('Sync Error');
      };

      const {harness, router} = await setup([{path: 'test', component: TargetCmp, resources}]);

      const error = await new Promise((resolve) => {
        router.events.subscribe((e: Event) => {
          if (e instanceof NavigationError) resolve(e.error);
        });
        harness.navigateByUrl('/test').catch(() => {});
      });
      expect(error).toEqual(new Error('Sync Error'));
      expect(router.url).toBe('/');
    });

    it('fails navigation if resource definition throws synchronously', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const functionThatThrows = () => {
        throw new Error('Sync Error in resource');
      };
      const resources = () => ({
        user: routerResource({
          params: signal(functionThatThrows() as any),
          loader: () => Promise.resolve('user'),
        }),
      });

      const {harness, router} = await setup([{path: 'test', component: TargetCmp, resources}]);

      const error = await new Promise((resolve) => {
        router.events.subscribe((e: Event) => {
          if (e instanceof NavigationError) resolve(e.error);
        });
        harness.navigateByUrl('/test').catch(() => {});
      });
      expect(error).toEqual(new Error('Sync Error in resource'));
      expect(router.url).toBe('/');
    });

    it('succeeds navigation with multiple non-blocking resources where one rejects', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      const {harness, router} = await setup([
        {
          path: 'test',
          component: TargetCmp,
          resources: () => ({
            good: routerResource({
              loader: () => Promise.resolve('good data'),
            }),
            bad: routerResource({
              loader: () => Promise.reject('bad data'),
            }),
          }),
        },
      ]);

      await harness.navigateByUrl('/test');
      expect(router.url).toBe('/test');

      await timeout();

      const resources = router.routerState.root.firstChild?.resources;
      const goodResource = resources?.['good'] as any;
      const badResource = resources?.['bad'] as any;

      expect(goodResource.status()).toBe('resolved');
      expect(goodResource.value()).toBe('good data');
      expect(badResource.status()).toBe('error');
      expect(badResource.error().cause).toBe('bad data');
    });
  });

  describe('with RouteReuseStrategy', () => {
    class CustomReuseStrategy implements RouteReuseStrategy {
      shouldDetach(route: ActivatedRouteSnapshot): boolean {
        return true;
      }
      store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle): void {
        this.stored.set(route.routeConfig, handle);
      }
      shouldAttach(route: ActivatedRouteSnapshot): boolean {
        return !!route.routeConfig && !!this.stored.get(route.routeConfig);
      }
      retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
        return this.stored.get(route.routeConfig) ?? null;
      }
      shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
        return future.routeConfig === curr.routeConfig;
      }
      private stored = new Map<any, DetachedRouteHandle>();
    }

    it('retains resource state on detached/reattached route', async () => {
      @Component({standalone: true, template: 'a'})
      class CmpA {}
      @Component({standalone: true, template: 'b'})
      class CmpB {}

      const resourcesSpy = jasmine.createSpy('resources').and.callFake(() => ({
        data: routerResource({
          loader: () => Promise.resolve('loaded'),
        }),
      }));

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {path: 'a', component: CmpA, resources: resourcesSpy},
            {path: 'b', component: CmpB},
          ]),
          {provide: RouteReuseStrategy, useClass: CustomReuseStrategy},
        ],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/a');
      await timeout();
      expect(resourcesSpy).toHaveBeenCalledTimes(1);
      const resource1 = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(resource1.value()).toBe('loaded');

      await harness.navigateByUrl('/b');
      await harness.navigateByUrl('/a');

      expect(resourcesSpy).toHaveBeenCalledTimes(1);
      const resource2 = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(resource2.value()).toBe('loaded');
      expect(resource1).toBe(resource2);
    });
  });

  describe('Resource Injector Destruction', () => {
    it('should destroy the resource injector when the route is deactivated', async () => {
      @Component({template: ''})
      class AppCmp {}

      let resourceInjector: Injector | undefined;
      const routes: Routes = [
        {
          path: 'a',
          component: AppCmp,
          resources: () => {
            resourceInjector = inject(Injector);
            return {};
          },
        },
        {path: 'b', component: AppCmp},
      ];

      TestBed.configureTestingModule({
        providers: [provideRouter(routes)],
      });

      const router = TestBed.inject(Router);
      await router.navigateByUrl('/a');
      expect(resourceInjector).toBeDefined();
      let destroyed = false;
      resourceInjector!.get(DestroyRef).onDestroy(() => (destroyed = true));

      await router.navigateByUrl('/b');
      expect(destroyed).toBe(true);
    });

    it('should NOT destroy the resource injector when the route is reused', async () => {
      @Component({template: ''})
      class AppCmp {}

      let resourceInjector: Injector | undefined;
      const routes: Routes = [
        {
          path: 'a/:id',
          component: AppCmp,
          resources: (ctx) => {
            resourceInjector = inject(Injector);
            return {};
          },
        },
      ];

      TestBed.configureTestingModule({
        providers: [provideRouter(routes)],
      });

      const router = TestBed.inject(Router);
      await router.navigateByUrl('/a/1');
      expect(resourceInjector).toBeDefined();
      let destroyed = false;
      resourceInjector!.get(DestroyRef).onDestroy(() => (destroyed = true));

      await router.navigateByUrl('/a/2');
      expect(destroyed).toBe(false);
    });

    it('should destroy the resource injector when navigation is cancelled before commit', async () => {
      @Component({template: ''})
      class AppCmp {}

      let resourceInjector: Injector | undefined;
      let destroyed = false;
      const routes: Routes = [
        {
          path: 'a',
          component: AppCmp,
          resources: (ctx) => {
            resourceInjector = inject(Injector);
            inject(DestroyRef).onDestroy(() => (destroyed = true));
            // Return a blocking resource that never resolves to hang the navigation
            return {
              data: blocking({
                loader: () => new Promise(() => {}),
              }),
            };
          },
        },
        {path: 'b', component: AppCmp},
      ];

      TestBed.configureTestingModule({
        providers: [provideRouter(routes)],
      });

      const router = TestBed.inject(Router);
      // Start navigation to 'a'
      const navPromise = router.navigateByUrl('/a');
      // Wait for resources to run
      await new Promise((resolve) => setTimeout(resolve, 0));

      // Cancel by navigating to 'b'
      await router.navigateByUrl('/b');
      expect(destroyed).toBe(true);
      // The first navigation should have been cancelled
      await expectAsync(navPromise).toBeResolvedTo(false);
    });

    it('should destroy the resource injector when destroyDetachedRouteHandle is called', async () => {
      @Component({template: ''})
      class AppCmp {}

      @Injectable({providedIn: 'root'})
      class CustomReuseStrategy extends RouteReuseStrategy {
        storedHandle: DetachedRouteHandle | null = null;
        shouldDetach(route: ActivatedRouteSnapshot): boolean {
          return route.routeConfig?.path === 'a';
        }
        store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
          this.storedHandle = handle;
        }
        shouldAttach(route: ActivatedRouteSnapshot): boolean {
          return false;
        }
        retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
          return null;
        }
        shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
          return future.routeConfig === curr.routeConfig;
        }
      }

      let destroyed = false;
      let resourceInjector: Injector | undefined;
      const routes: Routes = [
        {
          path: 'a',
          component: AppCmp,
          resources: (ctx) => {
            resourceInjector = inject(Injector);
            inject(DestroyRef).onDestroy(() => (destroyed = true));
            return {};
          },
        },
        {path: 'b', component: AppCmp},
      ];

      TestBed.configureTestingModule({
        providers: [
          provideRouter(routes),
          {provide: RouteReuseStrategy, useClass: CustomReuseStrategy},
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);
      const strategy = TestBed.inject(RouteReuseStrategy) as CustomReuseStrategy;

      // Navigate to 'a' to create the resource and injector
      await router.navigateByUrl('/a');

      // Navigate to 'b' to detach 'a'
      await router.navigateByUrl('/b');
      expect(strategy.storedHandle).toBeDefined();

      // Should NOT be destroyed yet because it's detached/stored
      expect(destroyed).toBe(false);

      // Manually destroy the handle
      destroyDetachedRouteHandle(strategy.storedHandle!);
      expect(destroyed).toBe(true);
    });
  });

  describe('Params Visibility & Timing', () => {
    it('resource sees NEW params while component sees OLD params during pending navigation (reused route)', async () => {
      @Component({standalone: true, template: ''})
      class TestCmp {
        route = inject(ActivatedRoute);
      }

      let resourceParams: any;
      const loadResolvers: Array<(val: string) => void> = [];
      const resources = (ctx: ResourceContext) => ({
        data: routerResource.blocking({
          params: computed(() => ctx.params()),
          loader: ({params}) => {
            resourceParams = params;
            return new Promise<string>((r) => loadResolvers.push(r));
          },
        }),
      });

      const {harness, router} = await setup([{path: ':id', component: TestCmp, resources}]);

      // Initial navigation
      const nav1 = router.navigateByUrl('/1');
      // Wait for loader to be called
      await timeout(10);
      expect(loadResolvers.length).toBe(1);
      loadResolvers.shift()!('1');
      await nav1;
      expect(resourceParams['id']).toBe('1');
      expect(harness.routeDebugElement?.componentInstance.route.snapshot.params['id']).toBe('1');

      // Second navigation (reused route)
      const nav2 = router.navigateByUrl('/2');
      harness.fixture.componentRef.changeDetectorRef.detectChanges();
      await timeout(10); // Wait for loader to start

      // Resource should see NEW params
      expect(loadResolvers.length).toBe(1);
      expect(resourceParams['id']).toBe('2');
      // Component should still see OLD params (snapshot hasn't updated yet)
      expect(harness.routeDebugElement?.componentInstance.route.snapshot.params['id']).toBe('1');

      loadResolvers.shift()!('2');
      await nav2;
      expect(harness.routeDebugElement?.componentInstance.route.snapshot.params['id']).toBe('2');
    });
  });

  describe('Mixed Resource Cleanup', () => {
    it('should destroy non-blocking resource when blocking resource fails (new route)', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      let nonBlockingDestroyed = false;
      const resources = () => ({
        blocking: routerResource.blocking({
          loader: () => Promise.reject<any>('fail'),
        }),
        nonBlocking: routerResource({
          loader: ({abortSignal}) => {
            abortSignal.addEventListener('abort', () => (nonBlockingDestroyed = true));
            return new Promise(() => {}); // Never resolves
          },
        }),
      });

      const {harness, router} = await setup([{path: 'test', component: TargetCmp, resources}]);

      await harness.navigateByUrl('/test').catch(() => {});
      expect(nonBlockingDestroyed).toBe(true);
    });

    it('should destroy non-blocking resource when blocking resource fails (reused route)', async () => {
      @Component({standalone: true, template: ''})
      class TestCmp {}

      let nonBlockingAborted = false;
      let shouldFail = false;

      const resources = (ctx: ResourceContext) => ({
        blocking: routerResource.blocking({
          params: ctx.params,
          loader: () => (shouldFail ? Promise.reject<any>('fail') : Promise.resolve('ok')),
        }),
        nonBlocking: routerResource({
          params: ctx.params,
          loader: ({abortSignal}) => {
            abortSignal.addEventListener('abort', () => (nonBlockingAborted = true));
            return new Promise(() => {}); // Never resolves
          },
        }),
      });

      const {harness} = await setup([{path: ':id', component: TestCmp, resources}]);

      // Initial success
      await harness.navigateByUrl('/1');
      expect(nonBlockingAborted).toBe(false);

      // Fail next
      shouldFail = true;
      nonBlockingAborted = false;
      await harness.navigateByUrl('/2').catch(() => {});

      // The non-blocking resource for the *second* navigation should have been aborted/destroyed
      // But wait, for a reused route, the resource itself isn't destroyed, but the *request* is aborted?
      // The `abortSignal` passed to the loader corresponds to the *request*.
      // So yes, it should be aborted.
      expect(nonBlockingAborted).toBe(true);
    });
  });

  describe('Resource Status Comprehensive Scenarios', () => {
    async function setup(routes: any[]) {
      TestBed.configureTestingModule({
        providers: [provideRouter(routes, withRouterConfig({paramsInheritanceStrategy: 'always'}))],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);
      return {harness, router};
    }

    it('should revert to "resolved" status after rollback from "resolved"', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      let resolveLoader!: (val: string) => void;
      const loaderPromise = new Promise<string>((r) => (resolveLoader = r));

      const resources = (ctx: ResourceContext) => ({
        data: routerResource.blocking({
          params: ctx.params,
          loader: ({params}) => {
            if (params['id'] === '1') return Promise.resolve('one');
            return loaderPromise;
          },
        }),
      });

      const {harness, router} = await setup([{path: ':id', component: TargetCmp, resources}]);

      // 1. Initial resolved state
      await harness.navigateByUrl('/1');
      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(resourceRef.status()).toBe('resolved');
      expect(resourceRef.value()).toBe('one');

      // 2. Start navigation to /2 (pending)
      const navPromise = harness.navigateByUrl('/2');
      await timeout(10);

      // Status should still be 'resolved' (frozen)
      expect(resourceRef.status()).toBe('resolved');

      // 3. Cancel navigation by navigating back to /1 (or elsewhere)
      // Actually, navigating to /1 might just reuse the route and not trigger a "rollback" in the same way as an abort.
      // Let's abort the current navigation explicitly if possible, or navigate to a 3rd route that fails?
      // Easiest is to just navigate to /1 again, which supersedes /2.
      await harness.navigateByUrl('/1');

      // The navigation to /2 was cancelled.
      // The resource should still be 'resolved' with value 'one'.
      expect(resourceRef.status()).toBe('resolved');
      expect(resourceRef.value()).toBe('one');
    });

    it('should revert to "error" status after rollback from "error"', async () => {
      @Component({standalone: true, template: 'hello'})
      class TargetCmp {}

      let resolveBlocker!: () => void;
      const blockerPromise = new Promise<void>((r) => (resolveBlocker = r));
      let resolveLoader!: (val: string) => void;
      const loaderPromise = new Promise<string>((r) => (resolveLoader = r));

      const resources = (ctx: ResourceContext) => ({
        data: routerResource({
          // Non-blocking so we can reach error state
          params: ctx.params,
          loader: ({params}) => {
            if (params['id'] === '1') return Promise.reject('error-one');
            return loaderPromise;
          },
        }),
        blocker: routerResource.blocking({
          params: ctx.params,
          loader: ({params}) => {
            if (params['id'] === '2') return blockerPromise;
            return Promise.resolve();
          },
        }),
      });

      const {harness, router} = await setup([{path: ':id', component: TargetCmp, resources}]);

      // 1. Initial error state
      await harness.navigateByUrl('/1');
      await timeout(); // Wait for rejection
      harness.detectChanges();
      await timeout(50); // Wait for effect

      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(resourceRef.status()).toBe('error');
      expect(resourceRef.error()).toBeInstanceOf(Error);
      expect(resourceRef.error().cause).toBe('error-one');

      // 2. Start navigation to /2 (pending)
      const navPromise = harness.navigateByUrl('/2');
      await timeout(10);

      // Status should still be 'error' (frozen)
      expect(resourceRef.status()).toBe('error');
      expect(resourceRef.error()).toBeInstanceOf(Error);
      expect(resourceRef.error().cause).toBe('error-one');

      // 3. Cancel navigation
      await harness.navigateByUrl('/1');

      // Should still be 'error'
      expect(resourceRef.status()).toBe('error');
      expect(resourceRef.error()).toBeInstanceOf(Error);
      expect(resourceRef.error().cause).toBe('error-one');
    });
  });
});

async function whenStable() {
  return TestBed.inject(ApplicationRef).whenStable();
}
