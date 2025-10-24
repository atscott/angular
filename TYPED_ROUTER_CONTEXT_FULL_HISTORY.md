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

### Critique 2 & 3: Lazy Loading and Preserving the Route Shape

A major architectural challenge was supporting lazy loading without breaking the entire type-safety model. For the API to provide a complete list of valid paths (i.e., for `AllPaths<TRouteTree>` to work), the type system must be able to see the **entire shape of the route tree** at compile time.

The traditional `loadChildren` property is fundamentally incompatible with this requirement. It hides an entire subtree of routes behind a `Promise`. TypeScript cannot look inside the `import('./feature.routes')` to discover the paths, parameters, and parent-child relationships within, rendering the global "map" of the route tree incomplete.

The solution was to introduce a new mechanism that **separates a route's "shape" from its "implementation"**:

-   **Shape (Eager):** The properties needed by the type system, primarily `path` and the parent-child relationship established by `getParentRoute` and `.addChildren()`. This information is always defined eagerly.
-   **Implementation (Lazy):** The properties that contain the actual application logic, such as `component`, `resolve`, and `canActivate`. This is the code that should be deferred to a separate chunk.

This led to the creation of the `.lazy()` method (which configures a `load` property internally). This method allows the route's *shape* to be part of the initial route tree definition, while the function passed to it returns a `Promise` for the *implementation*.

This design perfectly solves two problems:
1.  It keeps the full route tree shape intact and visible to TypeScript, preserving the integrity of `AllPaths<TRouteTree>`.
2.  It ensures that when the lazy implementation *is* loaded, the router's `recognize` pipeline can `await` it and execute the functions (like resolvers and guards) within the correct Angular injection context, allowing `inject()` to work as expected.

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

### The `addChildren` Method: Enabling Modularity and Type Safety

A deliberate design choice in the API is the exclusion of a `children` property from the `createRoute` function in favor of the `.addChildren()` method. This solves two fundamental problems: one of type inference, and one of application architecture.

1.  **Stable References for Type Inference:** For a child route to be correctly typed, its `getParentRoute` function must return a stable, known type. If routes were defined as object literals inside a `children` array, there would be no way to get a variable reference to the parent to pass to the child. Separating route creation (`const userRoute = createRoute(...)`) from assembly (`rootRoute.addChildren([userRoute])`) ensures that stable, referenceable instances exist.

2.  **Avoiding Circular Module Dependencies:** This is the most critical architectural reason. In a large application, it's common to co-locate routes with their feature modules. This naturally leads to a file structure where parent and child routes are in different files.

    Consider a scenario where an inline `children` property exists:

    ```typescript
    // user.routes.ts
    import { postsRoute } from './posts.routes'; // <-- Import child
    export const userRoute = createRoute({
      path: 'user/:userId',
      getParentRoute: () => rootRoute,
      children: [postsRoute], // <-- Problem is here
    });

    // posts.routes.ts
    import { userRoute } from './user.routes'; // <-- Import parent
    export const postsRoute = createRoute({
      path: 'posts/:postId',
      getParentRoute: () => userRoute, // <-- Needs parent reference
    });
    ```
    This creates a **circular dependency** (`user.routes.ts` -> `posts.routes.ts` -> `user.routes.ts`), which will cause module resolution to fail in JavaScript.

    The `.addChildren()` method solves this by separating definition from assembly. The assembly is moved to a third file that sits higher in the dependency graph:

    ```typescript
    // user.routes.ts
    export const userRoute = createRoute({ /* ... */ });

    // posts.routes.ts
    import { userRoute } from './user.routes';
    export const postsRoute = createRoute({ getParentRoute: () => userRoute, /* ... */ });

    // app.routes.ts (or another assembly file)
    import { userRoute } from './user.routes';
    import { postsRoute } from './posts.routes';
    // No circular dependency. This file imports from both and assembles them.
    export const appRoutes = rootRoute.addChildren([
      userRoute.addChildren([postsRoute])
    ]);
    ```

This pattern is fundamental to creating a scalable and maintainable routing configuration in a modular application.

### Alternative Considered: Inline Children with Type-Only Imports

An alternative architecture was seriously considered that would allow for inline `children` arrays, more closely mimicking the traditional Angular router's configuration. This approach would rely on TypeScript's `import type` feature combined with a type assertion to break the circular module dependency issue while still preserving the type inference chain.

The pattern would look like this:

```typescript
// user.routes.ts
import { postsRoute } from './posts.routes';
export const userRoute = createRoute({
  path: 'user/:userId',
  children: [postsRoute], // <-- Children are now inline
});

// posts.routes.ts
// CRUCIALLY, this is a type-only import to break the cycle
import type { userRoute } from './user.routes';

export const postsRoute = createRoute({
  path: 'posts/:postId',
  // This "trick" passes the parent's TYPE without needing its VALUE.
  getParentRoute: () => null! as typeof userRoute,
  resolve: {
    // This would be correctly typed because `createRoute` can infer the
    // parent's params and data from the return TYPE of getParentRoute.
    post: (route) => ({ title: `Post for user ${route.params.userId}` }),
  }
});
```

This approach is powerful and solves the core problems: `children` are inline, and type inference for resolvers and guards still works. However, it was ultimately rejected for two key reasons:

1.  **Poor Developer Experience:** The `getParentRoute: () => null! as typeof userRoute` syntax is a non-obvious "trick." It forces developers to understand and use a TypeScript-specific hack to make the API work. It's not intuitive and makes the `getParentRoute` property's purpose misleading (it's only for types at creation time, not for getting the runtime value).

2.  **Increased Implementation Complexity:** This pattern would require a more complex, two-stage initialization process. The `init()` method could no longer rely on calling `getParentRoute()` to get the parent instance. Instead, the parent-child relationship would have to be established manually by a tree-traversal process after all routes are defined (e.g., the `userRoute` would need to find its `postsRoute` child in its `children` array and set a `.parent` property on it). This makes the system more implicit and harder to reason about and debug.

The final decision was to favor the **explicitness and simplicity of the current design**. The `getParentRoute: () => userRoute` and `.addChildren()` pattern ensures that the parent-child link is a first-class, runtime concept that is easy to understand. It leads to simpler initialization logic and straightforward type inference without requiring any special tricks, at the acceptable cost of not having an inline `children` property.

### Accessing Typed Route Data with `injectRoute`

To complete the modern, ergonomic feel of the API, the primary way to access route data in a component is now through the `injectRoute` function.

-   **`injectRoute(path: string)`:** This injection function takes the route's full path string (e.g., `/user/:userId`) and returns a `ActivatedRoute` instance.
-   **`ActivatedRoute`:** This is a signal-based wrapper around the standard `ActivatedRoute`. It exposes `params`, `data`, `queryParams`, etc., as signals, which are fully typed based on the route definition matching the path you pass to the injection function.

This eliminates the need for manual casting of `ActivatedRoute.snapshot` and encourages a more reactive, signal-based approach to component design. A `fullPath` property was also added to the route instances themselves, allowing for safer injection and navigation calls like `injectRoute(userRoute.fullPath)` or `router.navigate(userRoute.fullPath, { ... })`, which avoids the use of ## Future Direction: Type-Safe Relative Navigation

A powerful enhancement planned for the typed router is the introduction of type-safe relative navigation, a feature inspired by the ergonomics of libraries like TanStack Router. This would allow developers to make navigation calls relative to a known route, which is a more intuitive and less error-prone pattern for component-level navigation.

### The Core Concept: The "From" Context

The key to this feature is establishing a **"from" context** for a navigation call. By telling the `navigate` function where the navigation is originating *from*, the type system can:

1.  **Validate Relative Paths:** Correctly infer and type-check relative paths like `'./edit'`, `'../'`, and `'../sibling'`.
2.  **Infer Contextual Parameters:** Understand which parameters are already present in the URL and only require the developer to provide params for the new segments of the path.
3.  **Provide Typed Updaters:** Strongly type the `prev` value in functional updaters for `queryParams`.

### Proposed Implementation Plan

The design follows a pattern that is both powerful and idiomatic for Angular's architecture.

#### 1. A Conditional `NavigateOptions` Type

The core of the feature will be a single, sophisticated `NavigateOptions` type that uses conditional typing to change its requirements based on whether a `from` property (a `fullPath` string) is provided. This allows a single `navigate` function to have two distinct, type-safe behaviors.

#### 2. An Overloaded Global `router.navigate()`

The main `Router` service's `.navigate()` method will be overloaded to accept this new `NavigateOptions` object. This makes the full power of the API available from anywhere the global router can be injected, such as in application services.

#### 3. An Overloaded, Hook-Like `injectNavigate()` Function

To provide the best ergonomics within components, a new `injectNavigate()` function will be created with two signatures:

-   `injectNavigate()`: When called with no arguments, it will return the global `navigate` function, which is powerful but requires the `from` property to be passed manually for relative navigation.
-   `injectNavigate({ from: someRoute.fullPath })`: When called with a `from` property (which is a `fullPath` string), it will return a *new* navigation function that has the "from" context **baked in**. All subsequent calls to this function will be implicitly relative to the route corresponding to that path, making them extremely concise and readable.

This complete design provides a layered API that is flexible enough for complex service-level logic while being highly ergonomic for the common case of component-based navigation.

## Architectural Boundary: Dynamic `canMatch` Guards and Static Typing

A key architectural decision and limitation of the typed router lies in its interaction with the `canMatch` guard. This feature highlights the fundamental trade-off between a fully dynamic runtime and a predictable, statically typed API.

### The Conflict: A Static Map vs. A Dynamic Runtime

The entire type-safety model is built on the ability to create a single, static, and unambiguous "map" of the entire route tree at compile time. The `fullPath` of a route acts as a unique primary key in this map, allowing utility types like `AllPaths<T>` to know every possible valid URL.

The `canMatch` guard allows developers to create multiple route configurations that respond to the exact same path, with the final choice being made at runtime. If these configurations have different child routes, they create an ambiguity that the static type system cannot resolve.

Consider this unsupported pattern:

```typescript
// This breaks the typed router's assumptions
const adminRoute = createRoute({
  path: 'admin',
  canMatch: [isAdminGuard],
  children: [{ path: 'dashboard', component: AdminDashboardComponent }],
});

const userFallbackRoute = createRoute({
  path: 'admin', // <-- Same path
  canMatch: [isNotAdminGuard],
  children: [{ path: 'profile', component: UserProfileComponent }], // <-- Different children
});

const routerTree = rootRoute.addChildren([adminRoute, userFallbackRoute]);
```

At compile time, TypeScript sees that the path `/admin` can lead to either a `dashboard` child or a `profile` child. It has no way of knowing which is correct, so it cannot provide accurate type safety for navigation to `/admin/dashboard` or for `injectRoute` within those child components. The uniqueness of the `fullPath` key is violated.

### Recommended Solutions

This is a deliberate limitation, and the following patterns are the architecturally sound solutions.

#### 1. The "Single Shape" Pattern (Recommended)

The best practice is to ensure that all routes sharing a path also share the **same static shape** (i.e., the same children). The dynamic logic should be confined to the guard itself.

```typescript
const adminChildren = [
  createRoute({ path: 'dashboard', component: AdminDashboardComponent }),
];

// The "real" admin route
const adminRoute = createRoute({
  path: 'admin',
  canMatch: [isAdminGuard],
}).addChildren(adminChildren);

// The fallback route has the SAME path and SAME children
const adminFallbackRoute = createRoute({
  path: 'admin',
  canMatch: [isNotAdminGuard],
  // The guard will run and redirect, so this component is just a placeholder.
  // Crucially, the child routes are identical to the real route's children.
  redirectTo: '/login',
}).addChildren(adminChildren);
```

In this pattern, the static map of the application is consistent and unambiguous. The type system knows that `/admin/dashboard` is a valid path. The `isNotAdminGuard` is responsible for the runtime logic of preventing access by redirecting away *before* the component is ever rendered.

#### 2. The "Escape Hatch" Pattern

If a scenario absolutely requires different route shapes for the same path, that part of the configuration must opt out of the typed router. The API was designed to make this graceful. The `.addChildren()` method accepts an array containing both typed `Route` instances (from `createRoute`) and traditional, untyped `Route` objects from `@angular/router`.

This allows a developer to mix and match, preserving type safety for the vast majority of their application while seamlessly opting out for specific, highly dynamic branches. The type system will simply ignore the untyped routes when generating the global map of valid paths.

**Implementation Note:** A subtle but critical part of this feature was updating the recursive `AllRouteInfos` utility type. The initial implementation only changed the signature of `.addChildren()`. This caused type inference to fail because the recursive step would receive an array containing both typed and untyped routes. The solution was to make the recursion more robust by filtering the children array before the recursive call: `AllRouteInfos<Extract<TChildren[number], Route>, ...>`. This ensures that only the typed routes are processed when building the static map, preserving the integrity of the type system.

```typescript
import { Route } from '@angular/router'; // Untyped
import { createRoute, createRootRoute } from '...'; // Typed

const typedSibling = createRoute({ path: 'sibling', ... });
const untypedAmbiguousRoutes: Route[] = [
  { path: 'admin', canMatch: [isAdminGuard], children: [...] },
  { path: 'admin', canMatch: [isNotAdminGuard], children: [...] },
];

// Mix and match directly in the `addChildren` call
const typedRoutes = rootRoute.addChildren([
  ...untypedAmbiguousRoutes,
  typedSibling,
]);
```

This preserves type safety for all other branches of the application, but any navigation to or injection within the `/admin` section will fall back to being untyped.

## Architectural Refinement: Deferred Initialization for Advanced Scenarios

A final architectural refinement was made to the internal implementation of the `RouteBuilder` class to make it more robust and future-proof.

### Motivation

The initial implementation calculated parent-dependent properties, like `fullPath`, directly in the constructor. This works for a top-down, eagerly-defined route tree, but it is too rigid for more advanced scenarios. For example, in a file-based routing system, route modules might be discovered and composed in an order where a child route is instantiated before its parent is fully configured.

### Solution: The `init()` Method

Inspired by a similar pattern in TanStack Router, the logic for calculating parent-dependent properties was moved from the constructor to a separate, deferred `init()` method.

-   The `constructor` is now only responsible for setting the route's own, self-contained properties.
-   The new `init()` method is responsible for getting the parent via `getParentRoute()`, setting the internal `.parent` reference, and calculating the `fullPath`.
-   The `.addChildren()` method was updated to be the orchestrator of this initialization. When children are added to a parent, the parent calls the `init()` method on each child, ensuring the properties are calculated in the correct order. The `createRootRoute` function is responsible for calling `init()` on the root of the tree.

This change makes the route construction process more flexible without changing the public API. It ensures that the Angular implementation is architecturally sound and capable of supporting future enhancements like file-based routing.

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

### Refining the API for Modularity: The `.setResolvers()` Method

While the inline `resolve` property provided a great developer experience for simple cases, it was soon discovered that it had the same architectural limitation as inline `children`: it created circular module dependencies when resolvers were defined in separate files. A resolver in `user.resolvers.ts` would need to import the `userRoute`'s type, while the `user.routes.ts` file would need to import the resolver's value, creating a cycle.

To solve this, a fluent method for attaching resolvers was reintroduced. An initial attempt with `.addResolvers()` (which would merge with inline resolvers) proved to be too complex for TypeScript's inference engine, causing "Type instantiation is excessively deep" errors.

The final, robust solution was to implement `.setResolvers()`. This method has a simpler type signature that *replaces* any inline resolvers. This avoids the compiler complexity while still providing a clean, non-circular pattern for composing routes and their logic from separate files:

1.  **Define the base route** with its path and parent.
2.  **Define the resolvers** in a separate file, which can safely import the base route's type.
3.  **Combine them** by calling `.setResolvers()` on the base route.

This hybrid approach offers the best of both worlds: the simplicity of inline resolvers for co-located logic, and the architectural robustness of a fluent `.setResolvers()` method for decoupled, modular code.

### Ergonomic Improvement: Global Types with Declaration Merging

A final refinement was the introduction of a `Register` interface to leverage TypeScript's declaration merging. This allows an application to define its `Router` and route tree types once, making them globally available to injection functions like `injectRouter` and `injectRoute`. This removes the need to constantly pass generic parameters and provides a seamless, "it just works" experience for developers consuming the typed router in their components.

### Architectural Challenge: Type-Safe Cross-Route References (e.g., `redirectTo`)

A highly desirable goal for the typed router is to make all properties that reference other routes, like `redirectTo`, fully type-safe. This would prevent a common class of runtime errors where a redirect points to a path that no longer exists.

However, implementing this feature presents a classic type-level circular dependency problem. For a `redirectTo` property within a `createRoute` call to be validated, the function needs access to the complete type of the *entire route tree*. But the route tree's type is not fully known until all the `createRoute` calls that constitute it have been resolved.

The likely solution to this is the "global blueprint" pattern, used by libraries like TanStack Router. It involves adding a generic parameter (`TRegister` or `TRouteTree`) to `createRoute` that defaults to looking up the final, complete route tree type from the globally registered `Register` interface. This would allow a single route definition to have type-safe access to the entire application's routing landscape, breaking the circular dependency.

Initial attempts were made to implement this pattern. While promising, they introduced significant complexity and ultimately failed to work robustly in all scenarios, particularly within the test suite where the circular references became difficult to manage without cumbersome workarounds.

Given these challenges, the decision was made to **defer the implementation of type-safe `redirectTo`**. It remains a desirable enhancement for the future if a more robust and ergonomic solution can be found, but it is not part of the current API. The current implementation prioritizes stability and a clean, understandable type inference model.

### Design for Testability: The `AnyRoute` Fallback

A key requirement for a new API is that it must be easily testable. Forcing users to construct and register a complete, application-wide route tree in every single unit test would be prohibitively verbose.

To solve this, the core utility types (`AllPaths`, `ParamsForPath`, `RouteForPath`) were designed with a conditional "escape hatch." The goal was to make the API permissive *only* when no specific route tree was provided (i.e., when the `TRouteTree` generic defaulted to `AnyRoute`).

The implementation of this feature was subtle. An initial attempt used the conditional type `TRouteTree extends AnyRoute`. This turned out to be incorrect because a specific, fully-typed route tree *also* extends `AnyRoute`, making the condition always true and rendering the entire API permissive. This broke the strict type-checking in the test suite.

The correct solution was to flip the condition to `AnyRoute extends TRouteTree`. This condition is only true when `TRouteTree` is *exactly* `AnyRoute` or `unknown`, which is the case when the generic defaults because no type was provided via declaration merging. When a specific `RouterTree` type is provided, the condition is false, and the strict types are used.

This design choice has two major benefits:

1.  **Simplified Unit Testing:** In a test, a developer can provide a minimal router setup. The injected `Router` will be correctly typed as `Router<AnyRoute>`, allowing calls like `router.navigate('/any/path', { foo: 'bar' })` without compile-time errors.
2.  **Gradual Migration:** This provides a path for gradually adopting the typed router. Parts of an application can use the fully-typed router while others can interact with an untyped or partially-typed instance, paving the way for a potential future merge of the typed and untyped router APIs.

This fallback behavior is a crucial part of the developer experience, ensuring that the benefits of type safety in application code do not come at the cost of cumbersome and brittle tests.

## Architectural Refinement: Deferred Initialization for Advanced Scenarios

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

## 12. Refining Relative Navigation and Parameter Typing

Further implementation and testing revealed several subtle but important areas for refinement in the API's type safety and runtime behavior, particularly around relative navigation and parameter handling.

### Correcting Relative Path Resolution (`../` and `./`)

The initial implementation of relative navigation contained flaws in both its runtime logic and its type definitions that led to incorrect and unintuitive behavior.

-   **`../` Resolution:** The `resolvePath` function incorrectly treated the `from` path like a file-system path, causing it to ascend two levels (from the parent directory) instead of one URL segment. The `ResolveRelativePath` type mirrored this incorrect logic. This was fixed by removing the faulty logic from `resolvePath` so that it correctly treats the path as a URL, and updating the corresponding types to match. Now, navigating from `/user/123` with `to: '../posts/456'` correctly resolves to `/posts/456`.

-   **`./` Resolution:** The `ResolveCurrentPath` type was incorrectly adding a trailing slash to paths resolved with `'./'`. This created a type mismatch, as route paths are not defined with trailing slashes. The type was corrected to resolve `'./'` to the `from` path without modification.

### Implementing Functional `params` for Relative Navigation

To improve the ergonomics of updating parameters during relative navigation, a feature inspired by TanStack Router was implemented. The `params` option in `router.navigate()` now accepts a function.

This function receives the previous route's parameters as its argument, allowing developers to easily create the new parameters based on the previous state.

```typescript
// Navigate from /user/123
router.navigate({
  from: '/user/:userId',
  to: './',
  // The `prev` object is strongly typed to { userId: string }
  params: (prev) => ({
    userId: `${prev.userId}-updated`,
  }),
});
// This will navigate to /user/123-updated
```

This was achieved by overloading the `navigate` method and its corresponding types. The implementation retrieves the current `ActivatedRouteSnapshot` to access the existing parameters and passes them to the updater function, providing a powerful and type-safe pattern for state transitions.
## Architectural Pivot: Embracing a Flat-Map Approach for Performance and Ergonomics

Despite the robust, type-inferred API developed, further research and analysis of the broader ecosystem revealed a critical potential issue: TypeScript performance. Libraries like TanStack Router, which initially used a similar deep, programmatic, and composable API, encountered significant performance bottlenecks as route trees grew in size and complexity. The recursive nature of the type inference would lead to the compiler error "Type instantiation is excessively deep and possibly infinite."

Their solution, and the one adopted by file-based routing frameworks like Nuxt and Remix, was to pivot to a model where a build-time process generates a "flat map" of the application's routes. This generated artifact provides a complete, non-recursive type definition of all possible paths, which is highly performant for TypeScript to process.

This insight led to a strategic pivot in the Angular Typed Router's design to preemptively solve this performance issue and, as a major benefit, align the API more closely with the traditional, familiar Angular Router configuration.

### The New Direction: A Hybrid of Inference and Explicit Composition

The core of this pivot is to blend the powerful type-inference of the initial design with the performance and familiarity of the traditional Angular Router API. The fluent, composable API (`.addChildren()`, `.lazy()`) is removed, but the `createRoute` function is retained in a simplified form.

1.  **Simplified `createRoute` for Type Inference**: A `createRoute` function remains the key to defining a type-safe route. Its primary responsibility is to use its `getParentRoute` property to infer the parameter and data shapes from the parent, making them available to the current route's resolvers and guards.

2.  **Familiar `children`/`loadChildren` for Composition**: The objects returned by `createRoute` are composed into a final route tree using the standard `children` and `loadChildren` properties. This aligns the API with existing Angular patterns and uses the well-established dynamic `import()` of `loadChildren` to break circular dependencies between route files in modular applications.

3.  **Explicit Flat Map for Global Type Safety**: The source of truth for global type-safety (powering `injectRouter` and `injectRoute`) is an explicit, flat object that maps full path strings to their corresponding `createRoute`-defined route objects. This avoids deep, recursive type inference and guarantees performance.

4.  **Manual Definition as a Fallback**: In the absence of a file-based routing system that would generate this map automatically, developers are responsible for creating and maintaining this map manually.

### Trade-offs and Benefits

-   **Benefit - Performance**: This architecture guarantees high performance for TypeScript, regardless of the size of the application.
-   **Benefit - Ergonomics & Familiarity**: The API for composing routes is nearly identical to the one Angular developers already know.
-   **Benefit - Powerful Type Inference**: The core feature of inferring parent data and params is retained, providing a superior developer experience for writing resolvers and guards.
-   **Trade-off - Manual Work**: For applications not using a future file-based routing system, there is the added manual step of defining the route map.

This hybrid approach is a pragmatic decision that delivers the best of both worlds: the powerful, context-aware type-safety of the initial design and the performance, scalability, and familiarity of the traditional router API.
## Course Correction: Reinstating Modularity and Ergonomics

An incorrect refactoring step was made that removed two critical features from the API: the `.setResolvers()` method and the `fullPath` property on route objects. This was a mistake that deviated from the agreed-upon hybrid architecture. This section documents the correction.

### The Mistake

In the process of removing the fluent composition API (`.addChildren()`, `.lazy()`), the `.setResolvers()` method was also removed. This was incorrect, as `.setResolvers()` is not about composition, but about **modularity**. It is the key to breaking circular dependencies when a route's definition and its resolver functions live in separate files.

Simultaneously, the `fullPath` property was removed from the route objects. This was also a mistake, as this property is a crucial ergonomic feature that allows for type-safe navigation (`router.navigate(myRoute.fullPath, ...)` and route injection (`injectRoute(myRoute.fullPath)`) without using brittle "magic strings".

### The Correction

The architecture has been corrected to reintroduce these features, solidifying the hybrid model:

1.  **`RouteBuilder` Class**: The `createRoute` function now returns an instance of a `RouteBuilder` class (an internal detail). This class holds the route's configuration.

2.  **`.setResolvers()` Reinstated**: The `RouteBuilder` class has a `.setResolvers()` method, restoring the ability to define resolvers in separate files and attach them to a route in a type-safe way.

3.  **`fullPath` and Deferred Initialization**: The `RouteBuilder` instance has a `fullPath` property. To make this work with the standard `children` array, a deferred initialization process is used. When `provideRouter` is called, it traverses the user-provided route tree, finds all `RouteBuilder` instances, and calls an internal `init()` method on each one. This method uses the `getParentRoute()` function to find its parent and recursively build the full, absolute path.

This correction ensures the final API is not only performant and familiar, but also fully supports the critical real-world requirements of modular code organization and ergonomic, type-safe navigation.

### A Note on TypeScript Inference and Route Composition

A key learning during the refinement of the hybrid API was a practical limitation of TypeScript's type inference. The `getParentRoute` feature relies on a child route being able to access the fully-inferred type of its parent at definition time.

This leads to a specific constraint on how route trees are composed: **routes must be defined as separate constants before they are assembled in a `children` array.**

Attempting to define a child route inline inside its parent's `children` array will result in a compiler error: `"implicitly has type 'any' because it does not have a type annotation and is referenced directly or indirectly in its own initializer"`. This happens because TypeScript tries to resolve the type of the entire inline configuration at once, creating a circular dependency: the parent's type depends on the child's type, but the child's `getParentRoute` function refers back to the parent, whose type is not yet finalized.

Separating definition from composition solves this cleanly:

```typescript
// 1. Define parent. Its type is fully inferred here.
const parentRoute = createRoute({ ... });

// 2. Define child. It can now safely access the stable type of `parentRoute`.
const childRoute = createRoute({ getParentRoute: () => parentRoute, ... });

// 3. Assemble the tree.
const appRoutes = [{ ...parentRoute, children: [childRoute] }];
```

This pattern is a fundamental requirement for using the typed router and ensures the type inference engine works reliably.

