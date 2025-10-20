/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {Component} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {RouterOutlet} from '@angular/router';
import {RouterTestingHarness} from '@angular/router/testing';
import {
  createRoute,
  createRootRoute,
  injectTypedRoute,
  provideTypedRouter,
  SnapshotFromTypedRoute,
  TypedActivatedRoute,
  TypedRouter,
} from '../src/typed_router';

describe('TypedRouter', () => {
  @Component({standalone: true, template: 'child'})
  class ChildComponent {}

  @Component({
    standalone: true,
    template: `<router-outlet></router-outlet>`,
    imports: [RouterOutlet],
  })
  class ParentComponentWithOutlet {}

  it('should add children to a route', () => {
    const parent = createRoute({path: 'parent', component: ParentComponentWithOutlet});
    const child = createRoute({
      path: 'child',
      component: ChildComponent,
      getParentRoute: () => parent,
    });
    const tree = parent.addChildren([child]);
    expect(tree.children?.[0]).toBe(child);
  });

  describe('type inference', () => {
    it('should infer params from path', async () => {
      @Component({standalone: true, template: `userId: {{ route.params().userId }}`})
      class UserComponent {
        route = injectTypedRoute(rootRoute, '/user/:userId');
        constructor() {
          this.route.params().userId;
          // @ts-expect-error
          this.route.params().nonExistent;
        }
      }

      const userRoute = createRoute({
        path: 'user/:userId',
        component: UserComponent,
      });
      const rootRoute = createRootRoute().addChildren([userRoute]);

      TestBed.configureTestingModule({
        providers: [provideTypedRouter(rootRoute)],
      });
      const harness = await RouterTestingHarness.create('/user/123');
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123');
    });

    it('should infer parent params for children', async () => {
      @Component({
        standalone: true,
        template: `userId: {{ route.params().userId }}, postId: {{ route.params().postId }}`,
      })
      class PostsComponent {
        route: TypedActivatedRoute<typeof postsRoute>;
        constructor() {
          this.route = injectTypedRoute(rootRoute, '/user/:userId/posts/:postId');
          this.route.params().userId;
          this.route.params().postId;
          // @ts-expect-error
          this.route.params().nonExistent;
        }
      }
      const userRoute = createRoute({
        path: 'user/:userId',
        component: ParentComponentWithOutlet,
      });
      const postsRoute = createRoute({
        path: 'posts/:postId',
        getParentRoute: () => userRoute,
        component: PostsComponent,
      });
      const rootRoute = createRootRoute().addChildren([userRoute.addChildren([postsRoute])]);

      TestBed.configureTestingModule({
        providers: [provideTypedRouter(rootRoute)],
      });
      const harness = await RouterTestingHarness.create('/user/123/posts/456');
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123, postId: 456');
    });

    it('should infer parent data in child resolver', async () => {
      @Component({
        standalone: true,
        template: `user: {{ route.data().user.name }}, post: {{ route.data().post.title }}`,
      })
      class PostsComponent {
        route: TypedActivatedRoute<typeof postsRoute>;
        constructor() {
          this.route = injectTypedRoute(rootRoute, '/user/:userId/posts/:postId');
          this.route.params().userId;
          this.route.params().postId;
          // @ts-expect-error
          this.route.params().nonExistent;
        }
      }
      const userRoute = createRoute({
        path: 'user/:userId',
        component: ParentComponentWithOutlet,
      }).setResolvers({
        user: (route) => ({id: route.params['userId'], name: 'Angular'}),
      });
      const postsRoute = createRoute({
        path: 'posts/:postId',
        getParentRoute: () => userRoute,
        component: PostsComponent,
      }).setResolvers({
        post: (route) => {
          const user: {id: string; name: string} = route.data.user;
          return {id: route.params.postId, title: `Post by ${user.name}`};
        },
      });
      const rootRoute = createRootRoute().addChildren([userRoute.addChildren([postsRoute])]);

      TestBed.configureTestingModule({
        providers: [provideTypedRouter(rootRoute)],
      });
      const harness = await RouterTestingHarness.create('/user/123/posts/456');
      expect(harness.fixture.nativeElement.innerHTML).toContain(
        'user: Angular, post: Post by Angular',
      );
    });
  });

  describe('TypedRouter navigation', () => {
    it('should navigate to a simple route', async () => {
      @Component({standalone: true, template: `userId: {{ route.params().userId }}`})
      class UserComponent {
        route: TypedActivatedRoute<typeof userRoute>;
        constructor() {
          this.route = injectTypedRoute(rootRoute, '/user/:userId');
          this.route.params().userId;
          // @ts-expect-error
          this.route.params().nonExistent;
        }
      }
      const userRoute = createRoute({
        path: 'user/:userId',
        component: UserComponent,
      });
      const rootRoute = createRootRoute().addChildren([userRoute]);

      TestBed.configureTestingModule({
        providers: [provideTypedRouter(rootRoute)],
      });
      const harness = await RouterTestingHarness.create('/');
      const typedRouter = TestBed.inject(TypedRouter<typeof rootRoute>);

      await typedRouter.navigate('/user/:userId', {userId: '123'});
      await harness.fixture.whenStable();

      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123');
    });

    it('should navigate to a child route', async () => {
      @Component({
        standalone: true,
        template: `userId: {{ route.params().userId }}, postId: {{ route.params().postId }}`,
      })
      class PostsComponent {
        route: TypedActivatedRoute<typeof postsRoute>;
        constructor() {
          this.route = injectTypedRoute(rootRoute, '/user/:userId/posts/:postId');
          this.route.params().userId;
          this.route.params().postId;
          // @ts-expect-error
          this.route.params().nonExistent;
        }
      }

      const userRoute = createRoute({
        path: 'user/:userId',
        component: ParentComponentWithOutlet,
      });
      const postsRoute = createRoute({
        path: 'posts/:postId',
        getParentRoute: () => userRoute,
        component: PostsComponent,
      });
      const rootRoute = createRootRoute().addChildren([userRoute.addChildren([postsRoute])]);

      TestBed.configureTestingModule({
        providers: [provideTypedRouter(rootRoute)],
      });
      const harness = await RouterTestingHarness.create('/');
      const typedRouter = TestBed.inject(TypedRouter<typeof rootRoute>);

      await typedRouter.navigate('/user/:userId/posts/:postId', {
        userId: '123',
        postId: '456',
      });
      await harness.fixture.whenStable();

      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123, postId: 456');
    });

    it('should support lazy loading a route', async () => {
      const lazyRouteShape = createRoute({
        path: 'user/:userId',
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
      const rootRoute = createRootRoute().addChildren([lazyRoute]);

      @Component({
        standalone: true,
        template: `
    _snapshot: {{route.params().userId}}
    _snapshot data: {{route.data().loaded}}
            `,
      })
      class LazyLoadedComponent {
        route: TypedActivatedRoute<typeof lazyRoute>;
        constructor() {
          this.route = injectTypedRoute(rootRoute, '/user/:userId');
        }
      }

      TestBed.configureTestingModule({
        providers: [provideTypedRouter(rootRoute)],
      });
      const harness = await RouterTestingHarness.create('/user/lazy-loaded-route');
      expect(harness.fixture.nativeElement.innerHTML).toContain('_snapshot: lazy-loaded-route');
      expect(harness.fixture.nativeElement.innerHTML).toContain(
        '_snapshot data: lazy-loaded-route loaded',
      );
    });

    it('should provide a typed route with injectTypedRoute', async () => {
      @Component({
        standalone: true,
        template: `
    userId: {{ route.params().userId }}
    user name: {{ route.data().user.name }}
            `,
      })
      class UserComponent {
        route: TypedActivatedRoute<typeof userRoute>;
        constructor() {
          this.route = injectTypedRoute(rootRoute, '/user/:userId');
        }
      }

      const userRoute = createRoute({
        path: 'user/:userId',
        component: UserComponent,
      }).setResolvers({
        user: (route) => ({id: route.params.userId, name: 'Angular'}),
      });

      const rootRoute = createRootRoute().addChildren([userRoute]);

      TestBed.configureTestingModule({
        providers: [provideTypedRouter(rootRoute)],
      });
      const harness = await RouterTestingHarness.create('/user/snapshot-test');
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: snapshot-test');
      expect(harness.fixture.nativeElement.innerHTML).toContain('user name: Angular');
    });
  });

  describe('typed router guards', () => {
    @Component({template: ''})
    class MyComponent {
      value?: string;
    }

    it('should provide typed ActivatedRouteSnapshot to canActivate', () => {
      createRootRoute().addChildren([
        createRoute({
          path: 'test/:id',
          component: MyComponent,
        }).addCanActivate([
          (route) => {
            const id: string = route.params.id;
            // @ts-expect-error
            const name: string = route.params.name;
            return true;
          },
        ]),
      ]);
      expect().nothing();
    });

    it('should provide typed component to canDeactivate', () => {
      createRoute({
        path: 'test',
        component: MyComponent,
      }).addCanDeactivate<MyComponent>([
        (component) => {
          component.value;
          // @ts-expect-error
          component.nonExistent;
          return true;
        },
      ]);
      expect().nothing();
    });
  });
});
