/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  Compiler,
  EnvironmentInjector,
  inject,
  Injectable,
  InjectionToken,
  Injector,
  NgModuleFactory,
  Type,
} from '@angular/core';
import {isObservable, firstValueFrom, Observable} from 'rxjs';

import {DefaultExport, LoadedRouterConfig, Route, Routes} from './models';
import {assertStandalone, validateConfig} from './utils/config';
import {standardizeConfig} from './components/empty_outlet';

/**
 * The DI token for a router configuration.
 *
 * `ROUTES` is a low level API for router configuration via dependency injection.
 *
 * We recommend that in almost all cases to use higher level APIs such as `RouterModule.forRoot()`,
 * `provideRouter`, or `Router.resetConfig()`.
 *
 * @publicApi
 */
export const ROUTES = new InjectionToken<Route[][]>(ngDevMode ? 'ROUTES' : '');

@Injectable({providedIn: 'root'})
export class RouterConfigLoader {
  // Update componentLoaders to store Promises
  private componentLoaders = new WeakMap<Route, Promise<Type<unknown>>>();
  // Update childrenLoaders to store Promises
  private childrenLoaders = new WeakMap<Route, Promise<LoadedRouterConfig>>();
  onLoadStartListener?: (r: Route) => void;
  onLoadEndListener?: (r: Route) => void;
  private readonly compiler = inject(Compiler);

  async loadComponent(route: Route): Promise<Type<unknown>> {
    const existingLoader = this.componentLoaders.get(route);
    if (existingLoader) {
      return existingLoader;
    }
    if (route._loadedComponent) {
      return route._loadedComponent;
    }

    const loaderPromise = loadComponentInternal(
      route,
      this.onLoadStartListener,
      this.onLoadEndListener,
    ).finally(() => {
      this.componentLoaders.delete(route);
    });

    this.componentLoaders.set(route, loaderPromise);
    return loaderPromise;
  }

  async loadChildren(parentInjector: Injector, route: Route): Promise<LoadedRouterConfig> {
    const existingLoader = this.childrenLoaders.get(route);
    if (existingLoader) {
      return existingLoader;
    }
    if (route._loadedRoutes && route._loadedInjector) {
      return {routes: route._loadedRoutes, injector: route._loadedInjector};
    }

    // The Route._loadedRoutes check is now inside loadChildrenInternal,
    // but this one is for already loaded (not pending) routes.
    // The one in loadChildrenInternal handles the case where it got loaded by another process
    // while this one was yielding.

    const loaderPromise = loadChildrenInternal(
      route,
      this.compiler,
      parentInjector,
      this.onLoadStartListener,
      this.onLoadEndListener,
    ).finally(() => {
      this.childrenLoaders.delete(route);
    });

    this.childrenLoaders.set(route, loaderPromise);
    return loaderPromise;
  }
}

async function loadComponentInternal(
  route: Route,
  onLoadStartListener?: (r: Route) => void,
  onLoadEndListener?: (r: Route) => void,
): Promise<Type<unknown>> {
  if (route._loadedComponent) {
    // Check if already loaded by another process
    return route._loadedComponent;
  }

  if (onLoadStartListener) {
    onLoadStartListener(route);
  }

  try {
    const loadedComponentInput = route.loadComponent!();
    const loadedComponent = await convertToPromiseInternal(loadedComponentInput);
    const unwrappedComponent = maybeUnwrapDefaultExport(loadedComponent);

    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      assertStandalone(route.path ?? '', unwrappedComponent);
    route._loadedComponent = unwrappedComponent;

    if (onLoadEndListener) {
      onLoadEndListener(route);
    }
    return unwrappedComponent;
  } catch (e) {
    if (onLoadEndListener) {
      onLoadEndListener(route);
    }
    throw e;
  }
}

/**
 * Executes a `route.loadChildren` callback and converts the result to an array of child routes and
 * an injector if that callback returned a module.
 */
export async function loadChildrenInternal(
  route: Route,
  compiler: Compiler,
  parentInjector: Injector,
  onLoadStartListener?: (r: Route) => void,
  onLoadEndListener?: (r: Route) => void,
): Promise<LoadedRouterConfig> {
  if (route._loadedRoutes && route._loadedInjector) {
    // Check if already loaded by another process
    return {routes: route._loadedRoutes, injector: route._loadedInjector};
  }

  if (onLoadStartListener) {
    onLoadStartListener(route);
  }

  try {
    const loadedChildInput = route.loadChildren!();
    const loadedChild = await convertToPromiseInternal(loadedChildInput);
    const unwrappedChild = maybeUnwrapDefaultExport(loadedChild);

    let factoryOrRoutes: NgModuleFactory<any> | Routes;
    if (unwrappedChild instanceof NgModuleFactory || Array.isArray(unwrappedChild)) {
      factoryOrRoutes = unwrappedChild;
    } else {
      factoryOrRoutes = await compiler.compileModuleAsync(unwrappedChild);
    }

    let injector: EnvironmentInjector | undefined;
    let rawRoutes: Route[];
    let requireStandaloneComponents = false;
    if (Array.isArray(factoryOrRoutes)) {
      rawRoutes = factoryOrRoutes;
      requireStandaloneComponents = true;
    } else {
      injector = factoryOrRoutes.create(parentInjector).injector;
      rawRoutes = injector.get(ROUTES, [], {optional: true, self: true}).flat();
    }
    const routes = rawRoutes.map(standardizeConfig);
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      validateConfig(routes, route.path, requireStandaloneComponents);

    // Cache on the route itself
    route._loadedRoutes = routes;
    route._loadedInjector = injector;

    if (onLoadEndListener) {
      onLoadEndListener(route);
    }
    return {routes, injector};
  } catch (e) {
    // Ensure listeners are called on error too, and rethrow
    if (onLoadEndListener) {
      onLoadEndListener(route);
    }
    throw e;
  }
}

async function convertToPromiseInternal<T>(value: T | Observable<T> | Promise<T>): Promise<T> {
  if (isObservable(value)) {
    return await firstValueFrom(value);
  }
  return await Promise.resolve(value);
}

function isWrappedDefaultExport<T>(value: T | DefaultExport<T>): value is DefaultExport<T> {
  // We use `in` here with a string key `'default'`, because we expect `DefaultExport` objects to be
  // dynamically imported ES modules with a spec-mandated `default` key. Thus we don't expect that
  // `default` will be a renamed property.
  return value && typeof value === 'object' && 'default' in value;
}

function maybeUnwrapDefaultExport<T>(input: T | DefaultExport<T>): T {
  // As per `isWrappedDefaultExport`, the `default` key here is generated by the browser and not
  // subject to property renaming, so we reference it with bracket access.
  return isWrappedDefaultExport(input) ? input['default'] : input;
}
