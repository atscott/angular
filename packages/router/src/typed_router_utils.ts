/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {Route} from './models';

export const typedRouteKey = Symbol('TypedRoute');

export function isTypedRoute(route: Route): boolean {
  // Note: This is not a type guard to avoid circular dependencies.
  return route && typedRouteKey in route;
}
