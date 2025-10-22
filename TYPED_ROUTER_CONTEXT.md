# Type-Safe Router API Design

This document summarizes the final architectural decisions for the type-safe Angular Router API. The primary inspiration for this work is [TanStack Router](https://tanstack.com/router/).

## 1. Core Goals

-   Statically known route paths and parameters.
-   Type-checked navigation calls.
-   Type-safe `ActivatedRoute` for parameters and resolved data.
-   A developer experience that feels natural within Angular.

## 2. Final Architecture: A Composable, Type-Inferred API

Early designs struggled with TypeScript's limitations, particularly circular dependencies when trying to infer resolver types within a large, nested route configuration object. The final architecture solves this by adopting a composable, function-based approach inspired by TanStack Router.

### API Overview

The final architecture uses a class-based, fluent-style API, initiated by factory functions.

1.  **`createRootRoute`**: The main factory function for creating the root of a typed route hierarchy. It returns a `TypedRootRoute` instance, which is a special branded type that `provideTypedRouter` requires.

2.  **`createRoute`**: The main factory function for creating a typed child route. It takes the route's configuration as a single object, including its `path`, `getParentRoute`, `component`, `data`, `resolve`, `canActivate`, `canActivateChild`, and `canDeactivate` properties. It returns a `TypedRouteBuilder` instance.
    > **Note on Property Ordering**: For TypeScript's type inference to work correctly, properties must be ordered based on their dependencies. The `getParentRoute` property must be defined first, followed by `data`, then `resolve`, and finally `canActivate`, `canActivateChild`, or `canDeactivate`. This allows the compiler to correctly build up the full data shape of the route, which is necessary to correctly type the function signatures of the resolvers and guards.

3.  **`TypedRouteBuilder`**: This class is returned by `createRoute` and provides methods to continue defining the route.

4.  **`.lazy()` method**: The `TypedRouteBuilder` instance has a `.lazy()` method for defining lazy-loaded properties. This method takes a function that returns a `Promise` for an object containing the `component` and an optional `resolve` object.

5.  **`.addChildren()` method**: The `TypedRouteBuilder` instance has an `.addChildren()` method that takes an array of child route builders. It returns a new `TypedRouteBuilder` instance where the `children` property is strongly typed to match the children that were passed in. This allows for a fully fluent and composable way to define the route hierarchy.
    > **Note on `<const TNewChildren>`**: The method signature uses a `const` generic (`<const TNewChildren>`). This is a critical optimization that signals to TypeScript to treat the input array as a read-only tuple with a fixed structure. Without this, TypeScript may attempt to serialize the full, deeply-nested type of the children array, often leading to a "Type instantiation is excessively deep and possibly infinite" error for large route configurations.

This API provides a clean, composable, and highly type-safe way to define routes.

### Global Type Safety with Declaration Merging

To achieve a truly global and ergonomic type-safe experience, the API leverages TypeScript's declaration merging via a `Register` interface. This allows you to register your final route tree type once, making it available to `injectTypedRouter` and `injectTypedRoute` throughout your application without needing to pass generic parameters manually.

```typescript
// 1. Define your routes and export the final type
export const appRoutes = createRootRoute().addChildren([...]);
export type AppRouteTree = typeof appRoutes;

// 2. Use declaration merging to register the type globally
declare module '@angular/router' {
  interface Register {
    router: TypedRouter<AppRouteTree>;
    routeTree: AppRouteTree;
  }
}

// 3. Now, injection functions are automatically typed
class MyComponent {
  // No generic needed, it's inferred from the Register interface
  private typedRouter = injectTypedRouter();

  navigateToPost() {
    // Path and params are fully typed based on AppRouteTree
    this.typedRouter.navigate('/user/:userId/posts/:postId', { userId: '123', postId: '456' });
  }
}
```

### Runtime Implementation

-   **`paramsInheritanceStrategy`**: The `provideTypedRouter` function automatically configures the `paramsInheritanceStrategy` to `'always'`. This is a crucial requirement for the typed router, as it ensures that child routes correctly inherit parameters from their parents, which is not the default behavior in Angular.
-   **Resolver Execution**: The `resolveNode` function in `resolve_data.ts` was updated to handle the `resolve` object on typed routes, executing each resolver and merging the resulting object into the route's `data`.
-   **Lazy Loading with `load`**: The `recognize` function in `recognize.ts` was updated to `await` the `load` function (attached via the `.lazy()` method) and merge the resulting properties into the route config before creating the snapshot.

### Signal-based `TypedActivatedRoute`

To provide a more ergonomic and modern API, a new `injectTypedRoute` function and `TypedActivatedRoute` class were introduced.

-   **`TypedActivatedRoute`**: A strongly-typed wrapper around the standard `ActivatedRoute`. It exposes the route's observable-based properties (`params`, `data`, `queryParams`, etc.) as signals, using `@angular/core/rxjs-interop`.
-   **`injectTypedRoute`**: An injection function that takes a route's full path string (e.g. `/users/:userId`) and returns a fully-typed instance of `TypedActivatedRoute`. This eliminates the need for manual type casting of the `ActivatedRoute` or its snapshot.

### Testing

-   **Use `RouterTestingHarness`**: The modern `RouterTestingHarness` is the correct tool for testing. It should be configured with `provideTypedRouter(routes)`.
-   **Waiting for Stability**: When testing imperative navigation (e.g., `router.navigate()`) or initial navigation via `RouterTestingHarness.create()`, you must `await harness.fixture.whenStable()` before making assertions about the rendered template. This ensures that the navigation and subsequent change detection have completed.
-   **Asserting Type Safety with `@ts-expect-error`**: The most effective way to test the type safety of the API is to use `// @ts-expect-error` comments. This allows you to write assertions that *fail to compile* if the types are incorrect, providing a strong guarantee. This is best done inside a component's constructor.

    ```typescript
    // In a component used for testing
    const userRoute = createRoute({ path: 'user/:userId', component: UserComponent });

    @Component({ template: `...` })
    class UserComponent {
      route = injectTypedRoute('/user/:userId');

      constructor() {
        // This line should compile without error
        const id: string = this.route.params().userId;

        // This line SHOULD cause a type error, so we assert that with @ts-expect-error
        // @ts-expect-error: Should error because `nonExistent` does not exist
        const x = this.route.params().nonExistent;
      }
    }
    ```

### Example Usage

```typescript
// 1. Define routes using the API
const rootRoute = createRootRoute();

const userRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'user/:userId',
  resolve: {
    user: (route) => ({ id: route.params.userId, name: 'Resolved User' }),
  },
  canActivate: [(route) => {
    // route.params.userId is a string
    console.log('Checking access to user:', route.params.userId);
    return true;
  }],
});

const postsRoute = createRoute({
  getParentRoute: () => userRoute,
  path: 'posts/:postId',
}).lazy(() => import('./posts.component').then(m => ({
  component: m.PostsComponent,
  resolve: {
    // `route.data.user` is fully typed here
    posts: (route) => [{ id: route.params.postId, title: `Post by ${route.data.user.name}` }],
  }
})));

// 2. Build the runtime hierarchy
const appRoutes = rootRoute.addChildren([userRoute.addChildren([postsRoute])]);

// 3. Provide the routes
bootstrapApplication(AppComponent, {
  providers: [provideTypedRouter(appRoutes)]
});

// 4. Inject the typed route in a component
@Component({
  template: `
    User: {{ route.data().user.name }}
    Post: {{ route.data().posts[0].title }}
    Params: {{ route.params().userId }} / {{ route.params.postId }}
  `
})
class PostsComponent {
  // The route is fully typed and signal-based
  route = injectTypedRoute('/user/:userId/posts/:postId');
}

// 5. Use the TypedRouter for navigation
class MyComponent {
  private typedRouter = inject(TypedRouter);

  navigateToPost() {
    // This navigation is fully type-checked
    this.typedRouter.navigate('/user/:userId/posts/:postId', { userId: '123', postId: '456' });
  }
}
```