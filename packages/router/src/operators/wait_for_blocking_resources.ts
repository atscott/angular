/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {EnvironmentInjector, runInInjectionContext} from '@angular/core';
import {from, OperatorFunction} from 'rxjs';
import {map, switchMap} from 'rxjs/operators';
import {NavigationTransition} from '../navigation_transition';
import {InjectionToken} from '@angular/core';

export const WAIT_FOR_BLOCKING_RESOURCES_OPERATOR = new InjectionToken<
  typeof waitForBlockingResources
>(ngDevMode ? 'Wait For Blocking Resources Operator' : '', {
  factory: () => () => (t$) => t$,
});

export function waitForBlockingResources(
  injector: EnvironmentInjector,
): OperatorFunction<NavigationTransition, NavigationTransition> {
  return switchMap((t) => {
    if (!t.blockingResources || t.blockingResources.length === 0) {
      return from([t]);
    }
    return from(
      runInInjectionContext(injector, () => Promise.all(t.blockingResources!)).then(() => t),
    );
  });
}
