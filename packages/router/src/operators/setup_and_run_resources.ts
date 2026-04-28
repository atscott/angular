/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {createEnvironmentInjector, runInInjectionContext, effect, DestroyRef} from '@angular/core';
import {from, of, OperatorFunction} from 'rxjs';
import {switchMap} from 'rxjs/operators';
import {ResourceContext} from '../models';
import {NavigationTransition} from '../navigation_transition';
import {ActivatedRoute, ActivatedRouteSnapshot} from '../router_state';
import {TreeNode} from '../utils/tree';
import {NON_BLOCKING_SYMBOL, SOURCE_RESOURCE_SYMBOL, routerResource} from '../router_resource';
import {InjectionToken} from '@angular/core';

export const enum ResourceFeatureKind {
  Resources,
  EagerResources,
}

export function setupAndRunResources(
  kind: ResourceFeatureKind = ResourceFeatureKind.Resources,
): OperatorFunction<NavigationTransition, NavigationTransition> {
  return switchMap((t) => {
    const {newlyCreatedRoutes, targetRouterState} = t;
    if (!newlyCreatedRoutes || !targetRouterState) {
      return of(t);
    }

    const routesToProcess: Array<Promise<void>> = [];
    t.blockingResources ??= [];

    const traverse = (stateNode: TreeNode<ActivatedRoute>) => {
      const route = stateNode.value;
      if (route) {
        route._setPending(route._futureSnapshot);
        const resources =
          kind === ResourceFeatureKind.Resources
            ? route.routeConfig?.resources
            : route.routeConfig?.eagerResources;
        if (resources) {
          if (newlyCreatedRoutes.has(route)) {
            // This route is new. We need to run its resources function once.
            routesToProcess.push(runResources(route._futureSnapshot, route, t, kind));
          } else {
            // This route is reused. We must eagerly update the resource context signals
            // so that resources can react and fetch new data during the pending navigation.
            const futureSnapshot = route._futureSnapshot;
            const currentResources =
              kind === ResourceFeatureKind.Resources
                ? route.snapshot?.resources
                : route.snapshot?.eagerResources;

            if (currentResources) {
              const result = currentResources;
              if (kind === ResourceFeatureKind.Resources) {
                futureSnapshot.resources = result;
              } else {
                futureSnapshot.eagerResources = result;
              }

              // Allow the resource's zoneless effect to react to the new parameters
              // and transition to 'reloading' before `waitForBlockingResources` checks its status.
              // Note: The router's blocking effect naturally executes after the resource effect in the same tick!
              // This is guaranteed because the resource effect is registered earlier (on resource creation) and the effect scheduler executes effects in registration order.
              Object.values(result).forEach((r: any) => {
                const underlyingRes = r[SOURCE_RESOURCE_SYMBOL] || r;
                if (underlyingRes.status() === 'error') {
                  // If a resource previously failed and the route is reused identically,
                  // the parameter signals won't change, meaning the internal effect won't automatically refetch.
                  // We must manually trigger a reload to ensure the new navigation attempts a retry.
                  underlyingRes.reload();
                }
              });

              setupBlocking(route, result, t);
            }
          }
        }
      }

      for (const childState of stateNode.children) {
        traverse(childState);
      }
    };

    traverse(targetRouterState._root);

    if (routesToProcess.length === 0) {
      return of(t);
    }
    return from(Promise.all(routesToProcess).then(() => t));
  });
}

async function runResources(
  snapshot: ActivatedRouteSnapshot,
  route: ActivatedRoute,
  t: NavigationTransition,
  kind: ResourceFeatureKind,
) {
  const resourcesFn =
    kind === ResourceFeatureKind.Resources
      ? snapshot?.routeConfig?.resources
      : snapshot?.routeConfig?.eagerResources;
  if (!resourcesFn) return;
  const parentInjector = snapshot?._environmentInjector;
  if (!parentInjector) {
    return;
  }

  let resourceResult: any;
  let childInjector = route._resourceInjector;
  if (!childInjector) {
    childInjector = createEnvironmentInjector([], parentInjector);
    route._resourceInjector = childInjector; // Attach to route for cleanup
  }

  const context: ResourceContext = {
    params: route.paramsSignal,
    queryParams: route.queryParamsSignal,
    fragment: route.fragmentSignal,
    data: route.dataSignal,
    snapshot: route._futureSnapshot,
  };

  resourceResult = runInInjectionContext(childInjector, () => resourcesFn(context));
  if (resourceResult instanceof Promise) {
    resourceResult = await resourceResult;
    // Bail out if the router cancelled the navigation (and destroyed our injector!)
    // while we were waiting on the macro task queue.
    if (!route.pending()) return;
  }

  if (!resourceResult) return;

  const wrappedResult: any = {};
  for (const key of Object.keys(resourceResult)) {
    let res = resourceResult[key];

    if (typeof ngDevMode === 'undefined' || ngDevMode) {
      if (!res || typeof res !== 'object' || typeof res.snapshot !== 'function') {
        throw new Error(
          `Invalid resource returned for key "${key}". Expected a Resource, but got ${typeof res === 'object' && res ? 'an object without a snapshot method' : typeof res}.`,
        );
      }
    }

    if (!(res as any)[SOURCE_RESOURCE_SYMBOL]) {
      res = runInInjectionContext(childInjector, () => routerResource({source: res as any}));
    }
    wrappedResult[key] = res;
  }
  if (kind === ResourceFeatureKind.Resources) {
    snapshot.resources = {...snapshot.resources, ...wrappedResult};
    route._futureSnapshot.resources = snapshot.resources;
    route.resources = snapshot.resources;
  } else {
    snapshot.eagerResources = {...snapshot.eagerResources, ...wrappedResult};
    route._futureSnapshot.eagerResources = snapshot.eagerResources;
    route.eagerResources = snapshot.eagerResources;
  }
  setupBlocking(route, wrappedResult, t);
}

function setupBlocking(route: ActivatedRoute, resourceResult: any, t: NavigationTransition) {
  const childInjector = route._resourceInjector;
  if (!childInjector || !resourceResult) return;

  for (const res of Object.values<any>(resourceResult)) {
    if (!res[NON_BLOCKING_SYMBOL]) {
      const promise = new Promise<void>((resolve, reject) => {
        const underlyingRes = (res as any)[SOURCE_RESOURCE_SYMBOL] || res;
        let isDestroyed = false;

        const e = effect(
          () => {
            if (isDestroyed) return;
            const status = underlyingRes.status();
            if (status === 'error') {
              reject(underlyingRes.error());
              e.destroy();
            } else if (status !== 'idle' && status !== 'loading' && status !== 'reloading') {
              // Resolve and cleanup effect
              resolve();
              e.destroy();
            }
          },
          {injector: childInjector, manualCleanup: true},
        );

        childInjector.get(DestroyRef).onDestroy(() => {
          isDestroyed = true;
          resolve();
          e.destroy();
        });
      });
      t.blockingResources!.push(promise);
    }
  }
}
