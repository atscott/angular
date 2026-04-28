# Router Resources Integration (Architecture & Design)

**General Architectural Overview:** Resources integrate into the Router by receiving router info in their context to track pending navigation information. Pending loads are hidden behind a snapshot. The router blocks activation while blocking resources are loading or don't have values. Errors cause navigation cancellation and pending state rollbacks.

This document outlines the architectural design, public API usage, and risk mitigation strategies for the Angular Router's integration with Signal Resources (`Resource<T>`).

## 1. Architectural Overview

The integration allows developers to map route parameters to declarative `Resource` loaders directly in the route configuration.

Historically, the Router used `ResolveFn`, which resolved promises strictly _before_ component activation. The new implementation leverages Signals to enable dynamic, reactive data fetching. If a user navigates from `/user/1` to `/user/2`, the parameter signals emit new values, the resource reactively fetches the new data, and the component updates without being destroyed and recreated.

### Key Internal Components & Lifecycle

- **`ResourceContext`**: Provides reactive signals for `params`, `queryParams`, `fragment`, and `data` so resources can automatically track URL changes.
- **Execution Operators (`setup_and_run_resources.ts`)**:
  - Manages the execution of `resources` configuration within the transition pipeline.
  - **Lifecycle & Injector**: Creates a child `EnvironmentInjector` for each route node (in `runResources`) using the router snapshot's injector as parent. This injector is mounted onto the `ActivatedRoute` (`route._resourceInjector`), tying the resource lifetime to the route.
  - **Destruction**: The injector is destroyed during route deactivation (in `activate_routes.ts`), or during rollback if navigation fails and no resources are committed (in `ActivatedRoute._rollback` in `router_state.ts`). `RouteReuseStrategy` skips destruction to retain cache, requiring manual cleanup if dropped (via `destroyDetachedRouteHandle` in `route_reuse_strategy.ts`).
- **The Transactional Wrapper (`router_resource.ts`)**:
  - Wraps the user-defined resource using `createTransactionalSnapshot`.
  - **State Freezing**: During a pending navigation, it freezes the UI by serving a static snapshot of the resource state (`frozenSnapshot`), hiding background loads.
  - **Hiding Mutation APIs**: Statically obscures mutation APIs using `Omit` and `Object.create(res)` as an allowlist, forwarding only safe methods like `reload()`.
  - **Rollbacks**: On cancellation or error, it preserves the frozen UI (`isRollbackRecoveryPending`) until the recovery fetch completes, preventing loading flashes.

### Elimination of Data Waterfalls (Parallel Execution)

Historically, `ResolveFn` data fetching suffered from route-level waterfalls. A parent route's resolvers had to complete before a child route's resolvers could even begin. The new architecture completely eliminates this limitation. All defined resources across the entire matched route tree execute perfectly in parallel.

All defined resources across the entire matched route tree execute strictly after all `canActivate` guards have passed, ensuring secure data is only fetched for authorized users.

## 2. Public API Usage

The API footprint is intentionally small, relying on standard Angular primitives.

### Setup

The feature is enabled via the `withRouterResources()` feature flag, and requires `withComponentInputBinding()` to pass the resources to the component.

```ts
providers: [provideRouter(routes, withComponentInputBinding(), withRouterResources())];
```

### Route Configuration

Resources are defined in the route config. They are passed the `ResourceContext`.

```ts
{
  path: 'user/:id',
  component: UserProfileComponent,
  resources: (ctx) => ({
    // The router automatically reacts when ctx.params()['id'] changes
    user: resource({
      request: () => ctx.params()['id'],
      loader: ({request: id}) => fetchUser(id)
    }),
  }),
}
```

### Consumption

Resources are mapped directly to the component's inputs. The behavior depends on whether the resource is blocking or non-blocking:

- **Blocking resources (default):** The router waits for the data to resolve before completing the navigation. It **unwraps the data** and passes the resolved value directly to the component input.

  ```ts
  export class UserProfileComponent {
    // Receives the unwrapped User object
    user = input.required<User>();
  }
  ```

- **Non-blocking resources (opt-in via `nonBlocking()`):** The router does NOT wait for the data. It passes the **full `Resource` object** itself, allowing the component to handle loading states locally in the template.
  ```ts
  export class UserProfileComponent {
    // Receives the full Resource object
    user = input.required<Resource<User>>();
  }
  ```

**Input Precedence:** If a resource key collides with a static `data` key or a route parameter, the router prioritizes inputs in the following order: `resources > resolve > params > data`.

### Blocking vs. Non-Blocking

By default, resources are **blocking**. The router will wait for them to resolve before completing the navigation.
If developers prefer to activate the component immediately and show a loading spinner, they can wrap the resource in the `nonBlocking()` utility.

```ts
import { nonBlocking } from '@angular/router';

resources: (ctx) => ({
  dashboardStats: nonBlocking(resource({...}))
})
```

### Title Integration

Resources seamlessly integrate with the router's `TitleStrategy`. By configuring a resource for the route's `title`, the page title will automatically update when the resource resolves. This allows your page titles to be dynamically driven by the same reactive route parameters used to fetch component data.

### Navigation Transition Lifecycle

Resource execution is tightly integrated with the Router's `navigation_transition` lifecycle:

1. **Start:** A temporary injector is created and resources are instantiated.
2. **Execution:**
   - **Blocking** resources halt the rendering and activation phase of the navigation pipeline until their loaders resolve.
   - **Non-Blocking** resources are instantiated but the pipeline continues immediately. Their loading state will be visible to the component once activated.
3. **Commit / Rollback:**
   - **Commit (`NavigationEnd`):** The temporary injector is retained, the UI snapshot is unfrozen, and the new data is rendered.
   - **Rollback (`NavigationCancel` / `NavigationError`):** The temporary injector is destroyed, which automatically triggers the resource's `abortSignal` to cancel any in-flight network requests. The router restores the previous `ResourceContext` state. **Crucially, this restoration triggers the resources to reload with the previous parameters.** Since these parameters haven't actually changed from the user's perspective, developers are expected to use application-level caching (e.g., HTTP cache) to ensure these rollback requests resolve instantly without duplicate network calls.

## 3. Integration Points

Resources are integrated into several key areas of the router:

- **Component Input Binding**:
  - **Blocking Resources (default)**: Handled in `provide_router.ts` (`createResourceEffects`). Binds the unwrapped value (`resource.value()`) directly to component inputs.
  - **Non-Blocking Resources**: Falls through to `RoutedComponentInputBinder` in `router_outlet.ts`. Binds the full `Resource` object to the input.
- **Title Strategy**: Integrated in `provide_router.ts` (`initializeTitleStrategy`) and `page_title_strategy.ts`. Allows page titles to be driven by resource values.
- **`ActivatedRoute`**: Stored on `ActivatedRoute` in `router_state.ts` but marked `@internal` and `@experimental` to prevent breaking reactivity by replacing stable references.
- **`Route` Interface**: Updated in `models.ts` to include `resources` function.

## 4. Risk Mitigation & Design Decisions

The API surface and implementation were explicitly constrained to minimize risk during the experimental phase.

### Omission from `ActivatedRoute`

Resources are **not** available on the `ActivatedRoute` service. _Note: This is an intentional constraint for the experimental phase and may be re-evaluated for the final stable release based on community feedback._ By forcing consumption via Component Input Binding, we currently achieve two goals:

1. **Clean Legacy API:** The `ActivatedRoute` interface remains free of new, complex Signal properties.
2. **Idiomatic Signals:** Developers are pushed toward modern `@Input()` and `input()` APIs, resulting in clean components that are completely decoupled from the Router.

### Read-Only Projection & Sanitization

The transactional wrapper projects the state using `resourceFromSnapshots`. This intentionally strips the `set()` and `update()` methods, as well as **any custom methods** attached to custom resource implementations (e.g., `myResource.retryWithBackoff()`), from the exposed resource.

- **Risk Mitigated ("Ghost" Mutations):** If a user mutated the resource via `set()`, `update()`, or a custom mutating method while a navigation was pending, the UI state is frozen, making their change invisible until the navigation completed. Stripping these methods entirely removes this category of race conditions.
- **Risk Mitigated (Maintenance):** Prevents the Router from being forced to support or debug arbitrary resource extensions. The API enforces strict adherence to the standard, read-only `Resource` interface.

### Avoidance of JavaScript `Proxy`

Instead of using `Proxy` to trap getters and setters (which is heavy and can break `this` context), the wrapper uses `Object.create(baseResource)`.

- **Risk Mitigated:** High performance overhead and minification bugs associated with Proxies.

### Reload Interception

The `reload()` method is intercepted. If a navigation is pending (`frozenSnapshot !== null`), the reload call is ignored.

- **Risk Mitigated:** Double-fetching. Prevents the component from manually triggering a reload with outdated parameters while the router is already fetching data for the new parameters in the background.

### Timing Dependencies (Signals vs. RxJS)

The architecture leverages Signals and `effect()` for reactivity rather than complex RxJS pipelines. Signal design specifically does not allow observing the exact moment a dependency changes, only its current value.

- **Risk Mitigated:** Fragile execution order and race conditions. In reactive streams, the precise order of synchronous vs. micro-task emissions can lead to subtle timing bugs. Signals abstract away these timing complexities, ensuring the resource loader executes purely based on the settled state of the `ResourceContext`.

### Bundle Size & Tree-Shaking

The feature is designed with tree-shaking in mind. If `withRouterResources()` is not included in the router providers, the internal execution operators and transactional wrappers are dropped from the build. The total size cost of this feature, even when unused, is extremely minimal (less than 3kb uncompressed).

## 5. AI / LLM Code Generation Efficacy

The shift from `ResolveFn` to Router Resources significantly improves the success rate for AI code generation and developer tooling (e.g., Copilot, Gemini). Large Language Models excel when APIs are declarative, strictly typed, and maintain localized context.

### Explicit vs. Implicit Reactivity

Traditional resolvers rely on implicit router lifecycle configurations (`runGuardsAndResolvers`) to trigger data re-fetches. When asked to reload data on param changes, LLMs frequently hallucinate incorrect `router.events.subscribe` logic inside components.
Router Resources provide explicit reactivity through the `ResourceContext`. Because the signal mapping (`request: () => ctx.params()['id']`) is colocated with the fetcher, an LLM can trivially deduce _why_ and _when_ data is fetched.

### Component Isolation

Because resources are exposed via `withComponentInputBinding()`, an LLM does not need to understand the `ActivatedRoute` context to generate a working component.
The LLM simply writes: `userData = input.required<User>()` for blocking resources, or `userData = input.required<Resource<User>>()` for non-blocking resources. This removes the need for the LLM to choose between `snapshot.data` (which causes stale data bugs) and `.data.subscribe()` (which introduces async pipe complexity), while natively handling loading states if needed (`@if (userData().isLoading())`).

### Complex State Combination

A common failure point for LLM generation is combining router state with external service state (e.g., fetching based on Route ID _and_ a global Filter signal). With Resolvers, LLMs typically abandon the pattern and generate spaghetti code inside the component's `ngOnInit`.
With Router Resources, the LLM can easily synthesize the correct reactive solution natively:

```ts
resources: (ctx) => ({
  data: resource({
    request: () => ({
      id: ctx.params()['id'],
      filter: inject(FilterService).filter(), // Seamlessly tracks external signal
    }),
    loader: ({request}) => fetch(request.id, request.filter),
  }),
});
```

### Imperative Reloading

When a developer prompts an LLM for a "Refresh" button, resolvers typically lead to the LLM suggesting a dummy navigation (e.g., `router.navigate([], { queryParams: { refresh: Date.now() } })`) to force the resolver to re-run. With this new architecture, the LLM simply suggests calling `this.myInput().reload()`.

### LLM Evaluation Results

During LLM evaluations of prompts, comparing current Resolvers to Resources (when the prompt provided information on how the new resource works), the following results were observed:

1. **Input Tokens (Context Size)**
   - **Resource Prompts:** ~4,150 tokens (The resource docs were slightly more token-dense due to the extra code examples).
   - **Resolver Prompts:** ~3,100 tokens.
   - _Note:_ Despite having less text to read for the resolvers, the model still worked much harder on them!

2. **Output Tokens (Code Size)**
   The model consistently generated much more code trying to solve the complex Resolver tasks:
   - **Mixed Dependencies:** Resolver required 13,708 output tokens vs. Resource requiring only 4,280.
   - **Streaming Fetch:** Resolver required 9,868 output tokens vs. Resource requiring only 3,655.
   - **Non-blocking Fetch:** Resolver required 7,949 output tokens vs. Resource requiring only 3,369.
   - _(The basic fetch prompt was identical at ~2,500 tokens)._

3. **Thinking Tokens (Mental Effort)**
   The amount of reasoning the model had to do was drastically lower for the Resource tasks:
   - **Mixed Dependencies:** Resolver required 10,488 thinking tokens vs. Resource requiring only 1,337.
   - **Streaming Fetch:** Resolver required 6,897 thinking tokens vs. Resource requiring only 1,615.
   - **Non-blocking Fetch:** Resolver required 4,725 thinking tokens vs. Resource requiring only 983.

#### Final Takeaway

Even with documentation provided for both, the model used up to 8x less thinking effort and generated less than half the code to solve the exact same data loading scenarios using the new Resources API.
