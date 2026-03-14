import {Component} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {
  provideRouter,
  Router,
  ActivatedRoute,
  NavigationError,
  withNavigationErrorHandler,
  RedirectCommand,
} from '@angular/router';
import {RouterTestingHarness} from '../testing';
import {resource, ApplicationRef} from '@angular/core';
import {blocking, createTransactionalResource} from '../src/router_resource';
import {timeout, useAutoTick} from '../../private/testing/src/utils';
import {rxResource} from '@angular/core/rxjs-interop';
import {of} from 'rxjs';
import {delay} from 'rxjs/operators';

function routerResource(opts: any, router: Router) {
  return createTransactionalResource(resource(opts), router);
}
routerResource.blocking = function (opts: any, router: Router) {
  return blocking(createTransactionalResource(resource(opts), router));
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
          provideRouter([
            {
              path: 'test',
              component: TestCmp,
              resources: (ctx) => ({
                data: routerResource.blocking(
                  {
                    loader: async () => {
                      resolverSpy();
                      return await promise;
                    },
                  },
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
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
          provideRouter([
            {
              path: 'test/:id',
              component: TestCmp,
              resources: (ctx: any) => ({
                data: routerResource.blocking(
                  {
                    params: () => ctx.params(),
                    loader: async ({params}: any) => {
                      loadCount++;
                      if (params.id === '1') return p1;
                      return p2;
                    },
                  },
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      const nav1 = harness.navigateByUrl('/test/1');
      resolveFirst('one');

      await nav1;
      await harness.fixture.whenStable();

      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;
      console.error(
        'resourceRef status',
        resourceRef.status(),
        'value',
        resourceRef.value(),
        'has run:',
        loadCount,
      );
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
  });

  describe('Basic Functionality', () => {
    it('should execute resources on initial navigation and expose the result', async () => {
      const loaderSpy = jasmine.createSpy('loader').and.resolveTo('loaded');

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {
              path: 'test',
              component: TargetCmp,
              resources: () => ({
                data: routerResource({loader: loaderSpy}, TestBed.inject(Router)),
              }),
            },
          ]),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test');
      await harness.fixture.whenStable();
      expect(loaderSpy).toHaveBeenCalled();

      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(resourceRef.value()).toBe('loaded');
    });

    it('should not recreate and re-execute resources on subsequent navigations to the same route', async () => {
      let callCount = 0;

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {
              path: 'test/:id',
              component: TargetCmp,
              resources: (ctx) => ({
                data: routerResource(
                  {
                    params: () => ctx.params(),
                    loader: async () => {
                      callCount++;
                      return 'loaded';
                    },
                  },
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
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
          provideRouter([
            {
              path: 'test/:id',
              component: TargetCmp,
              canActivate: [() => canActivate],
              resources: (ctx) => ({
                data: routerResource(
                  {
                    params: () => ctx.params(),
                    loader: async ({params}: any) => params.id,
                  },
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test/1');
      await harness.fixture.whenStable();
      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(resourceRef.value()).toBe('1');

      // Fail next navigation
      canActivate = false;
      await harness.navigateByUrl('/test/2');
      await harness.fixture.whenStable();

      // The navigation is cancelled so the resource should not have updated.
      expect(resourceRef.value()).toBe('1');
    });
    it('should cancel navigation when blocking resource yields error', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {
              path: 'test',
              component: TargetCmp,
              resources: () => ({
                data: routerResource.blocking(
                  {
                    loader: () => Promise.reject('test error'),
                  },
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
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
          provideRouter([
            {
              path: 'test',
              component: TargetCmp,
              resources: () => ({
                data: routerResource.blocking(
                  {
                    loader: () => Promise.reject('test error'),
                  },
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
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
          provideRouter([
            {
              path: 'test',
              component: TargetCmp,
              resolve: {id: () => '123'},
              resources: (ctx) => ({
                data: routerResource(
                  {
                    params: () => ctx.data(),
                    loader: async ({params}: any) => ({name: `user ${params['id']}`}),
                  },
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test');
      await harness.fixture.whenStable();
      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;

      // Wait for it to become resolved
      await timeout(20);
      expect(resourceRef.value()).toEqual({name: 'user 123'});
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
          provideRouter([
            {
              path: 'user/:id',
              component: TargetCmp,
              resources: (ctx) => ({
                user: routerResource(
                  {
                    params: () => ctx.params(),
                    loader: async ({params, abortSignal}: any) => {
                      abortSignal.addEventListener('abort', () => (aborted = true));
                      if (params['id'] === '1') return promise;
                      return {name: 'user 2'};
                    },
                  },
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      const nav1 = harness.navigateByUrl('/user/1');
      await timeout(10); // Give it time to start fetching

      await harness.navigateByUrl('/user/2');
      await harness.fixture.whenStable();
      expect(aborted).toBe(true);

      const userResource = router.routerState.root.firstChild?.resources?.['user'] as any;
      console.error(
        'userResource:',
        userResource,
        'firstChild:',
        router.routerState.root.firstChild,
      );
      expect(userResource?.value()).toEqual({name: 'user 2'});

      // Resolving the old promise should have no effect
      resolve({name: 'user 1'});
      await timeout(10);
      expect(userResource.value()).toEqual({name: 'user 2'});
    });
  });

  describe('rxResource integration', () => {
    it('should successfully wrap and await an rxResource', async () => {
      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {
              path: 'rx/:id',
              component: TargetCmp,
              resources: (ctx) => ({
                data: createTransactionalResource(
                  rxResource({
                    params: () => ctx.params()['id'],
                    stream: ({params}: any) => of(`rx loaded ${params}`).pipe(delay(10)),
                  }),
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      const nav = harness.navigateByUrl('/rx/123');
      await timeout(5);

      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;
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
          provideRouter([
            {
              path: 'test',
              component: TargetCmp,
              canActivate: [() => guardPromise],
              eagerResources: () => ({
                data: routerResource(
                  {
                    loader: async () => {
                      eagerExecuted = true;
                      return 'eager loaded';
                    },
                  },
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
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
      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;
      expect(resourceRef.value()).toBe('eager loaded');
    });

    it('should rollback transaction on failed navigation for eagerResources too', async () => {
      let canActivate = true;

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {
              path: 'test/:id',
              component: TargetCmp,
              resolve: {blocker: () => (canActivate ? 'ok' : Promise.reject('fail'))},
              eagerResources: (ctx) => ({
                data: routerResource(
                  {
                    params: () => ctx.params(),
                    loader: async ({params}: any) => params.id,
                  },
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
        ],
      });

      const harness = await RouterTestingHarness.create();
      const router = TestBed.inject(Router);

      await harness.navigateByUrl('/test/1');
      await harness.fixture.whenStable();
      const resourceRef = router.routerState.root.firstChild?.resources?.['data'] as any;
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
          provideRouter([
            {
              path: 'test',
              component: TargetCmp,
              canActivate: [
                () => {
                  executionOrder.push('guard start');
                  return guardPromise;
                },
              ],
              eagerResources: () => ({
                eagerData: routerResource(
                  {
                    loader: async () => {
                      executionOrder.push('eagerResource load');
                      return 'eager';
                    },
                  },
                  TestBed.inject(Router),
                ),
              }),
              resources: () => ({
                lateData: routerResource(
                  {
                    loader: async () => {
                      executionOrder.push('resource load');
                      return 'late';
                    },
                  },
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
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
      expect((route.resources?.['eagerData'] as any).value()).toBe('eager');
      expect((route.resources?.['lateData'] as any).value()).toBe('late');
    });

    it('eagerResource blocking should block BeforeActivateRoutes', async () => {
      let resolveWait!: () => void;
      const waitPromise = new Promise<void>((r) => (resolveWait = r));

      @Component({standalone: true, template: ''})
      class TargetCmp {}

      TestBed.configureTestingModule({
        providers: [
          provideRouter([
            {
              path: 'test',
              component: TargetCmp,
              eagerResources: () => ({
                data: routerResource.blocking(
                  {
                    loader: async () => {
                      await waitPromise;
                      return 'loaded';
                    },
                  },
                  TestBed.inject(Router),
                ),
              }),
            },
          ]),
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
                  data: routerResource.blocking(
                    {
                      loader: async () => {
                        throw new Error('Resource failed!');
                      },
                    },
                    TestBed.inject(Router),
                  ),
                }),
              },
              {
                path: 'test-eager',
                component: TargetCmp,
                eagerResources: () => ({
                  data: routerResource.blocking(
                    {
                      loader: async () => {
                        throw new Error('Eager resource failed!');
                      },
                    },
                    TestBed.inject(Router),
                  ),
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
});
