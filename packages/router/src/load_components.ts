/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {RouterConfigLoader} from './router_config_loader';
import {ActivatedRouteSnapshot} from './router_state';

/**
 * Loads all lazy components (`loadComponent`) in the given route tree.
 *
 * Returns `undefined` rather than an already-resolved promise when there is nothing to load so
 * that callers (notably the `switchTap` in the navigation pipeline) are not forced to wait for an
 * additional microtask.
 */
export function loadComponents(
  root: ActivatedRouteSnapshot,
  configLoader: RouterConfigLoader,
): Promise<void> | void {
  const loaders: Array<Promise<void>> = [];

  function collect(route: ActivatedRouteSnapshot): void {
    if (route.routeConfig?._loadedComponent) {
      route.component = route.routeConfig?._loadedComponent;
    } else if (route.routeConfig?.loadComponent) {
      const injector = route._environmentInjector;
      loaders.push(
        configLoader.loadComponent(injector, route.routeConfig).then((loadedComponent) => {
          route.component = loadedComponent;
        }),
      );
    }
    for (const child of route.children) {
      collect(child);
    }
  }

  collect(root);
  if (loaders.length === 0) {
    return;
  }
  return Promise.all(loaders).then(() => {});
}
