# Data fetching with resources

The Angular Router integrates deeply with Angular Signals through the Route `resources` configuration. This allows you to perform data fetching reactively and functionally utilizing `Resource` APIs.

Data fetching with resources guarantees transactional safety for route transitions by deferring visual changes until the navigation has settled, automatically dropping UI updates if a navigation is canceled or failed, and providing ergonomic, type-safe APIs for route parameters.

## Router resources vs. ResolveFn

Historically, Angular relied on `ResolveFn` to block navigation and load data before a route activated. `RouterResource` introduces a modern, reactive approach to data fetching:

- **Reactivity:** `RouterResource` operates dynamically. The parameters of a route are mapped to an internal signal. When a user navigates between the same route structure but with different parameters (e.g., from `/user/1` to `/user/2`), the resource reacts and reloads automatically without the router needing to tear down and instantiate a new component.
- **`resources` vs `eagerResources`:**
  - `resources`: These execute _after_ all route guards (`canActivate`, `canActivateChild`) have successfully passed. This guarantees the request only triggers if the user has authorization to view the route.
  - `eagerResources`: These execute _immediately_ after the route URL is matched. This is excellent for speeding up data loads by fetching exactly parallel to the execution of your guards or lazy loaded bundles. Note that because `eagerResources` execute before `canActivate` guards, be mindful not to fetch secure details requiring authorization within them without separate backend validation.

## Setup

To enable this feature, provide `withRouterResources()` to your router configuration:

```ts
import {provideRouter, withComponentInputBinding, withRouterResources} from '@angular/router';

bootstrapApplication(AppComponent, {
  providers: [provideRouter(routes, withComponentInputBinding(), withRouterResources())],
});
```

You can then define resources globally in your route definitions and access them directly as component inputs.

```angular-ts
import {Component, input, Resource} from '@angular/core';
import {Routes} from '@angular/router';

const routes: Routes = [
  {
    path: 'user/:id',
    component: UserProfileComponent,
    eagerResources: (ctx) => ({
      user: resource({
        params: () => ctx.params()['id'],
        loader: ({params: id}) => fetchUser(id),
      }),
    }),
  },
];

@Component({
  template: `
    @if (user().isLoading()) {
      <p>Loading...</p>
    } @else if (user().error()) {
      <p>Error! {{ user().error()?.message }}</p>
    } @else {
      <p>User: {{ user().value()?.name }}</p>
    }
  `,
})
export class UserProfileComponent {
  // The router automatically binds the resource to the input matching its key.
  user = input.required<Resource<User>>();
}
```

> [!TIP]
> **Reactive Pitfall:** Notice we map the exact primitive ID we need in `params: () => ctx.params()['id']`. Passing the raw context object directly (e.g. `params: () => ctx.params()`) can cause unnecessary resource reloads during navigations. Because the router generates a new object identity for the parameters on navigation, the resource will trigger a refetch even if the specific `id` value you care about hasn't changed.

### ResourceContext

The `ctx` parameter provided to `resources` and `eagerResources` provides several Angular Signals representing the active route context:

- `params`: The matrix parameters of the route.
- `queryParams`: The query parameters of the route.
- `fragment`: The URL fragment.
- `data`: Data provided in the route configuration.
- `snapshot`: The static activated route snapshot for this navigation.

### rxResource Integration

You can natively pass `rxResource()` interchangeably with `resource()` into the route's resource object configuration for applications preferring observable-based or RxJS data fetching logic.

## Blocking contexts

By default, all resources returned from `resources` or `eagerResources` are **blocking**. The Router will wait until the data is fully loaded prior to activating the new component.

If you prefer to handle loading states in the UI, you can use the `nonBlocking()` wrapper utility. Non-blocking resources do not halt the navigation stream. The Router will finish activating the component immediately, relying on the UI to handle the deferred skeletal or `loading` states exposed by the `ResourceStatus`.

```ts
import {nonBlocking} from '@angular/router';

const routes: Routes = [
  {
    path: 'reports',
    component: ReportsComponent,
    resources: (ctx) => ({
      reportData: nonBlocking(
        resource({
          loader: () => fetchHeavyReportData(),
        }),
      ),
    }),
  },
];
```

NOTE: If a blocking resource throws an error, the router will cancel the navigation and emit a `NavigationError` event. Resources wrapped in `nonBlocking()` that error will complete navigation and expose the error via the `resource.error()` signal.

## Transitional states during pending navigations

When developing data-heavy applications, moving between two distinct views (or reloading the same view with new parameters) can often create a jarring UI flash as the current view abruptly switches to a loading skeleton.

The Router automatically masks the intermediate `loading` and `reloading` states of all resolved resources when a navigation is pending.

If you navigate from `/user/1` to `/user/2`, the `UserProfileComponent` will stay visibly mounted and continue rendering the data from `/user/1` (frozen in its exact state) until the router fully resolves `/user/2`. Once `/user/2` settles, the router releases the UI freeze, and the component instantly transitions to the new data with no loading flash.

TIP: Mutations triggered via `.set()`, `.update()`, or `.reload()` on a route resource _during_ a pending navigation will be securely passed down to the underlying `Resource` store. However, the Router will intentionally delay re-rendering these mutations on the UI until the navigation pipeline fully completes.

### Rollback recovery on cancellation

If a navigation is cancelled (e.g., by a guard), the router reverts the state tree to the previous successful state. This reversion might cause the resource's signal dependencies (like route parameters) to change back to their previous values.

Because the parameters changed back, the resource might automatically trigger a new load to fetch data for the old parameters. If the resource state were to update immediately upon cancellation, you would see a loading spinner or skeleton for data you were _just_ looking at before the navigation attempt.

To prevent this jarring flash of loading states for data that was already valid, the Router retains the previous resource snapshot in the UI until the resource has safely settled in the reverted state.

> [!TIP]
> **Resource Cleanup:** To prevent background resource leaks during cancellations, always forward the `abortSignal` provided by the resource loader to your asynchronous calls (like `fetch`). This ensures that when the router rolls back parameters and triggers a recovery load, the previous pending fetch is cleanly aborted.
