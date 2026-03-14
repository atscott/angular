/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  createEnvironmentInjector,
  EnvironmentInjector,
  runInInjectionContext,
  effect,
  ResourceStatus,
  signal,
  WritableSignal,
} from '@angular/core';
import {from, of, OperatorFunction} from 'rxjs';
import {switchMap} from 'rxjs/operators';
import {importProvidersFrom} from '@angular/core';
import {ResourceContext} from '../models';
import {NavigationTransition} from '../navigation_transition';
import {ActivatedRoute, ActivatedRouteSnapshot} from '../router_state';
import {TreeNode} from '../utils/tree';
import {BLOCKING_SYMBOL, REAL_RESOURCE_SYMBOL} from '../router_resource';

export function setupAndRunResources(
  resourceKey: 'resources' | 'eagerResources' = 'resources',
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
      if (route && route.routeConfig?.[resourceKey]) {
        if (newlyCreatedRoutes.has(route)) {
          // This route is new. We need to run its resources function once.
          routesToProcess.push(runResources((route as any)._futureSnapshot, route, t, resourceKey));
        } else {
          // This route is reused. We must eagerly update the resource context signals
          // so that resources can react and fetch new data during the pending navigation.
          const resourceSignals = (route as any)._resourceContextSignals;
          if (resourceSignals) {
            const futureSnapshot = (route as any)._futureSnapshot;
            resourceSignals.params.set(futureSnapshot.params);
            resourceSignals.queryParams.set(futureSnapshot.queryParams);
            resourceSignals.fragment.set(futureSnapshot.fragment);
            resourceSignals.data.set(futureSnapshot.data);
            futureSnapshot.resourceResult = route.snapshot?.resourceResult;
            setupBlocking(route, futureSnapshot.resourceResult, t);

            // Allow the resource's zoneless effect to react to the new parameters
            // and transition to 'reloading' before `waitForBlockingResources` checks its status.
            routesToProcess.push(new Promise((r) => setTimeout(r)));
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
  resourceKey: 'resources' | 'eagerResources',
) {
  try {
    const resourcesFn = snapshot?.routeConfig?.[resourceKey];
    if (!resourcesFn) return;
    const parentInjector = (snapshot as any)?._environmentInjector;
    if (!parentInjector) {
      console.error('Resource skipped: parentInjector is undefined for route:', route.routeConfig);
      return;
    }

    let resourceResult: any;
    let childInjector = (route as any)._resourceInjector;
    let contextSignals = (route as any)._resourceContextSignals;

    if (!childInjector) {
      childInjector = createEnvironmentInjector([], parentInjector);
      (route as any)._resourceInjector = childInjector; // Attach to route for cleanup

      contextSignals = {
        params: signal(snapshot.params),
        queryParams: signal(snapshot.queryParams),
        fragment: signal(snapshot.fragment),
        data: signal(snapshot.data),
      };
      (route as any)._resourceContextSignals = contextSignals;
    }

    const context: ResourceContext = contextSignals;

    resourceResult = runInInjectionContext(childInjector, () => resourcesFn(context));
    if (resourceResult instanceof Promise) {
      resourceResult = await resourceResult;
    }

    if (resourceResult) {
      snapshot.resourceResult = {...snapshot.resourceResult, ...resourceResult};
      route._futureSnapshot.resourceResult = snapshot.resourceResult;
      setupBlocking(route, resourceResult, t);
    }
  } catch (e) {
    console.error('Error in runResources:', e);
  }
}

function setupBlocking(route: ActivatedRoute, resourceResult: any, t: NavigationTransition) {
  const childInjector = (route as any)._resourceInjector as EnvironmentInjector;
  if (!childInjector || !resourceResult) return;

  for (const key of Object.keys(resourceResult)) {
    const res = resourceResult[key];
    if ((res as any)[BLOCKING_SYMBOL]) {
      t.blockingResources!.push(
        runInInjectionContext(childInjector, () => {
          return new Promise<void>((resolve, reject) => {
            const underlyingRes = (res as any)[REAL_RESOURCE_SYMBOL] || res;
            const e = effect(() => {
              const status = (underlyingRes.status as unknown as () => string)();
              if (status === 'error') {
                reject(underlyingRes.error());
                e.destroy();
              } else if (status !== 'idle' && status !== 'loading' && status !== 'reloading') {
                // Resolve and cleanup effect
                resolve();
                e.destroy();
              }
            });
          });
        }),
      );
    }
  }
}
