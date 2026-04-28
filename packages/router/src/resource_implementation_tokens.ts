/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {ComponentRef, EffectRef, InjectionToken, Injector, Resource} from '@angular/core';
import {Title} from '@angular/platform-browser';
import {OperatorFunction} from 'rxjs';
import {NavigationTransition} from './navigation_transition';

import {ActivatedRoute} from './router_state';
import type {TitleStrategy} from './page_title_strategy';

export interface RouterResourcesFeatureImplementation {
  operator(abortSignal: AbortSignal): OperatorFunction<NavigationTransition, NavigationTransition>;
  createResourceEffects?: (
    componentRef: ComponentRef<unknown>,
    route: ActivatedRoute,
    injector: Injector,
  ) => {effects: EffectRef[]; handledKeys: string[]};
  titleRunner: (
    titleResource: Resource<unknown>,
    titleService: Title,
    injector: Injector,
  ) => EffectRef;
  /**
   * Initializes an `ActivatedRoute` with the necessary router resources infrastructure.
   * This is required because `ActivatedRoute` is created before the router's lazy-loading phase,
   * so it needs to be explicitly wired up with the resource execution context.
   */
  initializeActivatedRoute: (route: ActivatedRoute) => void;
  /**
   * Initializes the `TitleStrategy` with the necessary router resources infrastructure.
   * This is required because `TitleStrategy` is created before the router's lazy-loading phase,
   * so it needs to be explicitly wired up with the resource execution context.
   */
  initializeTitleStrategy: (strategy: TitleStrategy) => void;
}

export const ROUTER_RESOURCES_FEATURE = new InjectionToken<RouterResourcesFeatureImplementation>(
  typeof ngDevMode === 'undefined' || ngDevMode ? 'Router Resources Feature' : '',
);
