# Router Resources Integration (Architecture & Design)

This document outlines the architectural design, public API usage, and risk mitigation strategies for the Angular Router's integration with Signal Resources (`Resource<T>`).

## 1. Architectural Overview

The integration allows developers to map route parameters to declarative `Resource` loaders directly in the route configuration.

Historically, the Router used `ResolveFn`, which resolved promises strictly _before_ component activation. The new implementation leverages Signals to enable dynamic, reactive data fetching. If a user navigates from `/user/1` to `/user/2`, the parameter signals emit new values, the resource reactively fetches the new data, and the component updates without being destroyed and recreated.

### Key Internal Components

- **`ResourceContext`**: Provides reactive signals for `params`, `queryParams`, `fragment`, and `data` so resources can automatically track URL changes.
- **Execution Operators (`setup_and_run_resources`)**:
  - Manages the execution of `resources` and `eagerResources` configurations within the transition pipeline.
  - Creates a temporary `EnvironmentInjector` for each route node to manage the lifecycle and `DestroyRef` of the created resources. This injector is instantiated at the start of the navigation transition. If the navigation successfully completes, the resources are committed. If the navigation is canceled or fails, the injector and all associated resources are immediately destroyed.
- **The Transactional Wrapper (`router_resource.ts`)**:
  - Wraps the user-defined resource using `createTransactionalSnapshot`.
  - During a pending navigation, the router **freezes** the UI by serving a static snapshot of the resource state at the moment the navigation started.
  - This achieves a seamless transition: the component continues to render the "old" data without flickering or jarring loading screens while the "new" data resolves in the background. Upon `NavigationEnd`, the snapshot is released and the UI updates to the new data.

### Elimination of Data Waterfalls (Parallel Execution)

Historically, `ResolveFn` data fetching suffered from route-level waterfalls. A parent route's resolvers had to complete before a child route's resolvers could even begin. The new architecture completely eliminates this limitation. All defined resources across the entire matched route tree execute perfectly in parallel.

To balance performance and security, this parallel execution is split into two phases:

- **`eagerResources`**: Execute immediately upon URL matching, running in parallel with lazy-loaded bundles and `canActivate` guards. This provides the absolute fastest data fetching for public or non-sensitive data.
- **`resources`**: Execute strictly after all `canActivate` guards have passed, ensuring secure data is only fetched for authorized users.

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
  eagerResources: (ctx) => ({
    // The router automatically reacts when ctx.params()['id'] changes
    user: resource({
      request: () => ctx.params()['id'],
      loader: ({request: id}) => fetchUser(id)
    }),
  }),
}
```

### Consumption

Resources are mapped directly to the component's inputs. The router does NOT unwrap the data; it passes the full `Resource` object, allowing the component to handle loading states locally.

```ts
export class UserProfileComponent {
  user = input.required<Resource<User>>();
}
```

**Input Precedence:** If a resource key collides with a static `data` key or a route parameter, the router prioritizes inputs in the following order: `resources > eagerResources > resolve > params > data`.

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
   - **Blocking** resources halt the rendering and activation phase of the navigation pipeline until their loaders resolve. For `eagerResources`, the pipeline continues its other work in parallel until it reaches the activation phase, where it will block if the resource hasn't finished loading.
   - **Non-Blocking** resources are instantiated but the pipeline continues immediately. Their loading state will be visible to the component once activated.
3. **Commit / Rollback:**
   - **Commit (`NavigationEnd`):** The temporary injector is retained, the UI snapshot is unfrozen, and the new data is rendered.
   - **Rollback (`NavigationCancel` / `NavigationError`):** The temporary injector is destroyed, which automatically triggers the resource's `abortSignal` to cancel any in-flight network requests. The router restores the previous `ResourceContext` state. **Crucially, this restoration triggers the resources to reload with the previous parameters.** Since these parameters haven't actually changed from the user's perspective, developers are expected to use application-level caching (e.g., HTTP cache) to ensure these rollback requests resolve instantly without duplicate network calls.

## 3. Risk Mitigation & Design Decisions

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

## 4. AI / LLM Code Generation Efficacy

The shift from `ResolveFn` to Router Resources significantly improves the success rate for AI code generation and developer tooling (e.g., Copilot, Gemini). Large Language Models excel when APIs are declarative, strictly typed, and maintain localized context.

### Explicit vs. Implicit Reactivity

Traditional resolvers rely on implicit router lifecycle configurations (`runGuardsAndResolvers`) to trigger data re-fetches. When asked to reload data on param changes, LLMs frequently hallucinate incorrect `router.events.subscribe` logic inside components.
Router Resources provide explicit reactivity through the `ResourceContext`. Because the signal mapping (`request: () => ctx.params()['id']`) is colocated with the fetcher, an LLM can trivially deduce _why_ and _when_ data is fetched.

### Component Isolation

Because resources are exposed via `withComponentInputBinding()`, an LLM does not need to understand the `ActivatedRoute` context to generate a working component.
The LLM simply writes: `userData = input.required<Resource<User>>()`. This removes the need for the LLM to choose between `snapshot.data` (which causes stale data bugs) and `.data.subscribe()` (which introduces async pipe complexity), while natively handling loading states (`@if (userData().isLoading())`).

### Complex State Combination

A common failure point for LLM generation is combining router state with external service state (e.g., fetching based on Route ID _and_ a global Filter signal). With Resolvers, LLMs typically abandon the pattern and generate spaghetti code inside the component's `ngOnInit`.
With Router Resources, the LLM can easily synthesize the correct reactive solution natively:

```ts
eagerResources: (ctx) => ({
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
