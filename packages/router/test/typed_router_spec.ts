import {Component} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {RouterOutlet} from '@angular/router';
import {RouterTestingHarness} from '@angular/router/testing';
import {
  createRoute,
  createRootRoute,
  injectTypedRoute,
  injectTypedRouter,
  provideTypedRouter,
  SnapshotFromTypedRoute,
} from '../src/typed_router';

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
  route = injectTypedRoute('/user-with-resolver/:userId/posts/:postId');
  constructor() {
    this.route.params().userId;
    this.route.params().postId;
    // @ts-expect-error
    this.route.params().nonExistent;
  }
}

@Component({
  standalone: true,
  template: `
    _snapshot: {{route.params().userId}}
    _snapshot data: {{route.data().loaded}}
      `,
})
class LazyLoadedComponent {
  route = injectTypedRoute('/lazy/:userId');
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
const userRoute = createRoute({
  path: 'user/:userId',
  getParentRoute: () => rootRoute,
  component: UserComponent,
});
const postsRoute = createRoute({
  path: 'posts/:postId',
  getParentRoute: () => userRoute,
  component: PostsComponent,
});

const userRouteWithResolver = createRoute({
  path: 'user-with-resolver/:userId',
  getParentRoute: () => rootRoute,
  component: UserWithDataComponent,
  resolve: {
    user: (route) => ({id: route.params.userId, name: 'Angular'}),
  },
});
const postsRouteWithResolver = createRoute({
  path: 'posts/:postId',
  getParentRoute: () => userRouteWithResolver,
  component: PostsWithDataComponent,
  resolve: {
    post: (route) => {
      const user = route.data.user;
      return {id: route.params.postId, title: `Post by ${user.name}`};
    },
  },
});

const lazyRouteShape = createRoute({
  path: 'lazy/:userId',
  getParentRoute: () => rootRoute,
});
const lazyRoute = lazyRouteShape.lazy(() =>
  Promise.resolve({
    component: LazyLoadedComponent,
    resolve: {
      loaded: (route: SnapshotFromTypedRoute<typeof lazyRouteShape>) =>
        `${route.params.userId} loaded`,
    },
  }),
);

const routerTree = rootRoute.addChildren([
  userRoute.addChildren([postsRoute]),
  userRouteWithResolver.addChildren([postsRouteWithResolver]),
  lazyRoute,
]);

type RouterTree = typeof routerTree;

declare module '../src/typed_router' {
  interface Register {
    router: TypedRouter<RouterTree>;
  }
}

describe('TypedRouter', () => {
  describe('type inference', () => {
    it('should infer params from path', async () => {
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routerTree)],
      });
      const harness = await RouterTestingHarness.create('/user/123');
      harness.fixture.detectChanges();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123');
    });

    it('should infer parent params for children', async () => {
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routerTree)],
      });
      const harness = await RouterTestingHarness.create('/user/123/posts/456');
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123, postId: 456');
    });

    it('should infer parent data in child resolver', async () => {
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routerTree)],
      });
      const harness = await RouterTestingHarness.create('/user-with-resolver/123/posts/456');
      harness.fixture.detectChanges();
      expect(harness.fixture.nativeElement.innerHTML).toContain(
        'user: Angular, post: Post by Angular',
      );
    });
  });

  describe('TypedRouter navigation', () => {
    it('should navigate to a simple route', async () => {
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routerTree)],
      });
      const harness = await RouterTestingHarness.create('/');
      const typedRouter = TestBed.runInInjectionContext(injectTypedRouter);
      await typedRouter.navigate('/user/:userId', {userId: '123'});
      harness.fixture.detectChanges();
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123');
    });

    it('should navigate to a child route', async () => {
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routerTree)],
      });
      const harness = await RouterTestingHarness.create('/');
      const typedRouter = TestBed.runInInjectionContext(injectTypedRouter);

      await typedRouter.navigate('/user/:userId/posts/:postId', {
        userId: '123',
        postId: '456',
      });
      await harness.fixture.whenStable();

      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123, postId: 456');
    });

    it('should support lazy loading a route', async () => {
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routerTree)],
      });
      const harness = await RouterTestingHarness.create('/lazy/lazy-loaded-route');
      expect(harness.fixture.nativeElement.innerHTML).toContain('_snapshot: lazy-loaded-route');
      expect(harness.fixture.nativeElement.innerHTML).toContain(
        '_snapshot data: lazy-loaded-route loaded',
      );
    });

    it('should provide a typed route with injectTypedRoute', async () => {
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routerTree)],
      });
      const harness = await RouterTestingHarness.create('/user-with-resolver/snapshot-test');
      harness.fixture.detectChanges();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: snapshot-test');
      expect(harness.fixture.nativeElement.innerHTML).toContain('user name: Angular');
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
        path: 'deactivate',
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
            return true;
          },
        ],
      });
      expect().nothing();
    });
  });
});
