/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {createEnvironmentInjector, EnvironmentInjector, runInInjectionContext} from '@angular/core';
import {from, of, OperatorFunction} from 'rxjs';
import {switchMap} from 'rxjs/operators';
import {ResourceContext} from '../models';
import {NavigationTransition} from '../navigation_transition';
import {ActivatedRoute, ActivatedRouteSnapshot} from '../router_state';
import {TreeNode} from '../utils/tree';

export function setupAndRunResources(): OperatorFunction<
  NavigationTransition,
  NavigationTransition
> {
  return switchMap((t) => {
    const {newlyCreatedRoutes, targetRouterState} = t;
    if (!newlyCreatedRoutes || !targetRouterState) {
      return of(t);
    }

    const routesToProcess: Array<Promise<void>> = [];
    t.blockingResources = [];

    const traverse = (stateNode: TreeNode<ActivatedRoute>) => {
      const route = stateNode.value;
      route._setPending(route._futureSnapshot);
      if (route && route._futureSnapshot.routeConfig?.resources) {
        if (newlyCreatedRoutes.has(route)) {
          // This route is new. We need to run its resources function once.
          routesToProcess.push(runResources(route._futureSnapshot, route));
        } else if (route.resources) {
          route._futureSnapshot.resourceResult = route.resources as any;
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

async function runResources(snapshot: ActivatedRouteSnapshot, route: ActivatedRoute) {
  const resourcesFn = snapshot.routeConfig!.resources!;
  const parentInjector = snapshot._environmentInjector;
  const childInjector = createEnvironmentInjector([], parentInjector);
  route._resourceInjector = childInjector;
  const context: ResourceContext = {
    params: route.paramsSignal,
    queryParams: route.queryParamsSignal,
    fragment: route.fragmentSignal,
    data: route.dataSignal,
  };

  const resourceResult = await runInInjectionContext(childInjector, () => resourcesFn(context));
  for (const [key, value] of Object.entries(resourceResult)) {
    snapshot.resourceResult ??= {};
    value.init(route.pending);
    snapshot.resourceResult[key] = value;
  }
}
