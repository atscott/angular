/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {EnvironmentInjector, effect} from '@angular/core';
import {from, of, OperatorFunction} from 'rxjs';
import {switchMap} from 'rxjs/operators';
import {NavigationTransition} from '../navigation_transition';
import {ActivatedRouteSnapshot} from '../router_state';
import {TreeNode} from '../utils/tree';
import {BLOCKING_SYMBOL} from '../router_resource';
import {RouterResource} from '../router_resource';

export function waitForBlockingResources(
  injector: EnvironmentInjector,
): OperatorFunction<NavigationTransition, NavigationTransition> {
  return switchMap((transition) => {
    const {targetSnapshot, blockingResources} = transition;
    if (!targetSnapshot) {
      return of(transition);
    }

    const allBlockingPromises: Promise<unknown>[] = [...(blockingResources ?? [])];
    const traverse = (node: TreeNode<ActivatedRouteSnapshot>) => {
      const resourceResult = node.value.resourceResult;
      if (resourceResult) {
        for (const value of Object.values(resourceResult)) {
          if ((value as any)?.[BLOCKING_SYMBOL]) {
            allBlockingPromises.push(
              createBlockingPromise(injector, value as RouterResource<unknown, unknown>),
            );
          }
        }
      }
      for (const child of node.children) {
        traverse(child);
      }
    };

    traverse(targetSnapshot._root);

    if (allBlockingPromises.length === 0) {
      return of(transition);
    }

    return from(Promise.all(allBlockingPromises).then(() => transition));
  });
}

function createBlockingPromise(
  injector: EnvironmentInjector,
  value: RouterResource<unknown, unknown>,
) {
  return new Promise((resolve, reject) => {
    const e = effect(
      () => {
        const status = value._pendingStatus();
        if (status === 'resolved' || status === 'error') {
          e.destroy();
          if (status === 'error') {
            // In the case of an error, we want to throw it to the navigation
            // pipeline so it can be handled by the router's error handler.
            reject(value._pendingError()!);
          }
          resolve(void 0);
        }
      },
      {injector},
    );
  });
}
