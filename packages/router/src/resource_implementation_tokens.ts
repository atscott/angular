/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  EffectRef,
  EnvironmentInjector,
  InjectionToken,
  Injector,
  Resource,
  Type,
} from '@angular/core';
import {Title} from '@angular/platform-browser';
import {OperatorFunction} from 'rxjs';
import {NavigationTransition} from './navigation_transition';
import {ResourceFeatureKind} from './operators/setup_and_run_resources';
import {ActivatedRoute, ActivatedRouteSnapshot, RouterState} from './router_state';
import type {TitleStrategy} from './page_title_strategy';

export interface RouterResourcesFeatureImplementation {
  operator(
    kind?: ResourceFeatureKind,
  ): OperatorFunction<NavigationTransition, NavigationTransition>;
  waitForBlocking(
    injector: EnvironmentInjector,
  ): OperatorFunction<NavigationTransition, NavigationTransition>;
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
  /**
   * Syncs a lazily loaded component to the corresponding `ActivatedRoute` in the target router state.
   * This is required because the target router state is created early in the navigation pipeline
   * (before component loading) to allow eager resources to begin fetching immediately.
   */
  syncComponent(
    loadedComponent: Type<unknown>,
    targetRouterState: RouterState | null,
    route: ActivatedRouteSnapshot,
  ): void;
}

export const ROUTER_RESOURCES_FEATURE = new InjectionToken<RouterResourcesFeatureImplementation>(
  typeof ngDevMode === 'undefined' || ngDevMode ? 'Router Resources Feature' : '',
);
