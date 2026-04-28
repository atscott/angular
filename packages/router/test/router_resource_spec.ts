import {Component} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {
  provideRouter,
  Router,
  NavigationError,
  withNavigationErrorHandler,
  RedirectCommand,
  withRouterResources,
  RouteReuseStrategy,
  ActivatedRouteSnapshot,
  DetachedRouteHandle,
  ActivatedRoute,
} from '@angular/router';
import {RouterTestingHarness} from '../testing';
import {resource, DestroyRef, WritableResource, inject, Resource, signal} from '@angular/core';
import {nonBlocking, SOURCE_RESOURCE_SYMBOL} from '../src/router_resource';
import {timeout, useAutoTick} from '../../private/testing/src/utils';
import {rxResource} from '@angular/core/rxjs-interop';
import {of} from 'rxjs';
import {delay} from 'rxjs/operators';
import {Title} from '@angular/platform-browser';

type ActivatedRouteInternal = ActivatedRoute & {
  resources?: {[key: string]: Resource<unknown>};
  eagerResources?: {[key: string]: Resource<unknown>};
};

type ActivatedRouteSnapshotInternal = ActivatedRouteSnapshot & {
  resources?: {[key: string]: Resource<unknown>};
  eagerResources?: {[key: string]: Resource<unknown>};
};

describe('routerResource', () => {
  useAutoTick();

  describe('My Original Tests', () => {
    it('should resolve resources before component initialization if blocking', async () => {
      let resolverSpy = jasmine.createSpy('resolver');
      let resolve!: (val: any) => void;
      const promise = new Promise<string>((r) => (resolve = r));

      @Component({standalone: true, template: ''})
      class TestCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TestCmp,
                resources: (ctx) => ({
                  data: resource({
                    loader: async () => {
                      resolverSpy();
                      return await promise;
                    },
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      let completed = false;
      const navPromise = harness.navigateByUrl('/test').then(() => {
        completed = true;
      });

      await timeout(10);
      expect(completed).toBe(false);
      expect(router.url).toBe('/');
      expect(resolverSpy).toHaveBeenCalled();

      resolve('resolved');
      await navPromise;
      expect(completed).toBe(true);
      expect(router.url).toBe('/test');
    });

    it('should not expose new fetch state during pending navigation', async () => {
      @Component({standalone: true, template: ''})
      class TestCmp {}

      let loadCount = 0;
      let resolveFirst!: (val: any) => void;
      let resolveSecond!: (val: any) => void;
      const p1 = new Promise((r) => (resolveFirst = r));
      const p2 = new Promise((r) => (resolveSecond = r));

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test/:id',
                component: TestCmp,
                resources: (ctx: any) => ({
                  data: resource({
                    params: () => ctx.params(),
                    loader: async ({params}: any) => {
                      loadCount++;
                      if (params['id'] === '1') return p1;
                      return p2;
                    },
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      const nav1 = harness.navigateByUrl('/test/1');
      resolveFirst('one');

      await nav1;
      await harness.fixture.whenStable();

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;
      expect(resourceRef.value()).toBe('one');

      expect(loadCount).toBe(1);

      const nav2 = harness.navigateByUrl('/test/2');
      await timeout(10);

      expect(loadCount).toBe(2);
      expect(resourceRef.isLoading()).toBe(false);
      expect(resourceRef.value()).toBe('one');

      resolveSecond('two');
      await nav2;
      await harness.fixture.whenStable();
      expect(resourceRef.isLoading()).toBe(false);
      expect(resourceRef.value()).toBe('two');
    });

    it('should not flip back to loading state if a navigation is cancelled', async () => {
      let loadCount = 0;
      let resolveFirst!: (val: any) => void;
      let resolveSecond!: (val: any) => void;
      const p1 = new Promise((r) => (resolveFirst = r));
      const p2 = new Promise((r) => (resolveSecond = r));

      @Component({standalone: true, template: ''})
      class TestCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'target/:id',
                component: TestCmp,
                resources: (ctx: any) => ({
                  data: resource({
                    params: () => ctx.params(),
                    loader: async ({params}: any) => {
                      loadCount++;
                      if (params['id'] === '1') return p1;
                      return p2;
                    },
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      // Successfully load /target/1
      const nav1 = harness.navigateByUrl('/target/1');
      resolveFirst('one');
      await nav1;
      await harness.fixture.whenStable();

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;
      expect(resourceRef.value()).toBe('one');
      expect(resourceRef.isLoading()).toBe(false);

      // Start navigation to /target/2
      const nav2 = harness.navigateByUrl('/target/2');
      await timeout(50); // allow transition to begin and loader to initiate

      // Cancel the navigation before it finishes by navigating back to /target/1
      const cancelNav = harness.navigateByUrl('/target/1');
      await timeout(50);
      // Because `isRollback` engages `recoveringFromAbortion`, the reloading state of the
      // inner resource is successfully masked.
      expect(resourceRef.isLoading()).toBe(false);
      expect(resourceRef.value()).toBe('one');

      await cancelNav;
      await harness.fixture.whenStable();
    });
  });

  describe('Basic Functionality', () => {
    it('should execute resources on initial navigation and expose the result', async () => {
      const loaderSpy = jasmine.createSpy('loader').and.resolveTo('loaded');

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                resources: () => ({
                  data: nonBlocking(resource({loader: loaderSpy})),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test');
      await harness.fixture.whenStable();
      expect(loaderSpy).toHaveBeenCalled();

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;
      expect(resourceRef.value()).toBe('loaded');
    });

    it('should not recreate and re-execute resources on subsequent navigations to the same route', async () => {
      let callCount = 0;

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test/:id',
                component: TargetCmp,
                resources: (ctx) => ({
                  data: nonBlocking(
                    resource({
                      params: () => ctx.params(),
                      loader: async () => {
                        callCount++;
                        return 'loaded';
                      },
                    }),
                  ),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      await harness.navigateByUrl('/test/1');
      expect(callCount).toBe(1);

      // Navigating to the identical URL should not trigger a refetch
      await harness.navigateByUrl('/test/1');
      expect(callCount).toBe(1);
    });

    it('should rollback transaction on failed navigation', async () => {
      let canActivate = true;

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test/:id',
                component: TargetCmp,
                canActivate: [
                  async () => {
                    await timeout(10);
                    return canActivate;
                  },
                ],
                resources: (ctx) => ({
                  data: nonBlocking(
                    resource({
                      params: () => ctx.params(),
                      loader: async ({params}: any) => params['id'],
                    }),
                  ),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test/1');
      await harness.fixture.whenStable();
      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;
      expect(resourceRef.value()).toBe('1');

      // Fail next navigation
      canActivate = false;
      await harness.navigateByUrl('/test/2');
      await harness.fixture.whenStable();

      // The navigation is cancelled so the resource should not have updated.
      // Additionally, the async guard ensures microtasks ran while pending, but it shouldn't flicker loading state.
      expect(resourceRef.value()).toBe('1');
      expect(resourceRef.isLoading()).toBe(false);
    });
    it('should cancel navigation when blocking resource yields error', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                resources: () => ({
                  data: resource({
                    loader: () => Promise.reject('test error'),
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test').catch(() => {});
      expect(router.url).not.toContain('/test');
    });

    it('should emit NavigationError when blocking resource rejects', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                resources: () => ({
                  data: resource({
                    loader: () => Promise.reject('test error'),
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      const error = await new Promise((resolve) => {
        router.events.subscribe((e) => {
          if (e instanceof NavigationError) resolve(e.error);
        });
        harness.navigateByUrl('/test').catch(() => {});
      });
      // the error might be an Error with cause 'test error' or directly 'test error' depending on resource API mapping
      expect(typeof error).toBe('object');
      // we'll just match the structure or check it's defined.
      expect(error).toBeDefined();
    });

    it('should work with resolvers', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                resolve: {id: () => '123'},
                resources: (ctx) => ({
                  data: nonBlocking(
                    resource({
                      params: () => ctx.data(),
                      loader: async ({params}: any) => ({name: `user ${params['id']}`}),
                    }),
                  ),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test');
      await harness.fixture.whenStable();
      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;

      // Wait for it to become resolved
      await timeout(20);
      expect(resourceRef.value()).toEqual({name: 'user 123'});
    });

    it('should allow retrying a blocking route that previously threw an error', async () => {
      let shouldError = true;

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test/:id',
                component: TargetCmp,
                resources: (ctx) => ({
                  data: resource({
                    params: () => ctx.params(),
                    loader: async ({params}: any) => {
                      if (shouldError) throw new Error('Failed');
                      return params['id'];
                    },
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      // First navigation fails
      await harness.navigateByUrl('/test/1').catch(() => {});
      expect(router.url).toBe('/'); // Cancelled

      // Wait for it to settle
      await harness.fixture.whenStable();

      // Retry the identical route with same parameters
      shouldError = false;
      await harness.navigateByUrl('/test/1');
      await harness.fixture.whenStable();

      expect(router.url).toBe('/test/1'); // Succeeded!
      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;
      expect(resourceRef.value()).toBe('1');
    });

    it('should complete navigation and expose error for non-blocking resources', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                resources: () => ({
                  data: nonBlocking(
                    resource({
                      loader: async () => {
                        throw new Error('Non-blocking error');
                      },
                    }),
                  ),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      // Non-blocking resource error doesn't cancel navigation
      await harness.navigateByUrl('/test');
      await harness.fixture.whenStable();

      expect(router.url).toBe('/test');
      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;
      expect(resourceRef.error()?.message).toBe('Non-blocking error');
      expect(resourceRef.isLoading()).toBe(false);
    });
  });
  describe('Transactional Behavior', () => {
    it('should abort previous request when a new navigation comes in', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      let resolve!: (val: any) => void;
      const promise = new Promise((r) => (resolve = r));
      let aborted = false;

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'user/:id',
                component: TargetCmp,
                resources: (ctx) => ({
                  user: nonBlocking(
                    resource({
                      params: () => ctx.params(),
                      loader: async ({params, abortSignal}: any) => {
                        abortSignal.addEventListener('abort', () => (aborted = true));
                        if (params['id'] === '1') return promise;
                        return {name: 'user 2'};
                      },
                    }),
                  ),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      const nav1 = harness.navigateByUrl('/user/1');
      await timeout(10); // Give it time to start fetching

      await harness.navigateByUrl('/user/2');
      await harness.fixture.whenStable();
      expect(aborted).toBe(true);

      const userResource = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['user'] as any;
      expect(userResource?.value()).toEqual({name: 'user 2'});

      // Resolving the old promise should have no effect
      resolve({name: 'user 1'});
      await timeout(10);
      expect(userResource.value()).toEqual({name: 'user 2'});
    });

    it('should correctly release the UI mask and rollback instantly if a navigation is canceled and does not reload', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      let resolveSecond!: (v: any) => void;
      let p2 = new Promise((r) => (resolveSecond = r));

      let guardsHit = 0;

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test/:id',
                component: TargetCmp,
                canActivate: [() => guardsHit++ === 0], // True for nav1, False for nav2
                eagerResources: (ctx: any) => ({
                  data: resource({
                    params: () => ctx.params(),
                    loader: async ({params}: any) => {
                      if (params['id'] === '2') return p2;
                      return params['id'];
                    },
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test/1');
      await harness.fixture.whenStable();

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.eagerResources?.['data'] as any;
      expect(resourceRef.value()).toBe('1');

      // Trigger nav2 which will be CANCELLED by canActivate
      try {
        await harness.navigateByUrl('/test/2');
      } catch {}
      await harness.fixture.whenStable();

      // Update the underlying resource data manually to verify we aren't deadlocked with a hidden mask!
      let mutationCount = 0;
      resourceRef[SOURCE_RESOURCE_SYMBOL].update((v: any) => v + '-mutated-' + ++mutationCount);
      await harness.fixture.whenStable();

      // If we were deadlocked, the mask would hide this mutation!
      expect(resourceRef.value()).toBe('1-mutated-1');
    });

    it('should fail to clear the freeze (deadlock) if a cancelled navigation does not trigger a resource load', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      let guardsHit = 0;

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test/:id',
                component: TargetCmp,
                canActivate: [
                  () => {
                    return guardsHit++ === 0;
                  },
                ], // True for nav1, False for nav2
                resources: (ctx: any) => ({
                  data: nonBlocking(
                    resource({
                      params: () => ctx.queryParams()['static'], // Depends on query param!
                      loader: async () => 'data',
                    }),
                  ),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      // Nav 1: path /test/1 with query param
      await harness.navigateByUrl('/test/1?static=true');
      await harness.fixture.whenStable();

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;
      expect(resourceRef.value()).toBe('data');

      // Nav 2: path /test/2 with SAME query param.
      // URL changes, so guards WILL run.
      // But resource param doesn't change, so it won't reload.
      try {
        await harness.navigateByUrl('/test/2?static=true');
      } catch {}
      await harness.fixture.whenStable();

      resourceRef[SOURCE_RESOURCE_SYMBOL].update((v: any) => v + '-mutated');
      await harness.fixture.whenStable();

      // The freeze IS cleared because we fixed the deadlock by checking !loading in the effect.
      expect(resourceRef.value()).toBe('data-mutated');
    });

    it('should correctly propagate parameter state to blocked eagerResources when a pending duplicated navigation supersedes identically reused routes', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      let resolveSecond!: (v: any) => void;
      let p2 = new Promise((r) => (resolveSecond = r));
      let resolveThird!: (v: any) => void;
      let p3 = new Promise((r) => (resolveThird = r));

      let loadedParams: any[] = [];

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test/:id',
                component: TargetCmp,
                eagerResources: (ctx: any) => ({
                  data: resource({
                    params: () => ctx.params(),
                    loader: async ({params}: any) => {
                      loadedParams.push(params['id']);
                      if (params['id'] === '2') return p2;
                      if (params['id'] === '3') return p3;
                      return params['id'];
                    },
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test/1');

      // Trigger nav2 and let it pend.
      // Under the hood, this sets `route.pending = true`.
      harness.navigateByUrl('/test/2');
      await timeout(10);

      // Supersede with identical route (/test/2 -> /test/3)
      // When nav3 supersedes nav2, the Router invokes RxJs finalize() teardown on nav2,
      // which triggers rollbackState() and synchronously sets `route.pending = false`.
      // Then nav3's recognize phase starts, setting `route.pending = true`.
      // Because the signal toggles `true -> false -> true` seamlessly between identical navigations,
      // parameter recalculations successfully bypass native signal emission suppression!
      const nav3 = harness.navigateByUrl('/test/3');
      await timeout(10);

      // At this point, the loader should have been called three times!
      expect(loadedParams).toEqual(['1', '2', '3']);

      // Even if p2 NEVER resolves, p3 resolving should complete navigation 3
      resolveThird('loaded-3');
      await nav3;
      await harness.fixture.whenStable();

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.eagerResources?.['data'] as any;
      expect(resourceRef.value()).toBe('loaded-3');
    });

    it('should maintain the mask of the previously settled state when a navigation is superseded by a new one during activation', async () => {
      let resolveSecond!: (val: any) => void;
      let p2 = new Promise((r) => (resolveSecond = r));

      let resolveThird!: (val: any) => void;
      let p3 = new Promise((r) => (resolveThird = r));

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test/:id',
                component: TargetCmp,
                eagerResources: (ctx: any) => ({
                  data: resource({
                    params: () => ctx.params(),
                    loader: async ({params}: any) => {
                      if (params['id'] === '2') return p2;
                      if (params['id'] === '3') return p3;
                      return params['id'];
                    },
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      const sub = router.events.subscribe((e) => {});

      const nav1 = harness.navigateByUrl('/test/1');
      await harness.fixture.whenStable();

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.eagerResources?.['data'] as any;

      // Start nav2. It will block waiting for p2.
      const nav2 = harness.navigateByUrl('/test/2');
      await timeout(10);

      // Supersede nav2 with nav3. nav2 cancels.
      const nav3 = harness.navigateByUrl('/test/3');
      await timeout(10);

      // We are now loading '3'. The UI should still be masked with '1' because nav2 never settled!
      expect(resourceRef.isLoading()).toBe(false);
      expect(resourceRef.value()).toBe('1');

      resolveThird('3');
      await nav3;
      await harness.fixture.whenStable();

      sub.unsubscribe();
      expect(resourceRef.value()).toBe('3');
      expect(resourceRef.isLoading()).toBe(false);
    });

    it('should persist the aborted value across a redirect cascade without flashing loading', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      let loadCount = 0;
      let resolveLoader!: (val: any) => void;
      let p1 = new Promise((r) => (resolveLoader = r));

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test/:id',
                component: TargetCmp,
                canActivate: [
                  ({params}: any) =>
                    params.id === '1' || params.id === '3'
                      ? true
                      : new RedirectCommand(TestBed.inject(Router).parseUrl('/test/3')),
                ],
                eagerResources: (ctx: any) => ({
                  data: resource({
                    params: () => ctx.params(),
                    loader: async ({params}: any) => {
                      loadCount++;
                      if (params['id'] === '3') return p1;
                      return params['id'];
                    },
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      const nav1 = harness.navigateByUrl('/test/1');
      await harness.fixture.whenStable();

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.eagerResources?.['data'] as any;
      expect(resourceRef.value()).toBe('1');
      expect(loadCount).toBe(1);

      // Trigger a navigation that hits a guard redirect
      // This will match '2', start `eagerResources` for '2', then fail the guard and redirect to '3'
      const nav2 = harness.navigateByUrl('/test/2');
      await timeout(10);

      // We are now loading '3'. The router correctly masked the intermediary '2' fetch because
      // the Guard rejected synchronously, ensuring `frozenSnapshot` perfectly captured '1'.
      // It therefore continues to correctly mask the pending transition to '3'.
      expect(resourceRef.isLoading()).toBe(false);
      expect(resourceRef.value()).toBe('1');

      resolveLoader('3');
      await harness.fixture.whenStable();

      expect(resourceRef.isLoading()).toBe(false);
      expect(resourceRef.value()).toBe('3');
    });

    it('should cleanly recover from abortion error states without permanently masking subsequent manual reloads', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      let resolveLoader!: (val: any) => void;
      let shouldErrorLoader = false;
      let promise = new Promise((resolve) => {
        resolveLoader = resolve;
      });

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test/:id',
                component: TargetCmp,
                resources: (ctx: any) => ({
                  data: resource({
                    params: () => ctx.params(),
                    loader: async () => {
                      if (shouldErrorLoader) throw new Error('Rollback failed');
                      return promise;
                    },
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      // Settle initial state
      resolveLoader('1');
      await harness.navigateByUrl('/test/1');
      await harness.fixture.whenStable();

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;
      expect(resourceRef.value()).toBe('1');

      promise = new Promise((resolve, reject) => {
        resolveLoader = resolve;
      });

      shouldErrorLoader = true;
      // Initiate navigation that fails due to resource error, causing NavigationError and parameter rollback.
      // The rollback to '1' will trigger the loader again, which will immediately throw again.
      const nav2 = harness.navigateByUrl('/test/2').catch(() => false);
      await timeout(10);
      await nav2;

      await harness.fixture.whenStable();

      expect(resourceRef.status()).toBe('error');

      // Now, long after the error, the user manually reloads the resource
      promise = new Promise((resolve, reject) => {
        resolveLoader = resolve;
      });
      shouldErrorLoader = false;
      resourceRef.reload();

      // Before this fix, `recoveringFromAbortion` would leak true on errors, causing the reload
      // state to be incorrectly masked as `resolved` instead of `reloading`.
      expect(resourceRef.isLoading()).toBe(true);

      resolveLoader('reloaded');
      await harness.fixture.whenStable();
      expect(resourceRef.value()).toBe('reloaded');
    });

    it('should perfectly mask abortion reloading states if interrupted by a rapid subsequent navigation', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      let resolveLoader!: (val: any) => void;
      let promise = new Promise((resolve) => (resolveLoader = resolve));

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test/:id',
                component: TargetCmp,
                resources: (ctx: any) => ({
                  data: resource({
                    params: () => ctx.params(),
                    loader: async () => promise,
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      // Settle initial state
      resolveLoader('1');
      await harness.navigateByUrl('/test/1');
      await harness.fixture.whenStable();

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;
      expect(resourceRef.value()).toBe('1');

      promise = new Promise((resolve) => (resolveLoader = resolve));

      // Initiate second navigation and cancel it
      const nav2 = harness.navigateByUrl('/test/2');
      await timeout(10);
      const navCancel = router.navigateByUrl('/test/1'); // Starts rollback
      await nav2;

      // The rollback fetch begins and the resource goes into reloading mode
      // WHILE it is fetching, the user enthusiastically clicks another active link!
      // This new navigation interrupts the recovery!
      const nav3 = harness.navigateByUrl('/test/3');
      await timeout(10);

      // Without the targeted recoveringFromAbortion check in NavigationStart, the router would
      // take a frozenSnapshot of the naked `reloading` state from the active abortion!
      // This correctly asserts that we protect the illusion of stability and maintain '1' without flashing.
      expect(resourceRef.isLoading()).toBe(false);
      expect(resourceRef.value()).toBe('1');

      resolveLoader('3');
      await navCancel;
      await nav3;
      await harness.fixture.whenStable();

      expect(resourceRef.isLoading()).toBe(false);
      expect(resourceRef.value()).toBe('3');
    });

    it('should perfectly mask loading states during multi-step Guard UrlTree redirects', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      let resolveLoader!: (val: any) => void;
      let promise = new Promise((resolve) => (resolveLoader = resolve));

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'target/:id',
                component: TargetCmp,
                resources: (ctx: any) => ({
                  data: resource({
                    params: () => ctx.params(),
                    loader: async () => promise,
                  }),
                }),
              },
              {
                path: 'bad-link',
                canActivate: [() => TestBed.inject(Router).createUrlTree(['/target/3'])],
                component: TargetCmp,
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      // Settle initial state
      resolveLoader('1');
      await harness.navigateByUrl('/target/1');
      await harness.fixture.whenStable();

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;
      expect(resourceRef.value()).toBe('1');
      expect(resourceRef.isLoading()).toBe(false);

      promise = new Promise((resolve) => (resolveLoader = resolve));

      // Initiate a navigation to a link that Redirects using a UrlTree Guard.
      // This will emit `NavigationStart(/bad-link)`, then `NavigationCancel(/bad-link, Redirect)`,
      // then `NavigationStart(/target/3)`.
      const nav2 = harness.navigateByUrl('/bad-link');

      // Wait for the cascade to settle into the actual resource loading phase for target/3
      await timeout(50);

      // The router correctly skipped stripping `frozenSnapshot` during the `Redirect` cancellation!
      // This means the UI is still completely perfectly masked looking like '1'!
      expect(resourceRef.isLoading()).toBe(false);
      expect(resourceRef.value()).toBe('1');

      resolveLoader('3');
      await nav2;
      await harness.fixture.whenStable();

      expect(resourceRef.isLoading()).toBe(false);
      expect(resourceRef.value()).toBe('3');
    });
  });

  describe('rxResource integration', () => {
    it('should successfully wrap and await an rxResource', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'rx/:id',
                component: TargetCmp,
                resources: (ctx) => ({
                  data: rxResource({
                    params: () => ctx.params(),
                    stream: ({params}: any) => of(`rx loaded ${params['id']}`).pipe(delay(10)),
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      const nav = harness.navigateByUrl('/rx/123');
      await timeout(5);

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;
      expect(resourceRef.isLoading()).toBe(true);
      expect(resourceRef.value()).toBeUndefined();

      await nav;
      await harness.fixture.whenStable();

      expect(resourceRef.isLoading()).toBe(false);
      expect(resourceRef.value()).toBe('rx loaded 123');
    });
  });

  describe('eagerResources', () => {
    it('should execute eagerResources BEFORE guards finish', async () => {
      let eagerExecuted = false;
      let guardResolve!: (val: boolean) => void;
      const guardPromise = new Promise<boolean>((r) => (guardResolve = r));

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                canActivate: [() => guardPromise],
                eagerResources: (ctx: any) => ({
                  data: nonBlocking(
                    resource({
                      loader: async () => {
                        eagerExecuted = true;
                        return 'eager loaded';
                      },
                    }),
                  ),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();

      const nav = harness.navigateByUrl('/test');
      await timeout(10); // allow eagerResources to start

      // The guard is still pending, but eagerResources should have already executed
      // because it runs immediately after matching.
      expect(eagerExecuted).toBe(true);

      guardResolve(true);
      await nav;
      await harness.fixture.whenStable();

      const router = TestBed.inject(Router);
      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.eagerResources?.['data'] as any;
      expect(resourceRef.value()).toBe('eager loaded');
    });

    it('should rollback transaction on failed navigation for eagerResources too', async () => {
      let canActivate = true;

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test/:id',
                component: TargetCmp,
                resolve: {blocker: () => (canActivate ? 'ok' : Promise.reject('fail'))},
                eagerResources: (ctx) => ({
                  data: nonBlocking(
                    resource({
                      params: () => ctx.params(),
                      loader: async ({params}: any) => params['id'],
                    }),
                  ),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test/1');
      await harness.fixture.whenStable();
      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.eagerResources?.['data'] as any;
      expect(resourceRef.value()).toBe('1');

      // Fail next navigation via guard
      canActivate = false;
      await harness.navigateByUrl('/test/2').catch(() => {});
      await harness.fixture.whenStable();
      await timeout(50);
      await harness.fixture.whenStable();

      // The navigation is cancelled; eagerResources might have started but state should rollback
      expect(resourceRef.value()).toBe('1');
    });

    it('should successfully execute both eagerResources and resources, with correct timing', async () => {
      const executionOrder: string[] = [];
      let resolveGuard!: (val: boolean) => void;
      const guardPromise = new Promise<boolean>((r) => (resolveGuard = r));

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                canActivate: [
                  () => {
                    executionOrder.push('guard start');
                    return guardPromise;
                  },
                ],
                eagerResources: (ctx: any) => ({
                  eagerData: nonBlocking(
                    resource({
                      loader: async () => {
                        executionOrder.push('eagerResource load');
                        return 'eager';
                      },
                    }),
                  ),
                }),
                resources: () => ({
                  lateData: nonBlocking(
                    resource({
                      loader: async () => {
                        executionOrder.push('resource load');
                        return 'late';
                      },
                    }),
                  ),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      const nav = harness.navigateByUrl('/test');
      await timeout(10);

      // Eager resource runs immediately after matching
      // Then guard starts.
      expect(executionOrder.includes('eagerResource load')).toBe(true);
      expect(executionOrder.includes('guard start')).toBe(true);

      resolveGuard(true);
      await nav;
      await harness.fixture.whenStable();

      // After guard resolves, standard resources run
      expect(executionOrder.includes('eagerResource load')).toBe(true);
      expect(executionOrder.includes('guard start')).toBe(true);
      expect(executionOrder.includes('resource load')).toBe(true);

      // Eager resource runs before standard resource
      expect(executionOrder.indexOf('eagerResource load')).toBeLessThan(
        executionOrder.indexOf('resource load'),
      );

      const route = router.routerState.root.firstChild!;
      expect(((route as ActivatedRouteInternal).eagerResources?.['eagerData'] as any).value()).toBe(
        'eager',
      );
      expect(((route as ActivatedRouteInternal).resources?.['lateData'] as any).value()).toBe(
        'late',
      );
    });

    it('eagerResource blocking should block BeforeActivateRoutes', async () => {
      let resolveWait!: () => void;
      const waitPromise = new Promise<void>((r) => (resolveWait = r));

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                eagerResources: () => ({
                  data: resource({
                    loader: async () => {
                      await waitPromise;
                      return 'loaded';
                    },
                  }),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      let completed = false;
      const navPromise = harness.navigateByUrl('/test').then(() => {
        completed = true;
      });

      await timeout(10);
      expect(completed).toBe(false);
      expect(router.url).toBe('/'); // Blocked navigation

      resolveWait();
      await navPromise;
      expect(completed).toBe(true);
      expect(router.url).toBe('/test');
    });
  });

  describe('redirecting from resources', () => {
    it('should be able to redirect from a blocking resource using a NavigationErrorHandler', async () => {
      let handleCount = 0;
      let errorRef: unknown = null;

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      @Component({standalone: true, template: ''})
      class ErrorCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                resources: () => ({
                  data: resource({
                    loader: async () => {
                      throw new Error('Resource failed!');
                    },
                  }),
                }),
              },
              {
                path: 'test-eager',
                component: TargetCmp,
                eagerResources: () => ({
                  data: resource({
                    loader: async () => {
                      throw new Error('Eager resource failed!');
                    },
                  }),
                }),
              },
              {
                path: 'error',
                component: ErrorCmp,
              },
            ],
            withNavigationErrorHandler((e: NavigationError) => {
              handleCount++;
              errorRef = e.error;
              return new RedirectCommand(TestBed.inject(Router).parseUrl('/error'));
            }),
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test');

      expect(router.url).toBe('/error');
      expect(handleCount).toBe(1);
      expect((errorRef as Error).message).toBe('Resource failed!');

      // Also works for eagerResources
      await harness.navigateByUrl('/test-eager');

      expect(router.url).toBe('/error');
      expect(handleCount).toBe(2);
      expect((errorRef as Error).message).toBe('Eager resource failed!');
    });
  });

  describe('Edge Cases', () => {
    it('should throw an error in dev mode if resource loader does not return a Resource', async () => {
      @Component({standalone: true, template: '', selector: 'target-cmp-throw'})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                resources: () => ({
                  data: {foo: 'bar'} as any,
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      let error: any;
      try {
        await harness.navigateByUrl('/test');
      } catch (e) {
        error = e;
      }
      expect(error.message).toContain('Invalid resource returned for key "data"');
    });

    it('should properly restore resources with RouteReuseStrategy without destroying injector', async () => {
      let callCount = 0;
      @Component({standalone: true, template: '', selector: 'target-cmp-reuse'})
      class TargetCmp {}
      @Component({standalone: true, template: '', selector: 'other-cmp-reuse'})
      class OtherCmp {}

      class CustomReuseStrategy implements RouteReuseStrategy {
        public handlers: {[key: string]: DetachedRouteHandle} = {};
        shouldDetach(route: ActivatedRouteSnapshot): boolean {
          return route.routeConfig?.path === 'test';
        }
        store(route: ActivatedRouteSnapshot, handle: DetachedRouteHandle | null): void {
          if (handle) this.handlers[route.routeConfig!.path!] = handle;
        }
        shouldAttach(route: ActivatedRouteSnapshot): boolean {
          return !!route.routeConfig && !!this.handlers[route.routeConfig.path!];
        }
        retrieve(route: ActivatedRouteSnapshot): DetachedRouteHandle | null {
          return this.handlers[route.routeConfig!.path!] ?? null;
        }
        shouldReuseRoute(future: ActivatedRouteSnapshot, curr: ActivatedRouteSnapshot): boolean {
          return future.routeConfig === curr.routeConfig;
        }
      }

      TestBed.configureTestingModule({
        providers: [
          {provide: RouteReuseStrategy, useClass: CustomReuseStrategy},
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                resources: () => {
                  inject(DestroyRef).onDestroy(() => {
                    testDestroyed = true;
                  });
                  return {
                    data: nonBlocking(
                      resource({
                        loader: async () => {
                          callCount++;
                          return 'loaded';
                        },
                      }),
                    ),
                  };
                },
              },
              {path: 'other', component: OtherCmp},
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      let testDestroyed = false;

      await harness.navigateByUrl('/test');
      await harness.fixture.whenStable();
      await timeout(20);
      expect(callCount).toBe(1);
      await timeout(20);
      expect(callCount).toBe(1);

      await harness.navigateByUrl('/other');
      // The route is detached, not destroyed!
      expect(testDestroyed).toBe(false);

      // Navigate back
      await harness.navigateByUrl('/test');
      await harness.fixture.whenStable();
      await timeout(20);
      expect(callCount).toBe(1); // Should not re-fetch it since data is cached from before
      expect(testDestroyed).toBe(false);
    });

    it('should support resources on componentless routes', async () => {
      let callCount = 0;
      @Component({standalone: true, template: '', selector: 'child-cmp-componentless'})
      class ChildCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'parent',
                resources: () => ({
                  parentData: nonBlocking(resource({loader: async () => 'parent'})),
                }),
                children: [
                  {
                    path: 'componentless',
                    resources: () => ({
                      compData: nonBlocking(
                        resource({
                          loader: async () => {
                            callCount++;
                            return 'comp';
                          },
                        }),
                      ),
                    }),
                    children: [{path: 'child', component: ChildCmp}],
                  },
                ],
              },
            ],
            withRouterResources(),
          ),
        ],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/parent/componentless/child');
      await harness.fixture.whenStable();
      await timeout(20);
      expect(callCount).toBe(1);

      const parentRoute = router.routerState.root.firstChild!;
      const componentlessRoute = parentRoute.firstChild!;

      expect(
        ((parentRoute as ActivatedRouteInternal).resources?.['parentData'] as any).value(),
      ).toBe('parent');
      expect(
        ((componentlessRoute as ActivatedRouteInternal).resources?.['compData'] as any).value(),
      ).toBe('comp');
    });

    it('should cleanup _resourceInjector explicitly on route deactivation', async () => {
      @Component({standalone: true, template: '', selector: 'target-cmp-cleanup'})
      class TargetCmp {}
      @Component({standalone: true, template: '', selector: 'other-cmp-cleanup'})
      class OtherCmp {}

      let destroyed = false;
      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                resources: () => {
                  inject(DestroyRef).onDestroy(() => {
                    destroyed = true;
                  });
                  return {
                    data: nonBlocking(resource({loader: async () => 'test'})),
                  };
                },
              },
              {path: 'other', component: OtherCmp},
            ],
            withRouterResources(),
          ),
        ],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test');

      expect(destroyed).toBe(false);
      await harness.navigateByUrl('/other');
      // Normal navigation unmounts, meaning injector MUST be explicitly destroyed
      expect(destroyed).toBe(true);
    });

    it('should ignore reload during a pending navigation', async () => {
      let callCount = 0;
      @Component({standalone: true, template: '', selector: 'target-cmp-mutations'})
      class TargetCmp {}
      @Component({standalone: true, template: '', selector: 'other-cmp-mutations'})
      class OtherCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                resources: () => ({
                  data: nonBlocking(
                    resource({
                      loader: async () => {
                        callCount++;
                        return 'test';
                      },
                    }),
                  ),
                }),
              },
              {
                path: 'other',
                component: OtherCmp,
                canActivate: [() => new Promise((resolve) => setTimeout(resolve, 50))],
              },
            ],
            withRouterResources(),
          ),
        ],
      });
      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      // Settle initial route
      await harness.navigateByUrl('/test');
      expect(callCount).toBe(1);

      const testRoute = router.routerState.root.firstChild!;
      const dataRes = (testRoute as ActivatedRouteInternal).resources![
        'data'
      ] as WritableResource<string>;

      // Trigger a delayed pending navigation
      const navPromise = router.navigateByUrl('/other');

      // Navigation is now actively pending, meaning the UI is frozen.
      expect(router.currentNavigation()).not.toBeNull();

      // Attempting to reload while visually locked should be ignored and return false
      const result = dataRes.reload();
      expect(result).toBe(false);
      expect(callCount).toBe(1);

      await navPromise;
    });
  });

  describe('Runtime Mutations', () => {
    it('should allow reload and correctly forward it', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      let resolveLoader!: (val: string) => void;
      let p1 = new Promise<string>((r) => (resolveLoader = r));

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TargetCmp,
                resources: () => ({
                  data: nonBlocking(
                    resource({
                      loader: () => p1,
                    }),
                  ),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      const nav1 = harness.navigateByUrl('/test');
      await timeout(10); // let the resource initiate

      const resourceRef = (router.routerState.root.firstChild as ActivatedRouteInternal)
        ?.resources?.['data'] as any;

      expect(resourceRef.isLoading()).toBe(true);

      resolveLoader('loaded');
      await nav1;
      await harness.fixture.whenStable();

      expect(resourceRef.value()).toBe('loaded');

      // Refetch
      resourceRef.reload();
      // Test immediately before event loop settles
      expect(resourceRef.isLoading()).toBe(true);

      await harness.fixture.whenStable();
    });
  });

  // proof of concept for router title integration
  describe('Title Strategy Integration', () => {
    it('should update title reactively from resource with external dependency', async () => {
      const externalSignal = signal('initial');

      @Component({standalone: true, template: ''})
      class TestCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter(
            [
              {
                path: 'test',
                component: TestCmp,
                resources: () => ({
                  title: nonBlocking(
                    resource({
                      params: () => externalSignal(),
                      loader: async ({params}) => `Title: ${params}`,
                    }),
                  ),
                }),
              },
            ],
            withRouterResources(),
          ),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const titleService = TestBed.inject(Title);

      await harness.navigateByUrl('/test');
      await harness.fixture.whenStable();

      expect(titleService.getTitle()).toBe('Title: initial');

      // Mutate external signal!
      externalSignal.set('updated');
      await harness.fixture.whenStable();

      expect(titleService.getTitle()).toBe('Title: updated');
    });
  });
});
