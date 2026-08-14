/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {ComponentRef, EffectRef, InjectionToken, Injector} from '@angular/core';
import {OperatorFunction} from 'rxjs';
import {NavigationTransition} from './navigation_transition';

import {ActivatedRoute} from './router_state';

export interface RouterResourcesFeatureImplementation {
  operator(abortSignal: AbortSignal): OperatorFunction<NavigationTransition, NavigationTransition>;
  createResourceOutletBindingEffects?: (
    componentRef: ComponentRef<unknown>,
    route: ActivatedRoute,
    injector: Injector,
  ) => {effects: EffectRef[]; handledKeys: string[]};
  /**
   * Initializes an `ActivatedRoute` with the necessary router resources infrastructure.
   * This is required because `ActivatedRoute` is created before the router's lazy-loading phase,
   * so it needs to be explicitly wired up with the resource execution context.
   */
  initializeActivatedRoute: (route: ActivatedRoute) => void;
}

export const ROUTER_RESOURCES_FEATURE = new InjectionToken<RouterResourcesFeatureImplementation>(
  typeof ngDevMode === 'undefined' || ngDevMode ? 'Router Resources Feature' : '',
);
