# Learnings from Type-Safe Router API Design Conversation

This document summarizes the key learnings, design evolution, and final architectural decisions made during the conversation about implementing a type-safe routing API for the Angular Router. The primary inspiration for this work is [TanStack Router](https://tanstack.com/router/), which has popularized fully type-safe routing in the React ecosystem. The goal is to bring a similar level of type-safety and developer experience to Angular's router.

## 1. Initial Goal

The primary objective is to create a fully type-safe routing experience in Angular, where:
- Route paths and their parameters are statically known.
- Navigation calls are type-checked to ensure correct parameters are provided for a given route. This includes not only the path and its parameters, but also query parameters and hash fragments.
- `ActivatedRoute` provides type-safe access to parameters and resolved data.
- The developer experience remains familiar to Angular users, particularly the hierarchical route configuration.

## 2. Evolution of the API Design

The design evolved significantly based on a series of critiques and refinements.

### Initial Proposal & Critique 1: Nested Children and Route Referencing
- **Initial Idea:** A `defineRoutes` function that infers types from a standard `children` array, and a new `TypedActivatedRoute` class.
- **Critique:** Skepticism about whether TypeScript could handle nested `children` arrays for type inference, and how developers would reference deeply nested routes for navigation without a cumbersome syntax.
- **Learning & Refinement:**
    - Confirmed that modern TypeScript (with `as const` and recursive conditional types) **can** handle nested `children` arrays, preserving the familiar configuration shape.
    - The `defineRoutes` function should return a map-like object (e.g., `result.paths['/full/path']`) to provide a simple, string-based way to reference any route in the tree for type-safe navigation.

### Critique 2 & 3: Lazy Loading Guards and Resolvers
- **Critique:** The initial proposal did not account for lazy loading. `loadChildren` would break type inference. Furthermore, even if the route tree was static, the guards and resolvers themselves could not be eagerly loaded as that would defeat the purpose of code-splitting.
- **Initial Idea:** Use dynamic `import()` inside the guard/resolver function definitions.
- **Critique:** This approach is flawed because the dynamic `import()` executes outside of the Angular injection context, meaning `inject()` would not work inside the lazy-loaded guard/resolver.
- **Learning & Refinement (Major Pivot):** The router's core logic must be responsible for lazy loading. The best approach is to introduce a new property on the route configuration (e.g., `load`) that points to a file containing the route's *implementation* (its component, guards, resolvers, etc.). The router's `recognize` pipeline would then be responsible for awaiting this `import()` and running the functions within the correct injection context.

### Critique 4: The "Two Sources of Truth" Problem
- **Critique:** The design required defining routes in a `defineRoutes` call for type-safety, but then passing a separate, standard configuration to `RouterModule.forRoot` or `provideRouter`. This duplication is poor developer experience.
- **Learning & Refinement:** The object returned by `defineRoutes` must be directly usable by the router's provider functions. This led to an attempt to make the `TypedRoute` type compatible with the existing `Route` type.

### Critique 5 & 6: Type Compatibility vs. Clean API
- **Critique:** Attempts to make `TypedRoute` directly compatible with `Route` led to complex and brittle type errors. Forcing users to cast the result of `defineRoutes` to `any` to make it work with `provideRouter` is a terrible developer experience.
- **Learning & Refinement (Final Architecture):**
    - It's better to have a **new, parallel, and explicit API** for this feature.
    - A new `provideTypedRouter` function should be the entry point. This function's sole purpose is to accept the strongly-typed configuration from `defineRoutes` and provide it to the router. It can handle the necessary type casting internally, hidden from the user.
    - The router's core logic (`validateConfig` and `recognize`) must be updated to natively understand the new `TypedRoute` shape, particularly the `load` property. This is the most robust solution, as it integrates the feature directly into the router's runtime pipeline rather than relying on a pre-transformation step.

## 3. Testing the Implementation
A key part of developing a type-safe API is ensuring that the types are correct. This can be tested using `// @ts-expect-error` comments. This allows us to write tests that assert that a certain piece of code *should* fail to compile. For example, we can test that navigating to a route with a missing parameter will cause a type error:

```typescript
// @ts-expect-error: Should error because userId is missing
router.navigate(['/user']);
```

This is a powerful tool for ensuring that the type-safe API is working as expected and that we don't introduce regressions in the type definitions.

## 4. Final Pivot: Eliminating Complexity with an Explicit, Composable API

The final series of attempts revealed that even with advanced conditional types, the deeply nested `children` array approach was fundamentally flawed. The complexity of inferring and propagating parent `params` and `data` down to child resolvers proved to be too much for TypeScript's inference engine, leading to `any` types and a loss of type safety precisely where it was needed most.

This led to the final, and much simpler, architectural pivot.

### Critique 7: The Recursive Inference Problem
- **Critique:** The `defineRoutes` function, while powerful, created a circular and overly complex type inference challenge. A resolver's type depends on its parent's data, but the parent's type is being defined in the same complex, nested object. This created a "chicken-and-egg" problem for the type checker.
- **Learning & Refinement (Final, Simplified Architecture):**
    - **Abandon `defineRoutes` and inline `children`:** The root of the complexity is the single, large, nested object. The solution is to define each route as a standalone, fully-typed entity.
    - **Introduce `createTypedRoute`:** This function defines a *single* route. Its return type contains the full type information for its own `path`, `params`, `data`, and `resolve` signature.
    - **Introduce `addChildren`:** The route hierarchy is built programmatically. An `addChildren(parent, [child1, child2])` function explicitly creates the parent-child relationship. This is less declarative than a nested object, but it makes the type relationships explicit and easy for the compiler to follow.

### New Architectural Principles for Type-Safe Resolvers

To ensure resolvers are correctly typed, the following principles are essential:

1.  **Generic `TypedRoute`:** The core `TypedRoute` interface must be generic. It needs to understand its own parameters (`TParams`), its own static data (`TData`), the shape of its resolved data (`TResolved`), and the combined data from its parent (`TParentData`).

2.  **Parent Data Propagation:** The type system must explicitly carry the parent's data. `TParentData` for a given route should be the combination of the parent's own `TData` and `TResolved`.

3.  **Typed Resolver Function:** The `resolve` functions on a route must receive a `TypedActivatedRouteSnapshot` that is typed with this complete context.
    - The snapshot's `params` will be the union of its own `TParams` and the parent's `TParams`.
    - The snapshot's `data` property will be the union of its own `TData` and the parent's combined data (`TParentData`).
    - **NOTE on Sibling Resolvers:** Due to limitations in TypeScript's type inference for a single object literal, a resolver's `route` parameter **will not** be typed with the resolved data from other resolvers on the same `Route`. This is a deliberate design trade-off to enable the simple `createTypedRoute({...})` API without requiring `any` casts. The data *will* be present at runtime in the order of execution, but is not available in the type signature.

### API Outline

```typescript
// 1. Core route interfaces are generic to carry full type information
export interface TypedRouteBase<
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
  TResolved extends Record<string, unknown>,
  TParentData extends Record<string, unknown>,
> {
  path: string;
  data?: TData;
  resolve?: {
    // The resolver for a specific key (e.g., 'user') gets a snapshot
    // typed with all the contextual information.
    [K in keyof TResolved]: TypedResolveFn<
      TParams,
      TData,
      // The snapshot's `data` should not include the key currently being resolved.
      Omit<TResolved, K>,
      TParentData,
      TResolved[K] // The return type of the resolver
    >;
  };
  // ... other properties like component, canActivate, etc.
}

// 2. The ActivatedRouteSnapshot and ResolveFn are also generic
export type TypedActivatedRouteSnapshot<TParams, TData, TResolved, TParentData> = Omit<
  ActivatedRouteSnapshot,
  'params' | 'data'
> & {
  params: TParams;
  data: TData & TResolved & TParentData;
};

export type TypedResolveFn<TParams, TData, TResolved, TParentData, TRet> = (
  route: TypedActivatedRouteSnapshot<TParams, TData, TResolved, TParentData>,
  state: RouterStateSnapshot,
) => TRet;


// 3. Usage Example:
// Parent route is defined on its own. Its type is self-contained.
const userRoute = createTypedRoute({
  path: 'user/:userId',
  data: { staticParentData: 'value' },
  resolve: {
    user: (route) => {
      return { id: route.params.userId, name: 'Resolved User' };
    }
  }
});

// Child route is defined separately and references the parent for type inference.
const postsRoute = createTypedRoute({
  path: 'posts/:postId',
  getParentRoute: () => userRoute,
  resolve: {
    // This resolver correctly gets parent data in its snapshot type.
    // The type of `route.data.user` would be inferred as `{id: string, name: string}`.
    // The type of `route.data.staticParentData` would be `string`.
    posts: (route) => {
      console.log(route.data.user);
      console.log(route.data.staticParentData);
      return [{ id: '1', title: 'Post 1' }];
    }
  }
});

// The runtime hierarchy is still built explicitly with `addChildren`.
addChildren(userRoute, [postsRoute]);

// The final routes array is passed to the router.
const appRoutes = [userRoute];

// 4. Typed Navigation
// A new `TypedRouter` service is introduced for type-safe navigation.
declare const typedRouter: TypedRouter;

// Correct navigation using the route object and params:
typedRouter.navigateByRoute(postsRoute, {userId: '123', postId: '456'});

// @ts-expect-error: Should error because `userId` is missing
typedRouter.navigateByRoute(postsRoute, {postId: '456'});

// @ts-expect-error: Should error because `postId` is the wrong type
typedRouter.navigateByRoute(postsRoute, {userId: '123', postId: 456});
```

## 5. Providing the Typed Configuration

To make the `TypedRouter` available for injection and to provide the router with the typed configuration, a new provider function is necessary. This function is analogous to the existing `provideRouter`.

```typescript
// in main.ts
import {bootstrapApplication} from '@angular/platform-browser';
import {provideTypedRouter} from '@angular/router'; // hypothetical import

// The final routes array is created using `createTypedRoute` and `addChildren`
const appRoutes = [userRoute];

bootstrapApplication(AppComponent, {
  providers: [
    provideTypedRouter(appRoutes)
  ]
});
```

This `provideTypedRouter` function is responsible for:
1.  Accepting the strongly-typed route configuration.
2.  Providing the standard `Router` services.
3.  Internally, processing the typed configuration and making it available to the `Router` and `TypedRouter` services.
4.  Ensuring that the `TypedRouter` service can be injected and used throughout the application.

This approach keeps the typed API separate and explicit, avoiding the need to modify the existing `provideRouter` and `RouterModule.forRoot` APIs in a breaking way.

## 6. Implementation Learnings & Final Architecture Details

This section summarizes the concrete implementation details and learnings from the development process, which are critical for understanding and extending the feature.

### Core Implementation Points

1.  **`provideTypedRouter` is the Key:** The `provideTypedRouter` function is the correct entry point. Crucially, it must provide the typed route configuration to the existing `ROUTES` injection token (`{provide: ROUTES, useValue: routes, multi: true}`). This is how the standard Angular Router discovers the routes. `TypedRoute` is designed to be runtime-compatible with `Route`.

2.  **Runtime Differentiation with `isTypedRoute`:** To allow the router's internal logic to apply new behaviors only to typed routes, a type guard `isTypedRoute` was created. This function checks for a unique symbol (`typedRouteKey`) that the `createTypedRoute` function adds to every route object. This allows functions like `recognize` and `resolveData` to safely apply typed logic.

3.  **Lazy Loading via `load` Property:**
    *   A new `load` property was added to the `TypedRoute` interface to lazy-load the implementation of the route itself.
    *   **CRITICAL DISTINCTION:** `load` is **not** a typed version of `loadChildren`.
        *   `loadChildren` is used to fetch an array of *child* routes, often from a `NgModule` that provides them.
        *   `load` is used to fetch the `component`, `resolve`, `canActivate`, etc. properties for the *current* route. It **cannot** be used to provide child routes.
    *   The object returned from the `load()` promise **must not** contain a `path` property. The loading happens in `recognize.ts` *after* the path has already been matched.
    *   The loaded object also **must not** contain `children` or `loadChildren` properties. An error will be thrown if they are present.
    *   The `load` function **must not** return a `NgModule` that provides its own `ROUTES` token for child routes. This is the responsibility of `loadChildren`.
    *   The `recognize` function's `matchSegmentAgainstRoute` method was updated to `await` the `load` function directly and merge the resulting properties into the route config before creating the snapshot. It does **not** use the `RouterConfigLoader`.

4.  **Typed Resolvers Implementation:**
    *   The core logic resides in `resolveData` (`packages/router/src/operators/resolve_data.ts`).
    *   When processing resolvers for a typed route, a new `TypedActivatedRouteSnapshot` is created for each resolver.
    *   A helper function, `createTypedSnapshot`, was introduced. Its job is to clone the current `ActivatedRouteSnapshot` and inject the already-resolved data from other resolvers on the same route into the `data` property. This ensures that resolvers that depend on each other receive the correct data.
    *   **Important:** Routes without resolvers must still provide an empty `resolve: {}` object. If `resolve` is `undefined`, the `getDataKeys` utility will throw a `TypeError`, which was a source of test failures.

5.  **`addChildren` is Mandatory for Hierarchy:**
    *   **CRITICAL:** The `TypedRoute` interface intentionally **does not** have a `children` property. This is to avoid the recursive type inference problems that plagued earlier designs.
    *   Route hierarchies **must** be constructed programmatically using the `addChildren(parent, [child1, ...])` function. This makes the parent-child relationships explicit and allows TypeScript's inference to work correctly. Any attempt to add a `children` property directly to a `TypedRoute` object is a deviation from the intended design.

6.  **Accessing Typed Snapshot Data:** Because the `ActivatedRoute` service and `ActivatedRoute.snapshot` property are not generic (to avoid breaking changes), the type information is lost when accessing the router state. To regain type safety in a component or test, you can use the `SnapshotFromTypedRoute` helper type to derive the correct snapshot type from your `TypedRoute` object.

    ```typescript
    // In a component or test
    import { SnapshotFromTypedRoute } from '@angular/router'; // hypothetical import
    
    const userRoute = createTypedRoute({ path: 'user/:userId', /* ... */ });
    const route: ActivatedRoute = inject(ActivatedRoute);

    // Use the helper type to cast the snapshot
    const typedSnapshot = route.snapshot as SnapshotFromTypedRoute<typeof userRoute>;

    // Now access is fully type-safe without manual generics
    console.log(typedSnapshot.params.userId);
    ```

### Testing Strategy and Pitfalls

1.  **Avoid `RouterTestingModule`:** The deprecated `RouterTestingModule` caused significant build and dependency issues. It is tightly coupled to the router's public API in ways that make it unsuitable for testing internal changes.

## 7. Current Implementation Challenge: Advanced Type Inference

The primary unresolved issue lies in the complex type inference required for `createTypedRoute`.

**Goal:** The `createTypedRoute` function should be able to infer the parent's type information from a `getParentRoute` function and use it to provide a strongly-typed `route` parameter to the `resolve` functions, all within a single object literal, without requiring the developer to add any explicit type annotations.

**Current (Failing) Approach:**
The current implementation uses an advanced generic signature with `const TConfig` and an intersection type (`&`) to try and achieve this:

```typescript
export function createTypedRoute<
    const TConfig extends {
        // ... other properties
        resolve?: Record<string, (route: any, state: any) => any>;
    }
>(
    route: TConfig & {
        resolve?: {
            [K in keyof TConfig['resolve']]: (
                route: TypedActivatedRouteSnapshot<...>, // Inferred types here
                state: RouterStateSnapshot
            ) => ReturnType<TConfig['resolve'][K]> // Problem is here
        }
    }
): TypedRoute<...> {
  // ...
}
```

**The Problem:**
This approach creates a circular type inference problem for the TypeScript compiler. The compiler cannot determine the `ReturnType` of a function (`TConfig['resolve'][K]`) at the same time it is trying to define the constraints for that very function.

This results in the following build error:
`TS2344: Type 'TConfig["resolve"][K]' does not satisfy the constraint '(...args: any) => any'.`

**Summary of Difficulty:**
This is a known hard problem in TypeScript. The challenge is to create a single function signature that can "look inside" the object being passed to it, infer types from one property (`getParentRoute`), and use those types to constrain another property (`resolve`) in the same object. The current implementation fails because it also tries to infer the *return type* of the resolver functions as part of this circular process. A successful implementation will need to solve this specific inference challenge, perhaps with a different typing strategy that breaks the circular dependency.

This should be possible. Tanstack Router is able to infer the type of the loader function on a typed route. Study Tanstack Router implementation, which is what we're modeling after.

2.  **Asserting Type Safety in Tests:** A test that only checks runtime values does not validate the type-safety of the API. To properly test the types, use `// @ts-expect-error` to assert that invalid code *fails* to compile.

    ```typescript
    // Example of a proper type-safety test
    it('should provide typed access to params', () => {
      const userRoute = createTypedRoute({
        path: 'user/:userId',
        resolve: {
          user: (route) => {
            // This line should compile without error
            const id: string = route.params.userId;

            // This line SHOULD cause a type error, so we assert that with @ts-expect-error
            // @ts-expect-error: Should error because `wrongParam` does not exist
            const x = route.params.wrongParam;

            return { id };
          },
        },
      });
      // ... rest of test setup
    });
    ```

2.  **Use `RouterTestingHarness`:** The modern `RouterTestingHarness` is the correct tool for testing. It should be configured with `provideTypedRouter(routes)`.

3.  **Treat as a Private API During Development:** When testing, import the typed API directly from its source file (e.g., `import { ... } from '../src/typed_router'`). Do not attempt to add it to the public API (`public_api.ts`) until it is stable, as this can create circular dependency build errors with the `testing` package.

4.  **Update Router Validation:** The router's internal `validateConfig` function (`packages/router/src/utils/config.ts`) must be updated to recognize the new `load` property. Without this, any route using `load` will fail validation and throw an `NG04014: Invalid configuration of route` error.

### Key Files Modified

*   **`packages/router/src/typed_router.ts`**: New file containing the core API (`createTypedRoute`, `TypedRoute`, `provideTypedRouter`, etc.).
*   **`packages/router/src/recognize.ts`**: Modified `getChildConfig` to handle the `load` property.
*   **`packages/router/src/operators/resolve_data.ts`**: Modified `resolveNode` to handle typed resolvers and pass partially resolved data.
*   **`packages/router/src/utils/config.ts`**: Modified `validateNode` to allow the `load` property on typed routes.
*   **`packages/router/src/router_config_loader.ts`**: Added the `loadAndExtractRoutes` method.
*   **`packages/router/test/typed_router_spec.ts`**: New, self-contained test file for the feature.
