/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {Component, inject} from '@angular/core';
import {TestBed} from '@angular/core/testing';
import {ActivatedRoute, RouterOutlet} from '@angular/router';
import {RouterTestingHarness} from '@angular/router/testing';
import {
  createRoute,
  injectTypedRoute,
  provideTypedRouter,
  SnapshotFromTypedRoute,
  TypedRouter,
} from '../src/typed_router';
import {isTypedRoute} from '../src/typed_router_utils';

describe('TypedRouter', () => {
  @Component({standalone: true, template: 'child'})
  class ChildComponent {}

  @Component({
    standalone: true,
    template: `<router-outlet></router-outlet>`,
    imports: [RouterOutlet],
  })
  class ParentComponentWithOutlet {}

  it('should create a typed route', () => {
    const route = createRoute({
      path: 'user/:userId',
      component: ChildComponent,
    });
    expect(route.path).toBe('user/:userId');
    expect(isTypedRoute(route)).toBe(true);
  });

  it('should add children to a route', () => {
    const parent = createRoute({path: 'parent', component: ParentComponentWithOutlet});
    const child = createRoute({path: 'child', component: ChildComponent});
    parent.addChildren([child]);
    expect(parent.children?.[0]).toBe(child);
  });

  it('should add children to a route from an object', () => {
    const parent = createRoute({path: 'parent', component: ParentComponentWithOutlet});
    const child1 = createRoute({path: 'child1', component: ChildComponent});
    const child2 = createRoute({path: 'child2', component: ChildComponent});
    parent.addChildren({child1, child2});
    expect(parent.children?.length).toBe(2);
    expect(parent.children).toContain(child1);
    expect(parent.children).toContain(child2);
  });

  describe('type inference', () => {
    it('should infer params from path', async () => {
      @Component({standalone: true, template: `userId: {{ route.params().userId }}`})
      class UserComponent {
        route = injectTypedRoute(userRoute);
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
      const routes = [userRoute];
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routes)],
      });
      const harness = await RouterTestingHarness.create('/user/123');
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123');
    });

    it('should infer parent params for children', async () => {
      const userRoute = createRoute({
        path: 'user/:userId',
        component: ParentComponentWithOutlet,
      });
      @Component({
        standalone: true,
        template: `userId: {{ route.params().userId }}, postId: {{ route.params().postId }}`,
      })
      class PostsComponent {
        route = injectTypedRoute(postsRoute);
        constructor() {
          this.route.params().userId;
          this.route.params().postId;
          // @ts-expect-error
          this.route.params().nonExistent;
        }
      }
      const postsRoute = createRoute({
        path: 'posts/:postId',
        getParentRoute: () => userRoute,
        component: PostsComponent,
      });
      userRoute.addChildren([postsRoute]);
      const routes = [userRoute];
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routes)],
      });
      const harness = await RouterTestingHarness.create('/user/123/posts/456');
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123, postId: 456');
    });

    it('should infer parent data in child resolver', async () => {
      const userRoute = createRoute({
        path: 'user/:userId',
        component: ParentComponentWithOutlet,
      }).addResolvers({
        user: (route) => ({id: route.params['userId'], name: 'Angular'}),
      });
      @Component({
        standalone: true,
        template: `user: {{ route.data().user.name }}, post: {{ route.data().post.title }}`,
      })
      class PostsComponent {
        route = injectTypedRoute(postsRoute);
        constructor() {
          this.route.params().userId;
          this.route.params().postId;
          // @ts-expect-error
          this.route.params().nonExistent;
        }
      }
      const postsRoute = createRoute({
        path: 'posts/:postId',
        getParentRoute: () => userRoute,
        component: PostsComponent,
      }).addResolvers({
        post: (route) => {
          const user: {id: string; name: string} = route.data.user;
          return {id: route.params.postId, title: `Post by ${user.name}`};
        },
      });
      userRoute.addChildren([postsRoute]);
      const routes = [userRoute];
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routes)],
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
        route = injectTypedRoute(userRoute);
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
      const routes = [userRoute];
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routes)],
      });
      const harness = await RouterTestingHarness.create('/');
      const typedRouter = TestBed.inject(TypedRouter);

      await typedRouter.navigateByRoute(userRoute, {userId: '123'});
      await harness.fixture.whenStable();

      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123');
    });

    it('should navigate to a child route', async () => {
      const userRoute = createRoute({
        path: 'user/:userId',
        component: ParentComponentWithOutlet,
      });
      @Component({
        standalone: true,
        template: `userId: {{ route.params().userId }}, postId: {{ route.params().postId }}`,
      })
      class PostsComponent {
        route = injectTypedRoute(postsRoute);
        constructor() {
          this.route.params().userId;
          this.route.params().postId;
          // @ts-expect-error
          this.route.params().nonExistent;
        }
      }
      const postsRoute = createRoute({
        path: 'posts/:postId',
        getParentRoute: () => userRoute,
        component: PostsComponent,
      });
      userRoute.addChildren([postsRoute]);
      const routes = [userRoute];
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routes)],
      });
      const harness = await RouterTestingHarness.create('/');
      const typedRouter = TestBed.inject(TypedRouter);

      await typedRouter.navigateByRoute(postsRoute, {userId: '123', postId: '456'});
      await harness.fixture.whenStable();

      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123, postId: 456');
    });

    it('should support lazy loading a route', async () => {
      @Component({
        standalone: true,
        template: `
    _snapshot: {{route.params().userId}}
    _snapshot data: {{route.data().loaded}}
            `,
      })
      class LazyLoadedComponent {
        route = injectTypedRoute(lazyRoute);
      }

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
      const routes = [lazyRoute];
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routes)],
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
        route = injectTypedRoute(userRoute);
      }
      const userRoute = createRoute({
        path: 'user/:userId',
        component: UserComponent,
      }).addResolvers({
        user: (route) => ({id: route.params.userId, name: 'Angular'}),
      });

      const routes = [userRoute];
      TestBed.configureTestingModule({
        providers: [provideTypedRouter(routes)],
      });
      const harness = await RouterTestingHarness.create('/user/snapshot-test');
      await harness.fixture.whenStable();
      expect(harness.fixture.nativeElement.innerHTML).toContain('userId: snapshot-test');
      expect(harness.fixture.nativeElement.innerHTML).toContain('user name: Angular');
    });
  });
});
