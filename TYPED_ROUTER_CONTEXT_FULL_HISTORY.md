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
- **Initial Idea:** A `defineRoutes` function that infers types from a standard `children` array, and a new `ActivatedRoute` class.
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
- **Learning & Refinement:** The object returned by `defineRoutes` must be directly usable by the router's provider functions. This led to an attempt to make the `Route` type compatible with the existing `Route` type.

### Critique 5 & 6: Type Compatibility vs. Clean API
- **Critique:** Attempts to make `Route` directly compatible with `Route` led to complex and brittle type errors. Forcing users to cast the result of `defineRoutes` to `any` to make it work with `provideRouter` is a terrible developer experience.
- **Learning & Refinement (Final Architecture):**
    - It's better to have a **new, parallel, and explicit API** for this feature.
    - A new `provideRouter` function should be the entry point. This function's sole purpose is to accept the strongly-typed configuration from `defineRoutes` and provide it to the router. It can handle the necessary type casting internally, hidden from the user.
    - The router's core logic (`validateConfig` and `recognize`) must be updated to natively understand the new `Route` shape, particularly the `load` property. This is the most robust solution, as it integrates the feature directly into the router's runtime pipeline rather than relying on a pre-transformation step.

## 3. Testing the Implementation
A key part of developing a type-safe API is ensuring that the types are correct. This can be tested using `// @ts-expect-error` comments. This allows you to write tests that assert that a certain piece of code *should* fail to compile. For example, we can test that navigating to a route with a missing parameter will cause a type error.

A powerful pattern for this is to use `injectRoute` within a test component and place the assertions directly in the constructor. This verifies the type safety at the point of use.

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

This is a powerful tool for ensuring that the type-safe API is working as expected and that we don't introduce regressions in the type definitions.

## 4. Final API: A Hybrid Declarative and Fluent Approach

The final architectural pivot was to an API that combines a declarative configuration object with a class-based, fluent builder. This design, initiated by a `createRoute` factory function, provides an ergonomic and type-safe experience that elegantly solves the type inference challenges of previous designs.

### `createRoute`, `.lazy`, and `.addChildren`

The new API is centered around a `RouteBuilder` class, which is instantiated by the `createRoute` function.

1.  **`createRoute` function:** This is the public entry point. It takes the route's configuration as a single object literal, including its `path`, `getParentRoute`, `data`, `resolve`, `canActivate`, `canActivateChild`, and `component`. It returns an instance of the internal `RouteBuilder` class.

2.  **`RouteBuilder` Class:** This class holds the route's configuration and provides fluent methods for adding properties that could not be reliably type-inferred inside the initial object literal, such as lazy-loaded modules and children.

3.  **`.lazy()` method:** This method allows for defining the lazy-loaded parts of the route. It takes a loader function that returns a `Promise` for an object containing the `component` and an optional `resolve` object.

4.  **`.addChildren()` method:** This method takes an array of child `RouteBuilder` instances, allowing for a fully fluent and composable definition of the route hierarchy. A key learning here was the use of a `<const TNewChildren>` generic. This signals to TypeScript to treat the input as a read-only tuple, preventing the compiler from hitting a "type instantiation is excessively deep" error on large, complex route trees.

This hybrid API provides the best of all worlds: a clean, declarative entry point for most properties, and a composable, fluent structure for hierarchical and lazy-loaded routes.

```typescript
// Eager route with inline, type-safe resolvers and guards
const userRoute = createRoute({
  getParentRoute: () => userRoute, // Must be defined before resolve/canActivate
  path: 'user/:userId',
  resolve: {
    user: (route) => { /* route is typed with parent info */ }
  },
  canActivate: [(route) => { /* route is also typed */ }]
});

// Lazy-loaded route with children
const postsRoute = createRoute({ path: 'posts/:postId', getParentRoute: () => userRoute })
  .lazy(() => import('./posts.component').then(m => ({
    component: m.PostsComponent,
    resolve: {
      data: (route) => { /* route is typed */ }
    }
  })))
  .addChildren([
    // ... child routes
  ]);
```

### Accessing Typed Route Data with `injectRoute`

To complete the modern, ergonomic feel of the API, the primary way to access route data in a component is now through the `injectRoute` function.

-   **`injectRoute(path: string)`:** This injection function takes the route's full path string (e.g., `/user/:userId`) and returns a `ActivatedRoute` instance.
-   **`ActivatedRoute`:** This is a signal-based wrapper around the standard `ActivatedRoute`. It exposes `params`, `data`, `queryParams`, etc., as signals, which are fully typed based on the route definition matching the path you pass to the injection function.

This eliminates the need for manual casting of `ActivatedRoute.snapshot` and encourages a more reactive, signal-based approach to component design. A `fullPath` property was also added to the route instances themselves, allowing for safer injection and navigation calls like `injectRoute(userRoute.fullPath)` or `router.navigate(userRoute.fullPath, { ... })`, which avoids the use of magic strings.

```typescript
@Component({
  template: `
    User ID: {{ route.params().userId }}
    User Name: {{ route.data().user.name }}
  `
})
class UserComponent {
  // The route is fully typed and signal-based, with no casting needed.
  route = injectRoute('/user/:userId');
}
```

## 13. Refining the API: The Challenge and Triumph of Type-Safe Guards

The final stage of the API design involved a significant challenge: providing type-safety for guards (`canActivate`, `canDeactivate`) and resolvers.

### The Challenge of Inline Guards

An attempt was made to allow `canActivate`, `canDeactivate`, and `resolve` to be defined directly within the `createRoute` configuration object. This approach initially failed due to a fundamental limitation in TypeScript's type inference. The compiler was unable to infer the types for the guard and resolver function parameters (e.g., `route.params`) based on other properties (`path`) within the same object literal. This resulted in the parameters being typed as `unknown` or `{}`, defeating the goal of type safety.

### Exploring a Fluent API

To work around this limitation, a fluent API was developed with methods like `.addCanActivate()` and `.setResolvers()`. By adding these methods to the `RouteBuilder`, the type inference problem was solved. The builder instance already had the necessary type information (like path parameters and parent data) captured in its generic signature *before* the guard methods were called. This allowed TypeScript to correctly and reliably infer the types for the function parameters.

### Final Solution: A Return to the Declarative API

While the fluent API for guards and resolvers worked, it was less declarative than desired. The ideal API would allow all of a route's properties to be defined together in a single object.

After further experimentation, a breakthrough was made in the TypeScript typings for `createRoute`. By carefully structuring the generic constraints and inference, it became possible to achieve what was initially thought to be impossible: **strongly-typed inline guards and resolvers**. A key discovery was that the **order of properties** in the configuration object mattered. By requiring `getParentRoute` to be defined first, followed by `data`, then `resolve`, and finally `canActivate`, `canActivateChild`, or `canDeactivate`, TypeScript could gather enough contextual information to correctly type the function signatures. The parent provides inherited data, the route's own `data` adds to that, and the `resolve` functions can access both, all of which contributes to the final data shape available in the guards.

This provides the most ergonomic and readable API, fulfilling the original design goals without the need for extra fluent methods for these properties.

### Ergonomic Improvement: Global Types with Declaration Merging

A final refinement was the introduction of a `Register` interface to leverage TypeScript's declaration merging. This allows an application to define its `Router` and route tree types once, making them globally available to injection functions like `injectRouter` and `injectRoute`. This removes the need to constantly pass generic parameters and provides a seamless, "it just works" experience for developers consuming the typed router in their components.

### Architectural Note: Type-Safe Cross-Route References (e.g., `redirectTo`)

During development, an attempt was made to make the `redirectTo` property type-safe, ensuring it could only point to valid paths within the application. This revealed a classic type-level circular dependency problem: a route definition needs to be validated against the full route tree, but the full route tree is not yet fully defined.

This is a problem that libraries like TanStack Router solve with a "global blueprint" pattern. Their equivalent of `createRoute` includes a generic parameter (`TRegister`) that defaults to looking up the final, complete route tree type from the globally registered interface. This allows a single route definition to have type-safe access to the entire application's routing landscape, enabling features like a fully type-safe `redirect` function.

The Angular implementation ultimately did not adopt this pattern for `redirectTo` for a key architectural reason: in Angular, imperative navigation is considered a runtime concern that is handled via Dependency Injection. Route configuration is primarily for defining static structure. Guards and resolvers can inject the `Router` service to perform complex, type-safe navigation at runtime, after the full route tree has been constructed and provided. Because the Angular router does not have features *within the static configuration object itself* that need imperative, cross-route knowledge, adding the complexity of a `TRegister` generic to `createRoute` was deemed unnecessary. This remains a key philosophical difference from TanStack Router's all-in-one approach to route definitions.

## 12. Enforcing a Single Root Route and Fixing Type Preservation

Further refinement of the API addressed two related issues: enforcing a single root for the route hierarchy and fixing a pre-existing flaw in the fluent API's type preservation.

### Motivation

-   **Single Root Requirement**: The router configuration must be a single tree with one root. The `provideRouter` function was initially typed to accept an array of `Route` objects, which was incorrect and did not align with the router's runtime expectations.
-   **Exposing a Type Preservation Flaw**: The introduction of a special "branded" type for the root route (`RootRoute`) exposed an underlying flaw in the fluent API. Chaining methods like `.addChildren()` did not preserve the specific type of the `RouteBuilder` instance they were called on. While this was always an issue, the strict requirement of `provideRouter` for the `RootRoute` brand made the bug obvious, as the brand was being stripped away after any method call.

### Final Implementation

1.  **`createRootRoute` Function**:
    -   A new `createRootRoute` function was introduced as the exclusive way to define the root of the route hierarchy. It creates a route with an empty path (`''`).

2.  **`RootRoute` Branded Type**:
    -   `createRootRoute` returns a `RootRoute`, which is a "branded" type. This special type ensures that only a route created with `createRootRoute` can be passed to `provideRouter`.

3.  **`provideRouter` Signature Update**:
    -   The signature of `provideRouter` was changed to accept a single `RootRoute` instead of an array of `Route`.

4.  **Fixing Type Preservation**:
    -   The `addChildren` and `lazy` methods on the `RouteBuilder` were updated to return an intersection type including `this` (e.g., `this & RouteBuilder<...>` ). This ensures that the specific type of the instance, including the `RootRoute` brand if present, is preserved across chained method calls. This fixed the underlying type preservation flaw for the entire fluent API, making it more robust.

### Example Usage

This change makes the API more robust and guides the developer to the correct usage pattern.

```typescript
// 1. Create the root route
const rootRoute = createRootRoute();

// 2. Create child routes
const userRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: 'user/:userId',
  // ...
});

// 3. Build the hierarchy
const appRoutes = rootRoute.addChildren([userRoute]);

// 4. Provide the single, branded root route
bootstrapApplication(AppComponent, {
  providers: [provideRouter(appRoutes)],
});
```

### Key Files Modified

*   **`packages/router/src/typed_router.ts`**: Refactored to implement the `RouteBuilder` class and the `createRoute` factory function.
*   **`packages/router/src/index.ts`**: Updated to export all the new public symbols.
*   **`packages/router/BUILD.bazel`**: Added a dependency on `//packages/core/rxjs-interop`.
*   **`packages/router/src/recognize.ts`**: Modified to handle the `load` property attached by the `.lazy()` method.
*   **`packages/router/src/utils/config.ts`**: Modified to allow the `load` property.
*   **`packages/router/test/typed_router_spec.ts`**: Refactored all tests to use the new API.

## 9. Runtime Behavior and `paramsInheritanceStrategy`

Even with the correct types, the tests were still failing at runtime. The root cause was the Angular Router's default `paramsInheritanceStrategy`, which is `'emptyOnly'`. This meant that child routes with their own paths (like `'posts/:postId'`) were not inheriting the parameters from their parents (`'user/:userId'`).

The solution was to ensure that the `paramsInheritanceStrategy` is always set to `'always'` when using the typed router. This was accomplished by making it a default, internal configuration within the `provideRouter` function. This guarantees that the runtime behavior of the router matches the expectations of the type system, ensuring that parent parameters and data are always available to child routes.

### Testing `RouterTestingHarness` with Child Routes

A final learning came from debugging the tests themselves. When using `RouterTestingHarness` to test a navigation to a child route, `harness.routeDebugElement` points to the component in the *root* outlet, not the activated child component. To get the correct `ActivatedRouteSnapshot` for the child, it's necessary to query the harness's fixture for the specific child component's `DebugElement` and then retrieve the `ActivatedRoute` from its injector.

## 10. Final Implementation and Testing Learnings

This section documents the key learnings from the final implementation and testing phase, which were critical for creating a robust and verifiable feature.

### 1. Updating Router Internals for the `load` Property

The introduction of the `load` property required modifications to the router's core validation and recognition logic:

-   **`validateConfig` (`packages/router/src/utils/config.ts`):** The router's configuration validation function, `validateNode`, was updated to recognize `load` as a valid property on a route. This prevents the router from throwing an `NG04014: Invalid configuration of route` error. Additionally, new validation rules were added to ensure `load` is not used in combination with other conflicting properties like `component`, `loadComponent`, `children`, `loadChildren`, or `redirectTo`.

-   **`recognize` (`packages/router/src/recognize.ts`):** The `matchSegmentAgainstRoute` function within the `Recognizer` class was modified to handle the `load` property. Before matching the route, the function now checks for a `load` function, `await`s its `Promise`, and merges the resolved properties (like `component` and `resolve`) into the route object. This ensures that the lazy-loaded properties are available when the `ActivatedRouteSnapshot` is created.

### 2. Overcoming TypeScript Limitations in Tests

A significant challenge in testing the `load` property was a classic TypeScript circular dependency issue. When defining a lazy-loaded route, attempting to type the `resolve` function's `route` parameter using `typeof lazyRoute` created a circular reference:

```typescript
// This causes a compilation error
const lazyRoute = createRoute({
  path: 'user/:userId',
  load: () => Promise.resolve({
    resolve: (route: SnapshotFromRoute<typeof lazyRoute>) => ({ /* ... */ }),
  }),
});
```

The compiler cannot resolve the type of `lazyRoute` while it is still being defined. The workaround for testing this was to break the circular dependency by manually providing the type for the `route` parameter:

```typescript
// Workaround for the test
const lazyRoute = createRoute({
  path: 'user/:userId',
  load: () => Promise.resolve({
    resolve: (route: ActivatedRouteSnapshot<{userId: string}, {}>) => ({ /* ... */ }),
  }),
});
```

This confirmed that the `createRoute` function signature was correct and that the issue was a limitation of TypeScript's inference within a single declaration, not a flaw in the API design.

### 3. Ensuring Test Stability with `whenStable`

Several tests, particularly those involving the initial navigation performed by `RouterTestingHarness.create()`, were failing with `TypeError: Cannot read properties of undefined (reading 'params')`. The root cause was a timing issue: the component's template was attempting to access `route.snapshot` before the navigation had completed and the snapshot was populated.

The solution was to `await` the fixture's `whenStable()` promise immediately after creating the harness:

```typescript
it('should infer params from path', async () => {
  // ... component and route setup
  const harness = await RouterTestingHarness.create('/user/123');
  
  // CRITICAL: Wait for navigation to complete
  await harness.fixture.whenStable();
  
  // Now it's safe to make assertions
  expect(harness.fixture.nativeElement.innerHTML).toContain('userId: 123');
});
```

This ensures that all asynchronous operations, including the navigation and subsequent change detection, have finished before the test proceeds to its assertions, leading to stable and reliable tests.

## 11. Introducing `injectRoute` and Signal-based APIs

To further improve the developer experience and align with modern Angular practices, a signal-based, strongly-typed API for accessing route information was introduced.

### Motivation

The existing methods for accessing typed route data, while functional, had some ergonomic drawbacks:
-   Injecting the standard `ActivatedRoute` and then casting the `snapshot` to a `SnapshotFromRoute` is verbose.
-   It primarily encourages usage of the snapshot, while the observable-based properties (`params`, `data`, etc.) are more aligned with reactive programming.

The goal was to create an API that was:
-   **Strongly-typed** out of the box, without manual casting.
-   **Signal-based**, aligning with the direction of the framework.
-   **Ergonomic**, using a simple injection function.

### Final Implementation

1.  **`ActivatedRoute` Class:**
    -   A new class, `ActivatedRoute<TRoute extends Route>`, was created to act as a strongly-typed wrapper around the standard `ActivatedRoute`.
    -   It takes the `ActivatedRoute` in its constructor.
    -   It uses `toSignal` from `@angular/core/rxjs-interop` to convert the observable properties (`params`, `data`, `queryParams`, `fragment`, etc.) into signals.
    -   Crucially, the `params` and `data` signals are strongly typed based on the `TRoute` generic passed to the class.
    -   It requires an `initialValue` to be passed to `toSignal` to ensure the signal has a non-nullable type from the start.

2.  **`injectRoute` Function:**
    -   A new injection function, `injectRoute(path: string)`, was introduced as the public API.
    -   It injects the standard `ActivatedRoute`.
    -   It instantiates the `ActivatedRoute` wrapper.
    -   **Memoization:** To ensure that the same wrapper instance is returned for the same `ActivatedRoute` instance, the wrapper is cached on the `ActivatedRoute` instance itself using a private property (`_typedRoute`). This prevents re-computation and ensures that signals are not recreated unnecessarily.

3.  **Build Configuration:**
    -   A key learning from the implementation was the necessity of updating the build configuration. The `rxjs-interop` package is a separate entry point, so `//packages/core/rxjs-interop` had to be added as a dependency in the `packages/router/BUILD.bazel` file to make `toSignal` available.

### Example Usage

This new API results in a much cleaner and more modern developer experience in components:

```typescript
@Component({
  template: `
    User ID: {{ route.params().userId }}
    User Name: {{ route.data().user.name }}
  `
})
class UserComponent {
  // The route is fully typed and signal-based, with no casting needed.
  route = injectRoute('/user/:userId');
}
```