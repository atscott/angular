/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import {
  createEnvironmentInjector,
  runInInjectionContext,
  Resource,
  effect,
  DestroyRef,
  EnvironmentInjector,
} from '@angular/core';
import {OperatorFunction, pipe} from 'rxjs';
import {ResourceContext, ResourceResult} from '../models';
import {createRouterState} from '../create_router_state';
import {RouteReuseStrategy} from '../route_reuse_strategy';
import {NavigationTransition} from '../navigation_transition';
import {
  ActivatedRoute,
  ActivatedRouteSnapshot,
  initializeActivatedRoute,
  RouterState,
  RouterStateSnapshot,
} from '../router_state';
import {TreeNode} from '../utils/tree';
import {
  BLOCKING_SYMBOL,
  InternalRouterResource,
  routerResource,
  SOURCE_RESOURCE_SYMBOL,
} from '../router_resource';
import {switchTap} from './switch_tap';

export function setupAndRunResources(
  abortSignal: AbortSignal,
): OperatorFunction<NavigationTransition, NavigationTransition> {
  return pipe(
    switchTap(({newlyCreatedRoutes, targetRouterState}) => {
      if (!newlyCreatedRoutes || !targetRouterState) {
        return;
      }
      return runResources(newlyCreatedRoutes, targetRouterState, abortSignal);
    }),
  );
}

export function runResources(
  newlyCreatedRoutes: Set<ActivatedRoute>,
  targetRouterState: RouterState,
  abortSignal: AbortSignal,
  /**
   * When `true`, the returned promise also waits for non-blocking resources to settle. This is
   * used when preloading, where the caller destroys the resource injectors as soon as the promise
   * resolves and would otherwise abort in-flight requests for non-blocking resources.
   */
  awaitNonBlockingResources = false,
): Promise<void> {
  if (abortSignal.aborted) {
    return Promise.resolve();
  }

  const resourceSetupPromises: Array<Promise<void>> = [];
  const settledResourcePromises: Array<Promise<void>> = [];

  const traverse = (stateNode: TreeNode<ActivatedRoute>) => {
    const route = stateNode.value;
    if (route) {
      initializeActivatedRoute(route);
      processRoute(
        route,
        newlyCreatedRoutes,
        resourceSetupPromises,
        abortSignal,
        settledResourcePromises,
        awaitNonBlockingResources,
      );
    }

    for (const childState of stateNode.children) {
      traverse(childState);
    }
  };

  traverse(targetRouterState._root);

  // Note that `settledResourcePromises` must be read lazily: an async `resources` function pushes
  // its promises after the setup promise resolves. Rejections that happen before the array is
  // awaited are handled where the promises are created (see `waitForResources`).
  return Promise.all(resourceSetupPromises)
    .then(() => Promise.all(settledResourcePromises))
    .then(() => {});
}

function processRoute(
  route: ActivatedRoute,
  newlyCreatedRoutes: Set<ActivatedRoute>,
  resourceSetupPromises: Array<Promise<void>>,
  abortSignal: AbortSignal,
  settledResourcePromises: Array<Promise<void>>,
  awaitNonBlockingResources: boolean,
) {
  const resources = route.routeConfig?.resources;
  if (!resources) {
    return;
  }

  if (newlyCreatedRoutes.has(route)) {
    // This route is new. We need to run its resources function once.
    resourceSetupPromises.push(
      setupNewRouterResources(
        route._futureSnapshot,
        route,
        abortSignal,
        settledResourcePromises,
        awaitNonBlockingResources,
      ),
    );
  } else {
    updateExistingResources(route, settledResourcePromises, abortSignal, awaitNonBlockingResources);
  }
}

async function setupNewRouterResources(
  snapshot: ActivatedRouteSnapshot,
  route: ActivatedRoute,
  abortSignal: AbortSignal,
  settledResourcePromises: Promise<void>[],
  awaitNonBlockingResources: boolean,
) {
  const resourcesFn = snapshot?.routeConfig?.resources;
  const parentInjector = snapshot?._environmentInjector;
  if (!resourcesFn || !parentInjector) {
    return;
  }

  let childInjector = route._localInjector;
  if (!childInjector) {
    childInjector = createEnvironmentInjector([], parentInjector);
    route._localInjector = childInjector; // Attach to route for cleanup
  }

  const context: ResourceContext = {
    params: route.paramsSignal,
    queryParams: route.queryParamsSignal,
    fragment: route.fragmentSignal,
    data: route.dataSignal,
  };

  const resourceResultRaw = runInInjectionContext(childInjector, () => resourcesFn(context));
  let resourceResult: ResourceResult;
  if (resourceResultRaw instanceof Promise) {
    resourceResult = await resourceResultRaw;
    // Bail out if the router cancelled the navigation (and destroyed our injector!)
    // while we were waiting.
    if (abortSignal.aborted) return;
  } else {
    resourceResult = resourceResultRaw as ResourceResult;
  }

  if (!resourceResult) return;

  const wrappedResult: ResourceResult = {};
  for (const [key, res] of Object.entries(resourceResult)) {
    if (typeof ngDevMode === 'undefined' || ngDevMode) {
      if (
        !res ||
        typeof res !== 'object' ||
        typeof (res as Partial<Resource<unknown>>).snapshot !== 'function'
      ) {
        throw new Error(
          `Invalid resource returned for key "${key}". Expected a Resource, but got ${res === null ? 'null' : typeof res}.`,
        );
      }
    }

    wrappedResult[key] = runInInjectionContext(childInjector, () => routerResource(res));
  }

  route.resources = route._futureSnapshot.resources = snapshot.resources = wrappedResult;
  waitForResources(
    route,
    wrappedResult,
    settledResourcePromises,
    abortSignal,
    awaitNonBlockingResources,
  );
}

function updateExistingResources(
  route: ActivatedRoute,
  settledResourcePromises: Promise<void>[],
  abortSignal: AbortSignal,
  awaitNonBlockingResources: boolean,
) {
  // This route is reused. We must eagerly update the resource context signals
  // so that resources can react and fetch new data during the pending navigation.
  const currentResources = route.snapshot?.resources;
  if (!currentResources) {
    return;
  }

  Object.values(currentResources).forEach((r) => {
    const underlyingRes = (r as InternalRouterResource)[SOURCE_RESOURCE_SYMBOL];
    if (underlyingRes.status() === 'error') {
      // If a resource previously failed and the route is reused identically,
      // the parameter signals won't change, meaning the internal effect won't automatically refetch.
      // We must manually trigger a reload to ensure the new navigation attempts a retry.
      (underlyingRes as unknown as {reload?: () => boolean}).reload?.();
    }
  });

  route._futureSnapshot.resources = currentResources;
  waitForResources(
    route,
    currentResources,
    settledResourcePromises,
    abortSignal,
    awaitNonBlockingResources,
  );
}

/**
 * Creates a promise for each resource of the given route that resolves when the resource settles
 * (or rejects if a blocking resource errors) and pushes it onto `settledResourcePromises`.
 *
 * Only blocking resources are awaited unless `awaitNonBlockingResources` is set.
 */
function waitForResources(
  route: ActivatedRoute,
  resourceResult: ResourceResult,
  settledResourcePromises: Array<Promise<void>>,
  abortSignal: AbortSignal,
  awaitNonBlockingResources: boolean,
) {
  if (abortSignal.aborted) return;
  const childInjector = route._localInjector;
  if (!childInjector || !resourceResult) return;

  for (const r of Object.values(resourceResult)) {
    const res = r as InternalRouterResource;
    const isBlocking = res[BLOCKING_SYMBOL] !== false;
    if (!isBlocking && !awaitNonBlockingResources) {
      continue;
    }
    const promise = new Promise<void>((resolve, reject) => {
      const underlyingRes = res[SOURCE_RESOURCE_SYMBOL];
      let isDestroyed = false;
      let unregisterOnDestroy: (() => void) | undefined;

      const cleanup = () => {
        isDestroyed = true;
        blockingEffect.destroy();
        unregisterOnDestroy?.();
        abortSignal.removeEventListener('abort', onAbort);
      };

      const onAbort = () => {
        cleanup();
        resolve();
      };

      abortSignal.addEventListener('abort', onAbort, {once: true});

      const blockingEffect = effect(
        () => {
          if (isDestroyed) {
            return;
          }
          const status = underlyingRes.status();
          if (status === 'error') {
            cleanup();
            // A failing non-blocking resource must not fail the navigation (or the preload).
            if (isBlocking) {
              reject(underlyingRes.error());
            } else {
              resolve();
            }
          } else if (!underlyingRes.isLoading()) {
            cleanup();
            resolve();
          }
        },
        {injector: childInjector, manualCleanup: true},
      );

      unregisterOnDestroy = childInjector.get(DestroyRef).onDestroy(() => {
        cleanup();
        resolve();
      });
    });
    // The promise may reject before the caller awaits the collected promises (in particular when
    // the `resources` function of another route is still being set up). Attaching a no-op handler
    // here marks the rejection as handled without swallowing it for `Promise.all` below.
    promise.catch(() => {});
    settledResourcePromises.push(promise);
  }
}

/**
 * A `RouteReuseStrategy` that never reuses, stores, or retrieves routes.
 *
 * Preloading must not interact with the routes of the live application: retrieving a stored
 * `DetachedRouteHandle` would mark real `ActivatedRoute`s as pending (they would never be
 * advanced, because preloading does not activate anything), replace the children of the stored
 * handle, and reload the resources of the live route.
 */
const NO_REUSE_STRATEGY: RouteReuseStrategy = {
  shouldDetach: () => false,
  store: () => {},
  shouldAttach: () => false,
  retrieve: () => null,
  shouldReuseRoute: () => false,
};

/**
 * Preloads resources for routes in a route snapshot tree, waiting for all resources (blocking and
 * non-blocking) to settle and destroying transient injectors upon completion.
 *
 * All resources are awaited because the injectors are destroyed as soon as this promise resolves;
 * destroying a resource that is still loading aborts its request, which would defeat the purpose
 * of preloading.
 */
export async function preloadResources(
  snapshot: RouterStateSnapshot,
  abortSignal: AbortSignal,
): Promise<void> {
  const {newlyCreatedRoutes, state} = createRouterState(NO_REUSE_STRATEGY, snapshot);
  try {
    await runResources(
      newlyCreatedRoutes,
      state,
      abortSignal,
      /* awaitNonBlockingResources */ true,
    );
  } finally {
    for (const r of newlyCreatedRoutes) {
      r._localInjector?.destroy();
      r._localInjector = undefined;
    }
  }
}
