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
  effect,
  DestroyRef,
  Resource,
} from '@angular/core';
import {OperatorFunction, pipe} from 'rxjs';
import {ResourceContext, ResourceResult} from '../models';
import {NavigationTransition} from '../navigation_transition';
import {ActivatedRoute, ActivatedRouteSnapshot} from '../router_state';
import {TreeNode} from '../utils/tree';
import {
  NON_BLOCKING_SYMBOL,
  SOURCE_RESOURCE_SYMBOL,
  routerResource,
  InternalRouterResource,
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

      const resourceSetupPromises: Array<Promise<void>> = [];
      const blockingResourcePromises: Array<Promise<void>> = [];

      const traverse = (stateNode: TreeNode<ActivatedRoute>) => {
        const route = stateNode.value;
        if (route) {
          processRoute(route, newlyCreatedRoutes, resourceSetupPromises, blockingResourcePromises);
        }

        for (const childState of stateNode.children) {
          traverse(childState);
        }
      };

      traverse(targetRouterState._root);

      function throwIfAborted() {
        if (abortSignal.aborted) {
          throw new Error(abortSignal.reason);
        }
      }

      return Promise.all(resourceSetupPromises)
        .then(throwIfAborted)
        .then(() => Promise.all(blockingResourcePromises))
        .then(throwIfAborted);
    }),
  );
}

function processRoute(
  route: ActivatedRoute,
  newlyCreatedRoutes: Set<ActivatedRoute>,
  resourceSetupPromises: Array<Promise<void>>,
  blockingResourcePromises: Array<Promise<void>>,
) {
  const resources = route.routeConfig?.resources;
  if (!resources) {
    return;
  }

  if (newlyCreatedRoutes.has(route)) {
    // This route is new. We need to run its resources function once.
    resourceSetupPromises.push(
      setupNewRouterResources(route._futureSnapshot, route, blockingResourcePromises),
    );
  } else {
    updateExistingResources(route, blockingResourcePromises);
  }
}

async function setupNewRouterResources(
  snapshot: ActivatedRouteSnapshot,
  route: ActivatedRoute,
  blockingResourcePromises: Array<Promise<void>>,
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
    snapshot: route._futureSnapshot,
  };

  const resourceResultRaw = runInInjectionContext(childInjector, () => resourcesFn(context));
  let resourceResult: ResourceResult;
  if (resourceResultRaw instanceof Promise) {
    resourceResult = await resourceResultRaw;
    // Bail out if the router cancelled the navigation (and destroyed our injector!)
    // while we were waiting.
    if (!route.pending?.()) return;
  } else {
    resourceResult = resourceResultRaw as ResourceResult;
  }

  if (!resourceResult) return;

  const wrappedResult: ResourceResult = {};
  for (const [key, r] of Object.entries(resourceResult)) {
    let res = r;

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

    res = runInInjectionContext(childInjector, () => routerResource(res));
    wrappedResult[key] = res;
  }

  route.resources = route._futureSnapshot.resources = snapshot.resources = wrappedResult;
  setupBlocking(route, wrappedResult, blockingResourcePromises);
}

function updateExistingResources(route: ActivatedRoute, blockingResourcePromises: Promise<void>[]) {
  // This route is reused. We must eagerly update the resource context signals
  // so that resources can react and fetch new data during the pending navigation.
  const currentResources = route.snapshot?.resources;
  if (!currentResources) {
    return;
  }

  route._futureSnapshot.resources = currentResources;

  // Allow the resource's zoneless effect to react to the new parameters
  // and transition to 'reloading' before `waitForBlockingResources` checks its status.
  Object.values(currentResources).forEach((r) => {
    const underlyingRes = (r as InternalRouterResource)[SOURCE_RESOURCE_SYMBOL];
    if (underlyingRes.status() === 'error') {
      // If a resource previously failed and the route is reused identically,
      // the parameter signals won't change, meaning the internal effect won't automatically refetch.
      // We must manually trigger a reload to ensure the new navigation attempts a retry.
      (underlyingRes as unknown as {reload?: () => boolean}).reload?.();
    }
  });

  setupBlocking(route, currentResources, blockingResourcePromises);
}

function setupBlocking(
  route: ActivatedRoute,
  resourceResult: ResourceResult,
  blockingResourcePromises: Array<Promise<void>>,
) {
  const childInjector = route._localInjector;
  if (!childInjector || !resourceResult) return;

  for (const r of Object.values(resourceResult)) {
    const res = r as InternalRouterResource;
    if (res[NON_BLOCKING_SYMBOL]) {
      continue;
    }
    const promise = new Promise<void>((resolve, reject) => {
      const underlyingRes: Resource<unknown> = res[SOURCE_RESOURCE_SYMBOL] || res;
      let isDestroyed = false;
      let unregisterOnDestroy: (() => void) | undefined;

      const blockingEffect = effect(
        () => {
          if (isDestroyed) {
            return;
          }
          const status = underlyingRes.status();
          if (status === 'error') {
            reject(underlyingRes.error());
            blockingEffect.destroy();
            unregisterOnDestroy?.();
          } else if (
            underlyingRes.hasValue() ||
            (status !== 'idle' && status !== 'loading' && status !== 'reloading')
          ) {
            resolve();
            blockingEffect.destroy();
            unregisterOnDestroy?.();
          }
        },
        {injector: childInjector, manualCleanup: true},
      );

      unregisterOnDestroy = childInjector.get(DestroyRef).onDestroy(() => {
        isDestroyed = true;
        resolve();
        blockingEffect.destroy();
      });
    });
    blockingResourcePromises.push(promise);
  }
}
