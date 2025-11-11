# Design Document: Modern Reactive Angular Router

## 1\. Objective

Implement a modern data loading strategy for the Angular Router that defaults to parallel, non-blocking, and reactive data fetching, while explicitly supporting legacy sequential patterns (waterfalls) where necessary as opt-in prerequisites. This design aims to improve user experience through faster navigations and provide a more powerful and ergonomic API for data fetching.

## 2\. Core Concepts & Glossary

- Prerequisite Phase: The existing sequential phase containing Guards and standard Resolvers. This phase runs before the Main Loading Phase and must complete successfully for navigation to proceed.
- Main Loading Phase (NEW): The new parallel phase where all matched resources functions execute simultaneously. This phase is designed for optimal performance by concurrently fetching data.
- Loader: A function defined in the route configuration that executes during the Main Loading Phase. It returns an object where each key maps to a `RouterResource`.
- Match Injector: An ephemeral EnvironmentInjector created for each matched route segment. It is responsible for hosting resources execution and anchoring resource lifecycles, providing proper cleanup.
- Transactional Navigation: A mechanism for staging the next route state in background injectors to prevent UI tearing, then atomically swapping to the new state upon successful commit. This ensures a consistent user interface during navigation.
- RouterResource: An internal, transaction-aware primitive that wraps developer-provided data fetching logic, managing its state (pending, resolved, error) and lifecycle in sync with the router's transactional navigation.

## 3\. Proposed Architecture

### 3.1. Two-Phase Data Execution

The router introduces a clear two-phase data execution model to balance backward compatibility with modern, parallel data loading.  
Phase 1: Prerequisite Phase (Sequential)  
This phase is identical to the existing router behavior:

1. Guards: CanDeactivate, CanActivate, CanActivateChild, CanLoad guards run sequentially.
2. Legacy Resolvers: Standard resolve functions execute sequentially, blocking navigation until their promises resolve.

If any guard or resolver fails or redirects, the navigation is cancelled at this stage. Data from legacy resolvers is made available to subsequent resourcess via ResourceContext.resolvedData.  
Phase 2: Main Loading Phase (Parallel & Reactive)  
This is the new phase where resources functions are executed:

1. Parallel Execution: All resources functions for the matched route segments execute concurrently.
2. Transactional Staging: Data fetching initiated by resourcess (especially reactive resources) begins in a "pending" or "staged" state, isolated from the currently active UI.
3. Blocking & Deferred Data: The router distinguishes between blocking data (explicitly marked via `routerResource.blocking`) and deferred data (standard `routerResource`). Navigation proceeds only after all blocking data resolves.
4. Atomic Commit: Once all blocking data is ready, the new route state is atomically committed, and the UI updates.

### 3.2. Injector Hierarchy (Hybrid Model)

To facilitate efficient resource management and maintain compatibility, a hybrid injector model is adopted:

- Route Config Injector (Legacy): This injector is long-lived, created once per route configuration. It hosts services intended for reuse across multiple navigations and remains the home for legacy resolvers.
- Match Injector (NEW): This is an ephemeral EnvironmentInjector created dynamically whenever a URL segment successfully matches.
  - Lifecycle: Created on URL match, destroyed when the segment no longer matches (unless preserved by a RouteReuseStrategy).
  - Responsibility: The Match Injector is the execution context for resources() functions. It anchors the lifecycle of resources created by resourcess, providing DestroyRef and AbortSignal for proper cleanup. This isolation prevents memory leaks and ensures resources are correctly managed for each matched segment.

### 3.3. Data Loading Patterns: Deferred vs. Blocking

Resources explicitly support both deferred (non-blocking) and blocking data fetching. The default is deferred to ensure fast initial UI rendering.  
Pattern 1: Deferred Data (Non-Blocking \- Default)  
By default, data returned from a loader is deferred. The router does not wait for it to resolve before completing the navigation. This allows components to render instantly with placeholders or loading indicators, populating the view as data becomes available.

```ts
resources: (ctx) => {
  return {
    // DEFERRED: Router will NOT wait for this resource.
    feed: routerResource(...)
  }
}
```

Pattern 2: Blocking Data (Opt-In)  
There is one explicit mechanism to make data blocking, forcing the router to wait before navigation completes:

- `resource.blocking`: Signals the router to wait for the resource's initial status to be 'resolved' or 'error' before navigation completes. If the resource's loader rejects and its status becomes 'error', the entire navigation is cancelled.

```
import { routerResource } from '@angular/router';

resources: (ctx) => {
  return {
    // BLOCKING: Router waits for this resource's first emission.
    user: routerResource.blocking({
       params: () => ctx.params().id,
       loader: ({params: id}) => fetch(`/api/users/${id}`).then(res => res.json())
    }),
  }
}
```

-

## 4\. API Design

### 4.1. The resources Function

A new optional property on the Route definition, resources, enables the modern, parallel data loading phase.

```ts
interface Route {
  resources?: (ctx: ResourceContext) => ResourceResult | Promise<ResourceResult>;
}

type ResourceResult = {
  [key: string]: RouterResource<any, any>;
};
```

Behavior of

- `routerResource(...)`: Deferred. The component receives the resource in its initial state.
- `routerResource.blocking(...)`: Blocking. The router waits for the resource's first emission to resolve or error.

If the resources function itself is async, the router will await its completion, making any awaited promises within it blocking.

### 4.2. The ResourceContext

The ResourceContext object is passed to the resources function, providing access to essential data and utilities for data fetching:

```ts
interface ResourceContext {
  // REACTIVE PARAMS (Primary input for resources)
  // These signals are transactional and will trigger updates in reactive primitives.
  params: Signal<Params>;
  queryParams: Signal<Params>;
  fragment: Signal<string | null>;

  // PRE-LOADED DATA (Available immediately from Prerequisite Phase)
  data: Signal<Record<string, any>>;  // From the `data` property on the route config and legacy `resolve` functions
}
```

**Injection Context**: The `resources` function executes within the **Match Injector's** injection context. You can use `inject()` directly within the function to access services or `DestroyRef`.

## 5\. Detailed Mechanics

### 5.1. Transactional Navigation Pipeline

To ensure UI consistency and atomic state updates, the router's navigation pipeline is enhanced with transactional state management:

1. recognize: Identifies matched routes and determines which ActivatedRoute instances are new versus reused.
2. Prerequisite Phase:
   - Guards: CanDeactivate, CanActivate, CanActivateChild, CanLoad execute.
   - Resolve: Legacy resolve functions execute. Navigation cancels on failure or redirect.
3. createRouterState: Constructs the RouterStateSnapshot and the ActivatedRoute instances for the upcoming navigation.
4. (NEW \- Staging):

- For new ActivatedRoute instances, a MatchInjector is created, and the resources() function is executed once. The ResourceResult is stored on the pending snapshot.
- For reused ActivatedRoute instances, the resources() function is not re-run. Instead, the router calls an internal `_setPending()` method on the ActivatedRoute instance. This updates internal proxy signals (e.g., paramsSignal) with the new route parameters, triggering reactive resources within the previously established resources graph to refetch data.

5.  (NEW \- Wait Phase): The router inspects the ResourceResult for all pending snapshots. It pauses navigation until all items explicitly marked as blocking (via `resource.blocking` for resources, or `await` within async resourcess for promises) have resolved or errored. If any blocking resource transitions to an 'error' state, the promise rejection is thrown into the navigation pipeline, cancelling the navigation and triggering the standard router error handling (e.g., emitting a `NavigationError` event). Deferred data fetching continues in the background. Errors in non-blocking resourcess do not cancel the navigation. Instead, the resource will be in an error state and the component is responsible for handling it.
6.  (Commit Phase \- Atomic Swap):

- Old MatchInjectors are destroyed (cleaning up previous resources).
- The candidate MatchInjectors are promoted to active status.
- Each affected ActivatedRoute instance's internal `pending` signal is set to `false`. This atomically transitions the route to the committed state and synchronizes with the public BehaviorSubjects (e.g., ActivatedRoute.params). This unfreezes the `RouterResource` instances, making the new state public.
- The public ActivatedRoute.data signal proxy is updated to reflect the new data. The component view updates instantly with critical data and any deferred data that has since resolved.

7. Navigation Cancellation (Rollback Phase): If navigation is cancelled at any point after `setupAndRunResources`, the router calls `_rollback()` on all pending `ActivatedRoute` instances. This discards the pending state and prevents UI tearing. The rollback behavior differs depending on whether the route was new or reused:
   - **Reused Routes**: For routes that were already active and are being reused, their `RouterResource` instances are reverted to their last successfully committed state. This is efficient and prevents re-fetching data that is already available.
   - **New Routes**: A critical race condition exists for new routes. A resource may be created, and its `loadEffect` scheduled, but the navigation can be cancelled _before_ the `effect` has a chance to run. To prevent the resources from executing for a cancelled navigation, the resource must be destroyed. During rollback, if an `ActivatedRoute` has not yet been committed (i.e., `resourcesData` is not yet assigned), the router will find the pending resources on the `_futureSnapshot` and call `_rollback()` on them, which destroys them. This reliably cancels any scheduled effects and ensures no memory leaks or unwanted data fetches occur.

### 5.2. Integration with RouteReuseStrategy

- Persistence: resources functions do NOT re-run when a route is reattached. Resources created by the resources remain alive within the preserved Match Injector.
- Reactivity: Resources established by a resources in a reused route automatically react to changes in ResourceContext.params and ResourceContext.queryParams when the route's pending state is updated (\_setPending). This allows them to refetch relevant data.
- **Manual Cleanup**: When a `RouteReuseStrategy` decides to discard a detached route handle, it **must** use the `destroyDetachedRouteHandle(handle)` helper. This ensures that the associated `MatchInjector` and all its resources are correctly destroyed.

### 5.3. Consuming Loader Data in Components

A new API on ActivatedRoute is introduced for consuming reactive resources data, while maintaining compatibility with existing APIs.

- (Unchanged): This legacy API continues to provide data. For any blocking() resourcess, their final, resolved value will be merged into this data object.
- (NEW): This is the primary API for accessing the live, transactional RouterResource instances returned by resourcess. Components can use this property to react to the resource's status (pending, resolved, error) and access its value(). Note that `resources` itself is a plain object and not a signal. The reactivity is contained within the `RouterResource` instances themselves.

```ts
// Example Component
const route = inject(ActivatedRoute);
const userResource = route.resources?.['user'];
const user = computed(() => userResource()?.value()); // Access the resolved user value
```

Note on non-blocking resourcess: Errors thrown in non-blocking resourcess will not cause the navigation to fail. Instead, the `RouterResource` will be in an `error` state, and the component is responsible for handling it. This allows for a more granular error handling strategy, where a single failed resource does not disrupt the entire navigation.

### 5.4. Imperative Reloading

Since components have direct references to the RouterResource instances via ActivatedRoute.resources, RouterResource can expose a public .reload() method. This allows developers to imperatively trigger a refetch of a specific resource's data from within a component, independent of navigation events.

## 6\. API Ergonomics & Internals

### 6.1. The routerResource() Helper

To improve discoverability, type safety, and internal encapsulation, a routerResource() helper function is provided.

```ts
import { routerResource } from '@angular/router';

// ... inside a resources
return {
  user: routerResource({
    params: computed(() => ctx.params().id), // Reactive input to the loader
    loader: ({params: id, abortSignal}) => fetch(`/api/user/${id}`, {signal: abortSignal}).then(res => res.json()) // Data fetching logic
  })
};
```

This helper:

1. Discoverability: Clearly signals the creation of a reactive resource.
2. Type Safety: Uses generics (routerResource\<TRequest, TValue\>) to ensure the request signal's value correctly types the input to the loader function.
3. Encapsulation: Hides the internal implementation details of the resource from the developer.

The `params` property is also optional. When it is omitted, the `loader` function does not receive an input value. This is useful for resources that do not depend on route parameters but may benefit from other resource features like manual reloading.

### 6.2. `RouterResource` as a Transaction-Aware Wrapper

The internal `RouterResource` class acts as a transaction-aware wrapper for the resources's return values. Its primary responsibility is to integrate with the router's `_commit` and `_rollback` lifecycle methods to prevent UI tearing. It extends `BaseWritableResource<T>` to ensure it fully complies with the `WritableResource<T>` interface.

The key feature of `RouterResource` is its **router-driven synchronization** strategy, which decouples the router's transaction from the resource's asynchronous loading.

1.  **State Separation:** The resource maintains a strict separation between its internal, kernel state (which updates as data loads) and the public-facing signals (`stream`, `status`, `error`, `value`) which represent the last **committed** state.
2.  **Router-Driven Synchronization:** State is synchronized from the internal state to the public signals _reactively_ based on the `pending` signal provided by the `ActivatedRoute`.

This separation is the critical feature that prevents the UI tearing effect, where a pending navigation's loading state is prematurely reflected in the UI.

#### Transactional Integrity: Reactivity via `pending` Signal

To manage its state across navigations, the `RouterResource` relies on a `pending` signal provided by the `ActivatedRoute`. This signal indicates whether the route is currently involved in an active, uncommitted navigation.

- **`pending` Signal:** When `true`, the resource enters a "frozen" state where its public signals (`stream`, `status`, `error`, `value`) continue to return the last committed values, while the internal kernel processes the new request.
- **Reactivity:** The resource's internal state (`kernel.state`) updates reactively as the loader runs. The public signals are computed to switch between the frozen committed state (when `pending` is true) and the live kernel state (when `pending` is false).

#### Transactional Lifecycle

The `Router` orchestrates the state of the `RouterResource` by updating the `pending` signal on the `ActivatedRoute`.

- **Start Navigation:** When a navigation begins that reuses a route, the router sets the `ActivatedRoute.pending` signal to `true`. This freezes the public output of all resources on that route.
- **Commit:** At the end of a successful navigation, the router sets `pending` to `false`. This atomically unfreezes the resources, causing their public signals to update to the new resolved state.
- **Rollback:** If the navigation is cancelled, the router reverts the `ActivatedRoute`'s parameters to their previous values and then sets `pending` to `false`. The `RouterResource` automatically handles this via its snapshotting mechanism (see below), restoring the previous state without unnecessary re-fetching.

#### Snapshotting and Rollback Optimization

To optimize rollbacks and prevent unnecessary re-fetching of data that was just committed, `RouterResource` implements a snapshotting mechanism.

1.  **`lastCommittedState` Signal**: The resource maintains a `lastCommittedState` signal that holds the full state (including the resolved stream) of the last successful commit.
2.  **Effect-Based Capture**: An `effect` is used to eagerly capture this state whenever the resource is in a stable (non-pending) resolved state.
3.  **Optimization Logic**: When a new load is requested (via the internal loader wrapper), the resource checks if the request matches the `lastCommittedState`.
    - If the request parameters match the snapshot AND it is not a forced reload, the resource immediately returns the cached stream from the snapshot.
    - This bypasses the user-provided `loader` function, saving network requests and processing time.
4.  Because `effect` runs asynchronously, there is a theoretical edge case where a rapid, synchronous sequence of navigations (Resolve A -> Navigate B -> Rollback to A) might occur before the effect has captured state A.
    - **Safety**: In this case, we reload A. Since the loading is also controlled by an effect, it is not possible for the loader to complete _without_ the effect for the `lastCommittedState` to execute as well. You might be thinking "but blocking resources", but these also are committed to the Router state via an effect.

#### Handling Non-Blocking Resources

A crucial part of the design is the handling of non-blocking resources, where the router's navigation may complete _before_ the resource has finished loading.

1.  **Pending State:** When the navigation commits (pending becomes false), if a non-blocking resource is still loading, its public status correctly reflects `'loading'`.
2.  **Completion:** When the resource eventually resolves, its state updates naturally. Since `pending` is false, these updates are immediately reflected in the public signals.

## 7\. Migration & Interoperability

- Legacy Apps: Existing resolve functions continue to work as they do today (blocking, sequential).
- Incremental Adoption: New resources functions can be added to routes that already use resolve. Resources will execute after resolvers, receiving their data via ctx.resolvedData.
- Modern Apps: Can fully adopt resources for maximum parallelism, using resolve only when strict sequential prerequisites are unavoidable.

## 8\. Design Principles & Rationale

- Non-Blocking by Default: Prioritizes fast navigations and responsive UIs. Data fetching is deferred by default, allowing components to render immediately. Blocking is an explicit opt-in.
- Developer Intent is Key: The router does not infer intent. Developers explicitly signal blocking behavior: await for promises, `routerResource.blocking` for reactive resources.
- Transactional State: Prevents UI tearing and ensures atomic updates by staging pending state and committing it only upon successful navigation.
- Backward Compatibility: The new resources API is additive, maintaining full compatibility with existing router features and ActivatedRoute observables.
- Ergonomics for Reactive Primitives: Introduces `routerResource.blocking` and `routerResource` to provide an intuitive, Angular-specific API for managing reactive data fetching within the router.
- Alignment with Ecosystem: Synthesizes best practices from other modern frameworks (e.g., SvelteKit's deferred promises, universal await for blocking, Angular's signal-based reactivity).

## 9\. Future Exploration

### 9.1. Throw-Based Control Flow in Resources

To provide a more ergonomic and type-safe mechanism for redirecting or cancelling navigation from within a resources (which currently conflicts with ResourceResult's return type), we can introduce helper functions that throw special, recognized objects.  
Proposed API:

```ts
import { inject } from '@angular/core';
import { Router, Route, redirect, cancel, resource } from '@angular/router';

const routes: Route[] = [{
  path: 'users/:id',
  resources: (ctx) => {
    const router = inject(Router);
    return {
      user: routerResource({
        params: ctx.params(),
        loader: async ({params}) => {
          const id = params['id'];
          if (id === '0') {
            throw cancel(); // Cancel navigation
          }
          if (!(await canAccessProject(id))) {
            throw redirect(router.parseUrl('/login')); // Redirect
          }
          return fetch(`/api/users/${id}`).then(res => res.json());
        }
      })
    };
  }
}];
```

Rationale: This approach aligns with common patterns in other modern routers, improving developer experience and type safety by using control flow (`throw`) for navigation actions rather than modifying data return types. The router's pipeline would catch and interpret these thrown objects.

### Detailed Behavior and Transactional Scope

The ability for a thrown error to control navigation (i.e., redirect or cancel) is intentionally scoped to the router's active navigation transaction. The core principle is: **a routerResource can only control the navigation if the router's navigation transaction is currently active and waiting for that routerResource to resolve.**

This leads to a clear distinction in behavior between blocking and non-blocking routerResources:

**1. Blocking Resources (`routerResource.blocking`)**

- **The Contract:** When a developer uses `routerResource.blocking`, they are explicitly telling the router: "This navigation cannot be considered successful until this specific piece of data has resolved."
- **The Consequence:** Because the navigation's success is tied to the routerResource's outcome, the routerResource's outcome has the power to control the navigation.
  - **Initial Navigation:** If the routerResource's `resources` throws a `redirect` object, the router catches it during the `waitForBlockingResources` phase, cancels the current navigation, and starts a new one to the redirect target.
  - **Subsequent Navigations (on reused routes):** The same logic applies. When navigating to a URL that reuses a route with a `routerResource.blocking`, the router is once again actively waiting in the `waitForBlockingResources` phase for the routerResource to finish its refetch with the new parameters. If that refetch throws a `redirect`, it will be processed just like it was during the initial navigation.

**2. Non-Blocking Resources (default `routerResource`)**

- **The Contract:** When a developer uses a default, non-blocking `routerResource`, they are telling the router: "You can complete the navigation immediately and activate the component. I will handle the lifecycle of this data in the background."
- **The Consequence:** The router's navigation transaction **closes** as soon as all guards and blocking resourcess are done. The component is rendered, and the `RouterResource` is now simply a data provider for that component.
  - **Initial Navigation:** If a non-blocking routerResource throws a `redirect` during the initial load, it will _not_ be caught by the navigation pipeline because the router is not waiting for it. The routerResource will simply enter an `error` state.
  - **Subsequent Refetches:** If the routerResource later triggers a background refetch (due to a parameter change) and that refetch fails by throwing a `redirect`, it is treated as a data-loading error, not a navigation command. The `RouterResource` will update its status to `error`, and its `error()` signal will emit the `redirect` object. It is the component's responsibility to inspect this error and handle it gracefully (e.g., by showing a notification).

**User Experience Rationale**

This distinction is a deliberate design choice to create a predictable and stable user experience. It would be jarring and disruptive if a background data poll, invisible to the user, could suddenly hijack the application and redirect them away from a view they are actively interacting with. The power to control navigation is intentionally limited to the "gate-keeping" phase of the navigation itself, which is precisely what `routerResource.blocking` hooks into. This model balances the power of programmatic redirects with the stability of a component-managed state.

### 9.2. Eager Loading for Performance Optimization

To further optimize performance, a dedicated mechanism for eagerly loading data in parallel with guards and resolvers could be introduced.  
Proposed API: A separate eagerLoader property on the Route.

```ts
interface Route {
  /**
   * A resources that runs EAGERLY, in parallel with guards and resolvers.
   * This resources will NOT have access to `resolvedData`.
   */
  eagerLoader?: (ctx: ResourceContext) => ResourceResult;

  /**
   * The standard resources that runs AFTER guards and resolvers have completed.
   */
  resources?: (ctx: ResourceContext) => ResourceResult;
}
```

Rationale: This provides an opt-in mechanism for initiating optimistic data fetches earlier in the navigation lifecycle for non-critical or universally accessible data. By keeping eagerLoader separate, it avoids the "partial context" problem that would arise if a single resources function had to conditionally access resolvedData. It provides a clear contract and guarantees type safety for developers.
