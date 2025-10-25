# Type-Safe Router API Design

This document summarizes the final architectural decisions for the type-safe Angular Router API. The primary inspiration for this work is [TanStack Router](https://tanstack.com/router/).

## 1. Core Goals

-   Statically known route paths and parameters.
-   Type-checked navigation calls.
-   Type-safe `ActivatedRoute` for parameters and resolved data.
-   A developer experience that feels natural within Angular.

## 2. Final Architecture: A Hybrid, Performance-First API

Early designs focused on a fully-composable, function-based API that used deep TypeScript inference to build a type-safe route tree. However, after observing potential performance issues in other libraries with similar approaches (like TanStack Router), the architecture was pivoted to a more performant and familiar model that combines the best of explicit definition and type inference.

The final architecture prioritizes TypeScript performance and a developer experience that aligns closely with the traditional Angular Router, while retaining the powerful parent-data inference that was a core goal.

### API Overview

The API uses a `createRoute` function to define individual, type-safe route segments. These segments are instances of a `RouteBuilder` class, which provides methods for advanced configuration. The routes are then composed into a tree using the standard `children` and `loadChildren` properties. This avoids the performance pitfalls of deep, recursive type inference while still providing strong type guarantees and support for modular code organization.

The core of the global type-safety will be powered by a "flat map" of route paths to their corresponding route objects.

1.  **`createRoute` function**: A factory function that returns an instance of a `RouteBuilder`. It takes the route's configuration, including `path`, `component`, `resolve`, guards, and crucially, `getParentRoute`. The `getParentRoute` property is used by TypeScript to infer the data and parameter types from the parent route, making them available in the current route's resolvers and guards.

2.  **`RouteBuilder` Class**: The object returned by `createRoute`. It contains all the route's properties and provides a `.setResolvers()` method.

3.  **`.setResolvers()` method**: This method allows resolver functions to be attached to a route after its initial definition. This is a key feature for architectural modularity, as it allows resolvers to be defined in separate files from their routes, preventing circular module dependencies.

4.  **`fullPath` property**: Each `RouteBuilder` instance will have a `fullPath` property. This property is not available at creation time but is calculated when the route tree is provided to the router. It provides a type-safe string that can be used for navigation and in `injectRoute`, avoiding "magic strings".

5.  **Standard `children` and `loadChildren`**: The fluent `.addChildren()` method is removed. The `RouteBuilder` instances returned by `createRoute` are composed into a route tree using the familiar `children` and `loadChildren` properties.

6.  **A Global Route Map**: For global type-safety to work, the API requires a flat map of full route paths to their corresponding route objects. This map will be manually defined in non-file-based routing environments.

7.  **Global Type Safety with Declaration Merging**: The API leverages TypeScript's declaration merging via a `Register` interface. This allows you to register your final route map type once, making it available to `injectRouter` and `injectRoute` throughout your application.

> **Note on Route Definition**: For `getParentRoute`'s type inference to work correctly, parent and child routes must be defined as separate constants before being assembled into a tree. Defining a child route inline within a parent's `children` array will cause a TypeScript error, as the compiler cannot resolve the circular type dependency. The `loadChildren` property with a dynamic `import()` is the recommended way to break dependency cycles between route files.

### Runtime Initialization

To support features like `fullPath`, the route tree undergoes an initialization step. When `provideRouter` is called, it traverses the entire route tree, establishes the parent-child relationships, and calls an internal `init()` method on each `RouteBuilder` instance. This `init()` method is responsible for calculating the `fullPath` based on the parent's path. This deferred initialization ensures that all properties are correctly configured before the router starts its first navigation.

### Example of Manual Map Definition

```typescript
// 1. Define routes as standalone constants using createRoute for type safety
const rootRoute = createRootRoute();

export const userRoute = createRoute({
  path: 'user/:userId',
  getParentRoute: () => rootRoute,
  component: UserComponent,
  resolve: {
    user: (route) => ({ id: route.params.userId, name: 'Resolved User' }),
  },
});

export const postsRoute = createRoute({
  path: 'posts/:postId',
  getParentRoute: () => userRoute,
  component: PostsComponent,
  resolve: {
    // `route.data.user` is fully typed here from the parent!
    post: (route) => ({ id: route.params.postId, title: `Post by ${route.data.user.name}` }),
  }
});

// 2. Assemble the final route array for the router provider using standard `children`
export const appRoutes: Route[] = [
  {
    ...userRoute,
    children: [
      postsRoute,
    ]
  }
];

// 3. Create the flat map for type-safety, referencing the route constants
export const routeMap = {
  '/user/:userId': userRoute,
  '/user/:userId/posts/:postId': postsRoute,
} as const;

// 4. Define the global type for the router
export type AppRouteMap = typeof routeMap;

// 5. Use declaration merging to register the type globally
declare module '@angular/router' {
  interface Register {
    routeMap: AppRouteMap;
  }
}

// 6. Now, injection functions are automatically typed
class MyComponent {
  private router = injectRouter();

  navigateToPost() {
    // Path and params are fully typed based on AppRouteMap
    this.router.navigate('/user/:userId/posts/:postId', { userId: '123', postId: '456' });
  }
}
```

This hybrid approach provides a highly performant and scalable solution for type-safe routing, preserving powerful type-inference features while aligning with familiar Angular patterns.

## 3. File-Based Routing (Proposed Design)

Building on the core typed API, file-based routing offers a zero-configuration experience by deriving the route structure from the file system. This design is heavily inspired by TanStack Router's file-based routing, which uses a two-stage process involving a build-time generator and a runtime library.

### Overview: A Two-Stage Process

1.  **Build-Time Generation**: A build tool plugin (e.g., for Vite or Bazel) scans the file system for route files. It analyzes the directory structure and file names to generate a single file (e.g., `routeTree.gen.ts`) that contains both the runtime route tree and the TypeScript types needed for inference.
2.  **Runtime**: The Angular application imports the generated `routeTree` and provides it to the router. The developer experience within route files is fully type-safe, thanks to the generated types.

### 1. The Build-Time Generator

The generator is responsible for:
-   **Scanning:** Watching a designated directory (e.g., `src/app/routes`) for files.
-   **Interpreting Conventions:** Understanding file and folder naming conventions:
    -   `_layout.ts`: Defines a parent layout route for a directory. It does not add a path segment.
    -   `index.ts`: Defines the index route for a directory (e.g., `/posts/index.ts` becomes `/posts`).
    -   `:param.ts`: Defines a dynamic route parameter (e.g., `posts/:postId.ts`).
-   **Generating Code:** Creating a file that contains two key pieces:
    1.  **The Runtime Route Tree:** Imports all user-defined `FileRoute` objects and assembles them into a tree structure by explicitly linking them with the `getParentRoute` property.
    2.  **The Type Map (`FileRoutesByPath`):** Generates a `declare module` block that merges with the `@angular/router` module. This block defines the `FileRoutesByPath` interface, which acts as a "type phone book," mapping a route's full path string to the *type* of its parent route.

### 2. The User's Role: Defining Route Files

The developer defines routes by creating files in the routes directory. Each file exports a `Route` constant created with the `createFileRoute` factory function.

```typescript
// src/app/routes/posts/:postId.ts
import { createFileRoute } from '@angular/router';
import { PostsService } from '../posts.service';

export const Route = createFileRoute('/posts/:postId')({
  resolve: {
    // `params` is fully typed here as { postId: string }
    // because TypeScript has recursively looked up its parent's params.
    post: (route) => inject(PostsService).getPost(route.params.postId),
  },
  component: PostComponent,
});
```
The string `'/posts/:postId'` is the crucial key. It allows TypeScript to look up this route's entry in the generated `FileRoutesByPath` interface.

### 3. How Type Inference Works: The `FileRoutesByPath` Interface

The magic of parent-aware type inference comes from TypeScript's ability to perform recursive type lookups using the generated `FileRoutesByPath` interface.

1.  **The Generated "Phone Book"**: The build tool generates this interface, which only contains type pointers, not final computed types.
    ```typescript
    // In routeTree.gen.ts (simplified)
    declare module '@angular/router' {
      interface FileRoutesByPath {
        '/posts/:postId': {
          parentRoute: typeof import('./routes/posts/_layout').Route
        },
        '/posts': { // from _layout.ts
          parentRoute: typeof import('./routes/__root').Route
        }
      }
    }
    ```
2.  **The `createFileRoute` Call**: When the developer calls `createFileRoute('/posts/:postId')`, TypeScript uses that key to look into the global `FileRoutesByPath` interface.
3.  **Recursive Type Lookup**: TypeScript finds the `parentRoute` type pointer (`typeof import('./routes/posts/_layout').Route`). It then "jumps" to that file, analyzes its type, and finds *its* parent. This process repeats until the root is reached.
4.  **Type Aggregation**: As TypeScript walks up the tree, it collects all the `params` and `data` types from each parent, making the aggregated types available to the child route's configuration.

### Example Workflow

**1. File Structure:**
```
src/app/routes/
├── __root.ts         # Defines the root layout, component, etc.
└── posts/
    ├── _layout.ts    # Parent route for /posts
    └── :postId.ts    # Child route: /posts/:postId
```

**2. User-Defined Route Files:**
```typescript
// src/app/routes/__root.ts
import { createRootRoute, Outlet } from '@angular/router';

export const Route = createRootRoute({
  component: () => `<h1>Root Layout</h1><router-outlet />`,
});
```
```typescript
// src/app/routes/posts/_layout.ts
import { createFileRoute, Outlet } from '@angular/router';

export const Route = createFileRoute('/posts')({
  // This path corresponds to the directory structure
  component: () => `<h2>Posts Layout</h2><router-outlet />`,
});
```
```typescript
// src/app/routes/posts/:postId.ts
import { createFileRoute } from '@angular/router';

export const Route = createFileRoute('/posts/:postId')({
  // `route.params.postId` is a typed string here!
  resolve: { post: (route) => ({ id: route.params.postId }) },
  component: PostComponent,
});
```

**3. Generated `routeTree.gen.ts` (by the build tool):**
```typescript
// This file is generated and should not be edited manually.

import { Route as rootRoute } from './routes/__root'
import { Route as PostsLayoutImport } from './routes/posts/_layout'
import { Route as PostsPostIdImport } from './routes/posts/:postId'

const PostsLayoutRoute = PostsLayoutImport.update({
  path: '/posts',
  getParentRoute: () => rootRoute,
} as any)

const PostsPostIdRoute = PostsPostIdImport.update({
  path: '/:postId',
  getParentRoute: () => PostsLayoutRoute,
} as any)

export const routeTree = rootRoute.addChildren([
  PostsLayoutRoute.addChildren([PostsPostIdRoute]),
])

// The generated type map that powers the type inference
declare module '@angular/router' {
  interface FileRoutesByPath {
    '/posts': {
      parentRoute: typeof rootRoute
    },
    '/posts/:postId': {
      parentRoute: typeof PostsLayoutImport
    }
  }
}
```
This two-stage system provides a powerful, type-safe, and configuration-free routing experience.

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
