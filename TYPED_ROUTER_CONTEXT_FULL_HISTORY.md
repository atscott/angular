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
A key part of developing a type-safe API is ensuring that the types are correct. This can be tested using `// @ts-expect-error` comments. This allows you to write tests that assert that a certain piece of code *should* fail to compile. For example, we can test that navigating to a route with a missing parameter will cause a type error.

A powerful pattern for this is to use `injectTypedRoute` within a test component and place the assertions directly in the constructor. This verifies the type safety at the point of use.

```typescript
// In a component used for testing
const userRoute = createRoute({ path: 'user/:userId', component: UserComponent });

@Component({ template: `...` })
class UserComponent {
  route = injectTypedRoute(userRoute);

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

## 4. Final API: A Class-based Fluent Approach

The final architectural pivot was to a class-based, fluent API. This design, initiated by a `createRoute` factory function, provides the most ergonomic and type-safe experience, elegantly solving the type inference challenges of previous designs.

### `createRoute`, `addResolvers`, `.lazy`, and `addChildren`

The new API is centered around a `TypedRouteBuilder` class, which is instantiated by the `createRoute` function.

1.  **`createRoute` function:** This is the public entry point. It takes the route's "shape" (`path`, `getParentRoute`, `data`) and returns an instance of the internal `TypedRouteBuilder` class.

2.  **`TypedRouteBuilder` Class:** This class holds the route's configuration and provides the fluent methods. Because it's a class instance, TypeScript can easily carry the generic type information from one method call to the next.

3.  **`.addResolvers()` method:** This method on the `TypedRouteBuilder` instance accepts an object of individual resolver functions. Because the parent's type information is already part of the class's generic signature, the `route` parameter for each resolver function can be correctly and strongly typed. This solves the "look inside the object" problem that plagued the single-object-literal approach.

4.  **`.lazy()` method:** This method allows for defining the lazy-loaded parts of the route. It takes a loader function that returns a `Promise` for an object containing the `component` and an optional `resolve` object (which can also contain multiple individual resolvers).

5.  **`.addChildren()` method:** This method takes an array of child `TypedRouteBuilder` instances or an object map of child route builders, allowing for a fully fluent and composable definition of the route hierarchy.

This API provides the best of all worlds: a clean entry point, a composable and extensible structure, and a solution to the complex type inference problem that allows for the use of the traditional `resolve` object.

```typescript
// Eager route with individual, type-safe resolvers
const userRoute = createRoute({ path: 'user/:userId' })
  .addResolvers({
    user: (route) => { /* route is typed with parent info */ }
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

### Accessing Typed Route Data with `injectTypedRoute`

To complete the modern, ergonomic feel of the API, the primary way to access route data in a component is now through the `injectTypedRoute` function.

-   **`injectTypedRoute(route: TRoute)`:** This injection function takes the route definition object and returns a `TypedActivatedRoute` instance.
-   **`TypedActivatedRoute`:** This is a signal-based wrapper around the standard `ActivatedRoute`. It exposes `params`, `data`, `queryParams`, etc., as signals, which are fully typed based on the route definition you pass to the injection function.

This eliminates the need for manual casting of `ActivatedRoute.snapshot` and encourages a more reactive, signal-based approach to component design.

```typescript
@Component({
  template: `
    User ID: {{ route.params().userId }}
    User Name: {{ route.data().user.name }}
  `
})
class UserComponent {
  // The route is fully typed and signal-based, with no casting needed.
  route = injectTypedRoute(userRoute);
}
```

### Key Files Modified

*   **`packages/router/src/typed_router.ts`**: Refactored to implement the `TypedRouteBuilder` class and the `createRoute` factory function, and remove the standalone `addChildren` function.
*   **`packages/router/src/index.ts`**: Updated to export all the new public symbols and remove the `addChildren` export.
*   **`packages/router/BUILD.bazel`**: Added a dependency on `//packages/core/rxjs-interop`.
*   **`packages/router/src/recognize.ts`**: Modified to handle the `load` property attached by the `.lazy()` method.
*   **`packages/router/src/utils/config.ts`**: Modified to allow the `load` property.
*   **`packages/router/test/typed_router_spec.ts`**: Refactored all tests to use the new fluent API.

## 9. Runtime Behavior and `paramsInheritanceStrategy`

Even with the correct types, the tests were still failing at runtime. The root cause was the Angular Router's default `paramsInheritanceStrategy`, which is `'emptyOnly'`. This meant that child routes with their own paths (like `'posts/:postId'`) were not inheriting the parameters from their parents (`'user/:userId'`).

The solution was to ensure that the `paramsInheritanceStrategy` is always set to `'always'` when using the typed router. This was accomplished by making it a default, internal configuration within the `provideTypedRouter` function. This guarantees that the runtime behavior of the router matches the expectations of the type system, ensuring that parent parameters and data are always available to child routes.

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
const lazyRoute = createTypedRoute({
  path: 'user/:userId',
  load: () => Promise.resolve({
    resolve: (route: SnapshotFromTypedRoute<typeof lazyRoute>) => ({ /* ... */ }),
  }),
});
```

The compiler cannot resolve the type of `lazyRoute` while it is still being defined. The workaround for testing this was to break the circular dependency by manually providing the type for the `route` parameter:

```typescript
// Workaround for the test
const lazyRoute = createTypedRoute({
  path: 'user/:userId',
  load: () => Promise.resolve({
    resolve: (route: TypedActivatedRouteSnapshot<{userId: string}, {}>) => ({ /* ... */ }),
  }),
});
```

This confirmed that the `createTypedRoute` function signature was correct and that the issue was a limitation of TypeScript's inference within a single declaration, not a flaw in the API design.

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

## 11. Introducing `injectTypedRoute` and Signal-based APIs

To further improve the developer experience and align with modern Angular practices, a signal-based, strongly-typed API for accessing route information was introduced.

### Motivation

The existing methods for accessing typed route data, while functional, had some ergonomic drawbacks:
-   Injecting the standard `ActivatedRoute` and then casting the `snapshot` to a `SnapshotFromTypedRoute` is verbose.
-   It primarily encourages usage of the snapshot, while the observable-based properties (`params`, `data`, etc.) are more aligned with reactive programming.

The goal was to create an API that was:
-   **Strongly-typed** out of the box, without manual casting.
-   **Signal-based**, aligning with the direction of the framework.
-   **Ergonomic**, using a simple injection function.

### Final Implementation

1.  **`TypedActivatedRoute` Class:**
    -   A new class, `TypedActivatedRoute<TRoute extends TypedRoute>`, was created to act as a strongly-typed wrapper around the standard `ActivatedRoute`.
    -   It takes the `ActivatedRoute` in its constructor.
    -   It uses `toSignal` from `@angular/core/rxjs-interop` to convert the observable properties (`params`, `data`, `queryParams`, `fragment`, etc.) into signals.
    -   Crucially, the `params` and `data` signals are strongly typed based on the `TRoute` generic passed to the class.
    -   It requires an `initialValue` to be passed to `toSignal` to ensure the signal has a non-nullable type from the start.

2.  **`injectTypedRoute` Function:**
    -   A new injection function, `injectTypedRoute(route: TRoute)`, was introduced as the public API.
    -   It injects the standard `ActivatedRoute`.
    -   It instantiates the `TypedActivatedRoute` wrapper.
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
  route = injectTypedRoute(userRoute);
}
```