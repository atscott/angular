import {Component, inject} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {RouterOutlet, Routes, ActivatedRoute as UntypedActivatedRoute} from '@angular/router';
import {RouterTestingHarness} from '@angular/router/testing';
import {
  AllPaths,
  createRoute,
  createRootRoute,
  injectNavigate,
  injectRoute,
  injectRouter,
  provideRouter,
  Router,
  AnyRoute,
  RouteParams,
} from '../src/typed_router';

describe('TypedRouter', () => {
  @Component({
    standalone: true,
    template: `
    userId: {{ route.params().userId }}
    <router-outlet />`,
    imports: [RouterOutlet],
  })
  class UserComponent {
    route = injectTypedRoute('/user/:userId');
    constructor() {
      this.route.params().userId;
      // @ts-expect-error
      this.route.params().nonExistent;
    }
  }

  @Component({
    standalone: true,
    template: `userId: {{ route.params().userId }}, postId: {{ route.params().postId }}`,
  })
  class PostsComponent {
    route = injectTypedRoute('/user/:userId/posts/:postId');
    constructor() {
      this.route.params().userId;
      this.route.params().postId;
      // @ts-expect-error
      this.route.params().nonExistent;
    }
  }

  @Component({
    standalone: true,
    template: `user: {{ route.data().user.name }}, post: {{ route.data().post.title }}`,
  })
  class PostsWithDataComponent {
    route = injectTypedRoute(postsRouteWithResolver.fullPath);
    constructor() {
      this.route.params().userId;
      this.route.params().postId;
      // @ts-expect-error
      this.route.params().nonExistent;
    }
  }

  @Component({
    standalone: true,
    template: `user: {{ route.data().user.name }}`,
  })
  class SetResolversComponent {
    route = injectTypedRoute('/set-resolvers/:userId');
  }

  @Component({
    standalone: true,
    template: `
    userId: {{ route.params().userId }}
    user name: {{ route.data().user.name }}
    <router-outlet />
      `,
    imports: [RouterOutlet],
  })
  class UserWithDataComponent {
    route = injectTypedRoute('/user-with-resolver/:userId');
  }

  const rootRoute = createRootRoute();
  const postsRoute = createRoute({
    path: 'posts/:postId',
    getParentRoute: () => userRoute,
    component: PostsComponent,
  });
  const userRoute = createRoute({
    path: 'user/:userId',
    getParentRoute: () => rootRoute,
    component: UserComponent,
  });
  userRoute.children = [postsRoute];

  const userRouteWithResolver = createRoute({
    path: 'user-with-resolver/:userId',
    getParentRoute: () => rootRoute,
    component: UserWithDataComponent,
    resolve: {
      user: (route) => ({id: route.params.userId, name: 'Angular'}),
    },
  });
  // Type test for userRouteWithResolver
  {
    type T = RouteParams<typeof userRouteWithResolver>;
    const p: T = {userId: 'a'};
    const k: keyof T = 'userId';
    // @ts-expect-error
    const p2: T = {};
    // @ts-expect-error
    const k2: keyof T = 'wrong';
  }
  const postsRouteWithResolver = createRoute({
    path: 'posts/:postId',
    getParentRoute: () => userRouteWithResolver,
    component: PostsWithDataComponent,
    resolve: {
      post: (route) => {
        const user = route.data.user;
        const postId: string = route.params.postId;
        const userId: string = route.params.userId;
        // @ts-expect-error
        const nonExistent: string = route.params.nonExistent;
        return {id: postId, title: `Post by ${user.name}`};
      },
    },
  });
  // Type test for postsRouteWithResolver
  {
    type T = RouteParams<typeof postsRouteWithResolver>;
    const p: T = {userId: 'a', postId: 'b'};
    const k: keyof T = 'userId';
    const k2: keyof T = 'postId';
    // @ts-expect-error
    const p2: T = {userId: 'a'};
    // @ts-expect-error
    const k3: keyof T = 'wrong';
  }
  userRouteWithResolver.children = [postsRouteWithResolver];

  const setResolversRoute = createRoute({
    path: 'set-resolvers/:userId',
    getParentRoute: () => rootRoute,
    component: SetResolversComponent,
  }).setResolvers({
    user: (route) => {
      const id: string = route.params.userId;
      // @ts-expect-error
      const nonExistent: string = route.params.nonExistent;
      return {id, name: 'Set Angular'};
    },
  });

  const appRoutes: Routes = [userRoute, userRouteWithResolver, setResolversRoute];

  const routeMap = {
    '/user/:userId': userRoute,
    '/user/:userId/posts/:postId': postsRoute,
    '/user-with-resolver/:userId': userRouteWithResolver,
    '/user-with-resolver/:userId/posts/:postId': postsRouteWithResolver,
    '/set-resolvers/:userId': setResolversRoute,
  } as const;

  type RouteMap = typeof routeMap;

  /**
   * Test-specific helper to call `injectRoute` with the local `RouteMap`.
   * This avoids global declaration merging and TypeScript's partial inference issues
   * (we would want to provide just the RouteMap generic to injectRoute, but that
   * causes TypeScript to try to infer the TPath from the entire global map).
   */
  function injectTypedRoute<TPath extends AllPaths<RouteMap>>(path: TPath) {
    return injectRoute<RouteMap, TPath>(path);
  }

  /**
   * Test-specific helper to call `injectNavigate` with the local `RouteMap`.
   * This avoids global declaration merging and TypeScript's partial inference issues.
   */
  function injectTypedNavigate<TFrom extends AllPaths<RouteMap>>(options: {from: TFrom}) {
    return injectNavigate<RouteMap, TFrom>(options);
  }

  describe('type inference', () => {
    it('should infer params from path', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter(appRoutes)],
      });
      const harness = await RouterTestingHarness.create('/user/123');
      harness.fixture.detectChanges();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123');
    });

    it('should infer parent params for children', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter(appRoutes)],
      });
      const harness = await RouterTestingHarness.create('/user/123/posts/456');
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123, postId: 456');
    });

    it('should infer parent data in child resolver', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter(appRoutes)],
      });
      const harness = await RouterTestingHarness.create('/user-with-resolver/123/posts/456');
      harness.fixture.detectChanges();
      expect(harness.fixture.nativeElement.innerHTML).toContain(
        'user: Angular, post: Post by Angular',
      );
    });

    it('should support setting resolvers with setResolvers', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter(appRoutes)],
      });
      const harness = await RouterTestingHarness.create('/set-resolvers/123');
      harness.fixture.detectChanges();
      expect(harness.fixture.nativeElement.innerHTML).toContain('user: Set Angular');
    });

    it('should allow mixing typed and untyped routes', () => {
      // This test is for compile-time type checking.
      @Component({standalone: true, template: ''})
      class UntypedComponent {}

      const typedRoute = createRoute({path: 'typed', component: UntypedComponent});
      const mixedRoutes: Routes = [
        typedRoute,
        {
          path: 'untyped',
          component: UntypedComponent,
        },
      ];
      const mixedMap = {'/typed': typedRoute};

      // @ts-expect-error: '/untyped' should not be in the type map
      const x: AllPaths<typeof mixedMap> = '/untyped';
      void x;

      // The typed path should be present
      const y: AllPaths<typeof mixedMap> = '/typed';
      void y;

      expect().nothing();
    });
  });

  describe('AnyRoute fallback', () => {
    it('should allow any path and params when no route tree is registered', async () => {
      @Component({standalone: true, template: ''})
      class BlankCmp {}
      const routes: Routes = [
        {
          path: '',
          component: BlankCmp,
        },
        {
          path: '**',
          component: BlankCmp,
        },
      ];

      TestBed.configureTestingModule({
        providers: [provideRouter(routes)],
      });
      const router: Router<Record<string, AnyRoute>> = TestBed.inject(Router);
      await router.navigate('/some/unregistered/path', {id: 123, other: 'abc'});

      const route = TestBed.runInInjectionContext(() => injectRoute('/some/unregistered/path'));
      route.data().anything;
      route.params().anything;

      expect().nothing();
    });
  });

  describe('TypedRouter navigation', () => {
    it('should navigate to a simple route', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter(appRoutes)],
      });
      const harness = await RouterTestingHarness.create('/');
      const typedRouter = TestBed.runInInjectionContext(() => injectRouter<RouteMap>());
      await typedRouter.navigate('/user/:userId', {userId: '123'});
      harness.fixture.detectChanges();
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123');
    });

    it('should navigate to a child route', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter(appRoutes)],
      });
      const harness = await RouterTestingHarness.create('/');
      const typedRouter = TestBed.runInInjectionContext(() => injectRouter<RouteMap>());

      await typedRouter.navigate('/user/:userId/posts/:postId', {
        userId: '123',
        postId: '456',
      });
      await harness.fixture.whenStable();

      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123, postId: 456');
    });

    it('should provide a typed route with injectTypedRoute', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter(appRoutes)],
      });
      const harness = await RouterTestingHarness.create('/user-with-resolver/snapshot-test');
      harness.fixture.detectChanges();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: snapshot-test');
      expect(harness.fixture.nativeElement.innerHTML).toContain('user name: Angular');
    });
  });

  describe('relative navigation', () => {
    it('should navigate to a child route', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter(appRoutes)],
      });
      const harness = await RouterTestingHarness.create('/');
      const typedRouter = TestBed.runInInjectionContext(() => injectRouter<RouteMap>());
      await typedRouter.navigate({
        from: userRoute.fullPath,
        to: 'posts/:postId',
        params: {
          userId: '123',
          postId: '456',
        },
      });
      harness.fixture.detectChanges();
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123, postId: 456');
    });

    it('should navigate to a sibling route with ../', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter(appRoutes)],
      });
      const harness = await RouterTestingHarness.create('/user/123');
      const typedRouter = TestBed.runInInjectionContext(() => injectRouter<RouteMap>());
      await typedRouter.navigate({
        from: '/user/:userId',
        to: '../user-with-resolver/:userId',
        params: {
          userId: '789',
        },
      });
      harness.fixture.detectChanges();
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('user name: Angular');
    });

    it('should navigate with a params function', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter(appRoutes)],
      });
      const harness = await RouterTestingHarness.create('/user/123');
      const typedRouter = TestBed.runInInjectionContext(() => injectRouter<RouteMap>());
      await typedRouter.navigate({
        from: '/user/:userId',
        to: '.',
        params: (prev) => ({
          ...prev,
          userId: `${prev.userId}-updated`,
        }),
      });
      harness.fixture.detectChanges();
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123-updated');
    });

    it('should navigate with injectNavigate', async () => {
      TestBed.configureTestingModule({providers: [provideRouter(appRoutes)]});
      const navigate = TestBed.runInInjectionContext(() =>
        injectTypedNavigate({from: '/user/:userId'}),
      );
      navigate({to: 'posts/:postId', params: {userId: 'abc', postId: 'def'}});
      navigate({to: './', params: {userId: 'abc'}});
      // @ts-expect-error
      navigate({to: '../posts/:postId', params: {userId: 'abc', postId: 'def'}});
    });
  });

  describe('typed router guards', () => {
    it('should provide typed ActivatedRouteSnapshot to canActivate', () => {
      @Component({template: ''})
      class MyComponent {
        value?: string;
      }
      // This test is for compile-time type checking.
      createRoute({
        path: 'user-for-guard/:id',
        data: {name: 'Test'},
        getParentRoute: () => rootRoute,
        component: MyComponent,
        canActivate: [
          (route) => {
            const id: string = route.params.id;
            // @ts-expect-error
            const name: string = route.params.name;
            route.data.name;
            return true;
          },
        ],
      });
      expect().nothing();
    });

    it('should provide typed ActivatedRouteSnapshot to canActivateChild', () => {
      @Component({template: ''})
      class MyComponent {
        value?: string;
      }
      // This test is for compile-time type checking.
      createRoute({
        path: 'user-for-guard/:id',
        data: {name: 'Test'},
        getParentRoute: () => rootRoute,
        component: MyComponent,
        canActivateChild: [
          (route) => {
            const id: string = route.params.id;
            // @ts-expect-error
            const name: string = route.params.name;
            route.data.name;
            return true;
          },
        ],
      });
      expect().nothing();
    });

    it('should provide typed component to canDeactivate', () => {
      @Component({template: ''})
      class MyComponent {
        value?: string;
      }
      // This test is for compile-time type checking.
      createRoute({
        path: 'deactivate/:id',
        data: {thing: '1'},
        resolve: {
          user: () => ({name: 'Angular'}),
        },
        getParentRoute: () => rootRoute,
        component: MyComponent,
        canDeactivate: [
          (component, route) => {
            component.value;
            // @ts-expect-error
            component.nonExistent;
            route.data.thing;
            // @ts-expect-error
            route.data.otherThing;
            const x: string = route.data.user.name;
            // @ts-expect-error
            const y: number = route.data.user.name;
            // @ts-expect-error
            const z = route.data.user.age;
            const id: string = route.params.id;
            // @ts-expect-error
            const nonExistent: string = route.params.nonExistent;
            return true;
          },
        ],
      });
      expect().nothing();
    });
  });

  describe('lazy loading', () => {
    it('should initialize routes loaded via nested loadChildren', async () => {
      let initializedWithPath = '';
      @Component({
        standalone: true,
        template: '',
      })
      class LazyGrandchildComponent {
        constructor() {
          initializedWithPath = lazyGrandchildRoute.fullPath;
        }
      }

      const lazyGrandchildRoute = createRoute({
        path: 'lazy-grandchild/:gc',
        component: LazyGrandchildComponent,
        getParentRoute: () => lazyChildRoute,
      });
      const lazyChildRoute = createRoute({
        path: 'lazy-child/:c',
        getParentRoute: () => lazyParentRoute,
      });
      lazyChildRoute.children = [lazyGrandchildRoute];
      const lazyParentRoute = createRoute({
        path: 'lazy-parent/:p',
        getParentRoute: () => rootRoute,
      });
      lazyParentRoute.loadChildren = () => Promise.resolve([lazyChildRoute]);
      TestBed.configureTestingModule({
        providers: [provideRouter([lazyParentRoute])],
      });
      await RouterTestingHarness.create('/lazy-parent/a/lazy-child/b/lazy-grandchild/c');
      expect(initializedWithPath).toBe('/lazy-parent/:p/lazy-child/:c/lazy-grandchild/:gc');
    });
  });
});
