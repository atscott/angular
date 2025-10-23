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

1.  **`createRootRoute`**: The main factory function for creating the root of a typed route hierarchy. It returns a `RootRoute` instance, which is a special branded type that `provideRouter` requires.

2.  **`createRoute`**: The main factory function for creating a typed child route. It takes the route's configuration as a single object, including its `path`, `getParentRoute`, `component`, `data`, `resolve`, `canActivate`, `canActivateChild`, and `canDeactivate` properties. It returns a `RouteBuilder` instance.
    > **Note on Property Ordering**: For TypeScript's type inference to work correctly, properties must be ordered based on their dependencies. The `getParentRoute` property must be defined first, followed by `data`, then `resolve`, and finally `canActivate`, `canActivateChild`, or `canDeactivate`. This allows the compiler to correctly build up the full data shape of the route, which is necessary to correctly type the function signatures of the resolvers and guards.

3.  **`RouteBuilder`**: This class is returned by `createRoute` and provides methods to continue defining the route.

4.  **`.setResolvers()` method**: The `RouteBuilder` instance has a `.setResolvers()` method that allows you to attach resolvers after the route has been created. This method will overwrite any resolvers that may have been provided inline in `createRoute`. This is the key to organizing code and avoiding circular dependencies when defining resolvers in separate files.

5.  **`.lazy()` method**: The `RouteBuilder` instance has a `.lazy()` method for defining lazy-loaded properties. This method is the solution for code-splitting in the typed router. It solves the core problem of traditional `loadChildren`, which hides a route's *shape* (its path and params) from the type system. The `.lazy()` method allows the route's shape to be defined eagerly—so it is included in the global type information—while deferring the loading of its *implementation* (the `component` and `resolve` functions) until the route is activated.

6.  **`.addChildren()` method**: The `RouteBuilder` instance has an `.addChildren()` method that takes an array of child route builders. It returns a new `RouteBuilder` instance where the `children` property is strongly typed to match the children that were passed in. This allows for a fully fluent and composable way to define the route hierarchy.
    > **Why not define children inline?** The `.addChildren()` method is used instead of a `children` property inside `createRoute` for two main reasons. First, it ensures that each route is created as a distinct, referenceable instance. Second, it helps prevent circular module dependencies in TypeScript. The API relies on the `getParentRoute` function returning an actual parent *value* at creation time. This direct link provides the most robust and straightforward way for TypeScript to infer the parent's context for the child's resolvers and guards. While an alternative using `import type` and type assertions (`() => null! as ParentType`) could enable inline children, it was avoided in favor of this more explicit and less "magical" approach.
    > 
    > **Note on `<const TNewChildren>`**: The method signature uses a `const` generic (`<const TNewChildren>`). This is a critical optimization that signals to TypeScript to treat the input array as a read-only tuple with a fixed structure. Without this, TypeScript may attempt to serialize the full, deeply-nested type of the children array, often leading to a "Type instantiation is excessively deep and possibly infinite" error for large route configurations.

This API provides a clean, composable, and highly type-safe way to define routes.

### Organizing Code with `.setResolvers()`

While `resolve` can be defined inline within `createRoute` for simple cases, this can lead to circular module dependencies if the resolver functions are in separate files. The `.setResolvers()` method is the solution for this architectural challenge.

The recommended pattern is:
1.  Define the route's shape in one file (`user.routes.ts`).
2.  Define the resolver functions in a second file, which can safely import the route's type (`user.resolvers.ts`).
3.  Use `.setResolvers()` in a third assembly file (or back in the original route file) to combine them.

```typescript
// user.routes.ts
export const userRoute = createRoute({
  path: 'user/:userId',
  getParentRoute: () => rootRoute,
});

// user.resolvers.ts
import type { SnapshotFromRoute } from '@angular/router';
import { userRoute } from './user.routes';

export const userResolvers = {
  user: (route: SnapshotFromRoute<typeof userRoute>) => {
    // `route.params.userId` is fully typed!
    return { id: route.params.userId, name: 'Resolved User' };
  },
};

// app.routes.ts (or another assembly file)
import { userRoute } from './user.routes';
import { userResolvers } from './user.resolvers';

const userRouteWithResolver = userRoute.setResolvers(userResolvers);
// ... add userRouteWithResolver to the router tree
```

### Global Type Safety with Declaration Merging

To achieve a truly global and ergonomic type-safe experience, the API leverages TypeScript's declaration merging via a `Register` interface. This allows you to register your final route tree type once, making it available to `injectRouter` and `injectRoute` throughout your application without needing to pass generic parameters manually.

```typescript
// 1. Define your routes and export the final type
export const appRoutes = createRootRoute().addChildren([...]);
export type AppRouteTree = typeof appRoutes;

// 2. Use declaration merging to register the type globally
declare module '@angular/router' {
  interface Register {
    router: Router<AppRouteTree>;
  }
}

// 3. Now, injection functions are automatically typed
class MyComponent {
  // No generic needed, it's inferred from the Register interface
  private router = injectRouter();

  navigateToPost() {
    // Path and params are fully typed based on AppRouteTree
    this.router.navigate('/user/:userId/posts/:postId', { userId: '123', postId: '456' });
  }
}
```

### Runtime Implementation

-   **Deferred Initialization**: To support advanced routing patterns like file-based routing, parent-dependent properties (such as `fullPath`) are not calculated in the route's constructor. Instead, each route has an `init()` method that is called by its parent (specifically, within the `.addChildren()` method). This ensures that the parent is fully defined before the child's properties are computed.
-   **`paramsInheritanceStrategy`**: The `provideRouter` function automatically configures the `paramsInheritanceStrategy` to `'always'`. This is a crucial requirement for the typed router, as it ensures that child routes correctly inherit parameters from their parents, which is not the default behavior in Angular.
-   **Resolver Execution**: The `resolveNode` function in `resolve_data.ts` was updated to handle the `resolve` object on typed routes, executing each resolver and merging the resulting object into the route's `data`.
-   **Lazy Loading with `load`**: The `recognize` function in `recognize.ts` was updated to `await` the `load` function (attached via the `.lazy()` method) and merge the resulting properties into the route config before creating the snapshot.

### Signal-based `ActivatedRoute`

To provide a more ergonomic and modern API, a new `injectRoute` function and `ActivatedRoute` class were introduced.

-   **`ActivatedRoute`**: A strongly-typed wrapper around the standard `ActivatedRoute`. It exposes the route's observable-based properties (`params`, `data`, `queryParams`, etc.) as signals, using `@angular/core/rxjs-interop`.
-   **`injectRoute`**: An injection function that takes a route's full path string (e.g. `/users/:userId`) and returns a fully-typed instance of `ActivatedRoute`. Using the `route.fullPath` property of a route definition is recommended to avoid magic strings. This eliminates the need for manual type casting of the `ActivatedRoute` or its snapshot.

### `AnyRoute` Fallback for Testing and Migration

To facilitate easier unit testing and provide a smoother migration path from the traditional router, the typed router's API provides a fallback to `any` when a specific route tree is not provided or registered.

When the router is typed as `Router<AnyRoute>` (which can be done by providing a minimal route tree to `provideRouter` or by not having a global `Register` interface), the following behavior occurs:

-   `router.navigate()`: The `path` parameter will accept any `string`, and the `params` parameter will accept any `Record<string, any>`.
-   `injectRoute()`: The function will accept any `string` for the path, and it will return an `ActivatedRoute<AnyRoute>`, where `.params()` and `.data()` signals emit values of type `any`.

This allows you to write unit tests without needing to construct and register a full, complex route tree, and enables a gradual adoption of the typed router within an existing application.

```typescript
// In a test file
TestBed.configureTestingModule({
  // A minimal, valid route config is provided, so the router is typed with AnyRoute
  providers: [provideRouter(createRootRoute().addChildren([...]))],
});
const router = TestBed.inject(Router);

// This is now valid without type errors
await router.navigate('/some/unregistered/path', { id: 123 });
```

### Testing

-   **Use `RouterTestingHarness`**: The modern `RouterTestingHarness` is the correct tool for testing. It should be configured with `provideRouter(routes)`.
-   **Waiting for Stability**: When testing imperative navigation (e.g., `router.navigate()`) or initial navigation via `RouterTestingHarness.create()`, you must `await harness.fixture.whenStable()` before making assertions about the rendered template. This ensures that the navigation and subsequent change detection have completed.
-   **Asserting Type Safety with `@ts-expect-error`**: The most effective way to test the type safety of the API is to use `// @ts-expect-error` comments. This allows you to write assertions that *fail to compile* if the types are incorrect, providing a strong guarantee. This is best done inside a component's constructor.

### Limitations: `canMatch` Guards

The typed router's safety model relies on creating a complete and unambiguous "map" of the entire route tree at compile time, where each `fullPath` corresponds to a single, static route shape.

The `canMatch` guard feature can create ambiguity if it is used to guard two routes that have the **same path but different child route shapes**. This pattern is not supported by the typed router because it makes it impossible for the type system to know which child routes are valid for a given path.

**Recommended Pattern:** If you use `canMatch` on multiple routes that share the same path, you **must ensure they also have the same static child route configuration**. The dynamic logic (like redirecting an unauthorized user) should be handled *inside* the guard's logic, not by providing a different tree shape. This preserves the static map of the application while still allowing for powerful runtime control.

For complex cases where this is not feasible, you can fall back to the traditional `Route` object from `@angular/router`. The `.addChildren()` method accepts both typed and untyped route objects, allowing you to opt out of type safety for specific, ambiguous branches of your application tree.

### Type-Safe Relative Navigation

A powerful feature of the typed router is its support for type-safe relative navigation, inspired by libraries like TanStack Router. This enhances ergonomics by allowing navigation calls to be made relative to a known route, rather than always being absolute from the application root.

The API includes two main additions:

1.  **An enhanced `router.navigate()` method:** The global `router.navigate()` method is overloaded to accept a `NavigateOptions` object. When this object includes a `from` property (referencing a route's `fullPath` string), the `to` property is type-safe for relative paths (e.g., `'./edit'`, `'../'`).

2.  **A hook-like `injectNavigate()` function:** For the most ergonomic experience within components, a new `injectNavigate()` function was introduced.
    -   `injectNavigate()` returns the global, fully-featured `navigate` function.
    -   `injectNavigate({ from: userRoute.fullPath })` returns a specialized `navigate` function with the "from" context already baked in, making subsequent calls for relative navigation extremely concise.

This enables powerful, type-safe patterns like this:

```typescript
// Proposed API
class UserComponent {
  // Get a navigator that already knows it's inside the `userRoute`
  private navigate = injectNavigate({ from: userRoute.fullPath });

  editUser() {
    // Navigate to a relative path without re-specifying context
    this.navigate({ to: './edit' });
  }

  updateParams() {
    // Get a type-safe previous state for query param updates
    this.navigate({
      to: '.',
      params: (prev) => ({ ...prev, userId: 'new-id' }),
    });
  }
}
```

This feature represents a significant improvement in developer experience for imperative navigation.

    ```typescript
    // In a component used for testing
    const userRoute = createRoute({ path: 'user/:userId', component: UserComponent });

    @Component({ template: `...` })
    class UserComponent {
      route = injectRoute('/user/:userId');

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
  providers: [provideRouter(appRoutes)]
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
  route = injectRoute(postsRoute.fullPath);
}

// 5. Use the Router for navigation
class MyComponent {
  private router = inject(Router);

  navigateToPost() {
    // This navigation is fully type-checked
    this.router.navigate(postsRoute.fullPath, { userId: '123', postId: '456' });
  }
}
```
