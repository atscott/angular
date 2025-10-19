/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {EnvironmentProviders, inject, Injectable, Signal} from '@angular/core';
import {Observable} from 'rxjs';

import {Route} from './models';
import {provideRouter, RouterFeatures, withRouterConfig} from './provide_router';
import {Router} from './router';
import {ActivatedRoute, ActivatedRouteSnapshot, RouterStateSnapshot} from './router_state';
import {ParamMap, Params} from './shared';
import {typedRouteKey} from './typed_router_utils';
import {toSignal} from '@angular/core/rxjs-interop';

export interface TypedRoute<
  TPath extends string = string,
  TParentParams extends Record<string, unknown> = {},
  TParentData extends Record<string, unknown> = {},
  TParams extends Record<string, unknown> = {},
  TData extends Record<string, unknown> = {},
  TResolved extends Record<string, unknown> = {},
> extends Route {
  [typedRouteKey]?: {
    path: TPath;
    parentParams: TParentParams;
    parentData: TParentData;
    params: TParams;
    data: TData;
    resolved: TResolved;
  };
}

export type PathParams<TPath extends string> =
  // Split the path by slashes
  TPath extends `${infer Pre}/${infer Post}`
    ? // For each part, check if it's a parameter
      PathParams<Pre> & PathParams<Post>
    : // If the part is a parameter, extract its name
      TPath extends `:${infer Param}`
      ? {[K in Param]: string}
      : // Otherwise, it's not a parameter
        {};

export type RouteParams<T extends TypedRoute> =
  T extends TypedRoute<infer TPath, infer TParentParams, any, any, any, any>
    ? TParentParams & PathParams<TPath>
    : {};

export type ResolvedData<T extends TypedRoute | undefined> =
  T extends TypedRoute<string, any, any, any, infer TData, infer TResolved>
    ? TData & TResolved
    : {};

export type TypedActivatedRouteSnapshot<
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
> = Omit<ActivatedRouteSnapshot, 'params' | 'data'> & {
  params: TParams;
  data: TData;
};

type ResolverMap<
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
> = Record<
  string,
  (route: TypedActivatedRouteSnapshot<TParams, TData>, state: RouterStateSnapshot) => any
>;

class TypedRouteBuilder<
  TPath extends string,
  TParentParams extends Record<string, unknown>,
  TParentData extends Record<string, unknown>,
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
  TResolve extends Record<string, unknown>,
> implements TypedRoute<TPath, TParentParams, TParentData, TParams, TData, TResolve>
{
  public path: TPath;
  public getParentRoute?: () => TypedRoute | undefined;
  public data?: TData;
  public resolve?: ResolverMap<TParentParams & TParams, TParentData & TData>;
  public children?: TypedRoute[];
  public load?: () => Promise<any>;
  [typedRouteKey]?: {
    path: TPath;
    parentParams: TParentParams;
    parentData: TParentData;
    params: TParams;
    data: TData;
    resolved: TResolve;
  };

  constructor(
    route: {
      path: TPath;
      getParentRoute?: () => TypedRoute | undefined;
      data?: TData;
    } & Omit<Route, 'path' | 'data' | 'resolve' | 'children' | 'loadChildren' | 'load'>,
  ) {
    Object.assign(this, route);
    this.path = route.path;
    this.getParentRoute = route.getParentRoute;
    this.data = route.data;
    (this as any)[typedRouteKey] = {};
  }

  addResolvers<TNewResolvers extends ResolverMap<TParentParams & TParams, TParentData & TData>>(
    resolvers: TNewResolvers,
  ): TypedRouteBuilder<
    TPath,
    TParentParams,
    TParentData,
    TParams,
    TData,
    TResolve & {[K in keyof TNewResolvers]: ReturnType<TNewResolvers[K]>}
  > {
    this.resolve = {...this.resolve, ...resolvers};
    return this as any;
  }

  addChildren(
    children: TypedRoute[] | Record<string, TypedRoute>,
  ): TypedRouteBuilder<TPath, TParentParams, TParentData, TParams, TData, TResolve> {
    if (Array.isArray(children)) {
      this.children = children;
    } else {
      this.children = Object.values(children);
    }

    return this;
  }

  lazy<
    TLoadResolve extends Record<
      string,
      (
        route: TypedActivatedRouteSnapshot<TParentParams & TParams, TParentData & TData>,
        state: RouterStateSnapshot,
      ) => any
    >,
  >(
    loader: () => Promise<{component?: any; resolve?: TLoadResolve}>,
  ): TypedRouteBuilder<
    TPath,
    TParentParams,
    TParentData,
    TParams,
    TData,
    TResolve & {[K in keyof TLoadResolve]: ReturnType<TLoadResolve[K]>}
  > {
    this.load = loader;
    return this as any;
  }
}

export function createRoute<
  TPath extends string,
  TParentRoute extends TypedRoute | undefined,
  TData extends Record<string, unknown>,
>(
  route: {
    path: TPath;
    getParentRoute?: () => TParentRoute;
    data?: TData;
  } & Omit<Route, 'path' | 'data' | 'resolve' | 'children' | 'loadChildren' | 'load'>,
): TypedRouteBuilder<
  TPath,
  TParentRoute extends TypedRoute ? RouteParams<TParentRoute> : {},
  TParentRoute extends TypedRoute ? ResolvedData<TParentRoute> : {},
  PathParams<TPath>,
  TData,
  {}
> {
  return new TypedRouteBuilder(route) as any;
}

export function provideTypedRouter(
  routes: TypedRoute[],
  ...features: RouterFeatures[]
): EnvironmentProviders {
  return provideRouter(
    routes as Route[],
    withRouterConfig({
      paramsInheritanceStrategy: 'always',
    }),
    ...features,
  );
}

@Injectable({providedIn: 'root'})
export class TypedRouter {
  private router = inject(Router);

  navigateByRoute<TRoute extends TypedRoute>(
    route: TRoute,
    params: RouteParams<TRoute>,
    extras?: {queryParams?: Record<string, unknown>; hash?: string},
  ): Promise<boolean> {
    const path = this.getResolvedPath(route, params);
    return this.router.navigateByUrl(path);
  }

  private getResolvedPath<TRoute extends TypedRoute>(
    route: TRoute,
    params: RouteParams<TRoute>,
  ): string {
    const path = route.path ?? '';
    const url = Object.entries(params).reduce((currentPath, [key, value]) => {
      return currentPath.replace(`:${key}`, value as string);
    }, path);

    const parent = (route as any).getParentRoute?.();
    if (parent) {
      return this.getResolvedPath(parent, params) + '/' + url;
    }
    return url;
  }
}

export type SnapshotFromTypedRoute<TRoute extends TypedRoute> = Omit<
  ActivatedRouteSnapshot,
  'params' | 'data'
> & {
  params: RouteParams<TRoute>;
  data: TRoute extends TypedRoute<any, any, infer TParentData, any, infer TData, infer TResolved>
    ? TParentData & TData & TResolved
    : {};
};

export class TypedActivatedRoute<TRoute extends TypedRoute> {
  /** An observable of the static and resolved data of this route. */
  readonly data$: Observable<ResolvedData<TRoute>>;
  /** A signal of the static and resolved data of this route. */
  readonly data: Signal<ResolvedData<TRoute>>;

  /** An observable of the matrix parameters scoped to this route. */
  readonly params$: Observable<RouteParams<TRoute>>;
  /** A signal of the matrix parameters scoped to this route. */
  readonly params: Signal<RouteParams<TRoute>>;

  /** An observable of the query parameters available to this route. */
  readonly queryParams$: Observable<Params>;
  /** A signal of the query parameters available to this route. */
  readonly queryParams: Signal<Params>;

  /** An observable of the URL fragment available to this route. */
  readonly fragment$: Observable<string | null>;
  /** A signal of the URL fragment available to this route. */
  readonly fragment: Signal<string | null>;

  /** An observable of a map of the matrix parameters scoped to this route. */
  readonly paramMap$: Observable<
    ParamMap & {get<K extends keyof RouteParams<TRoute>>(name: K): RouteParams<TRoute>[K] | null}
  >;
  /** A signal of a map of the matrix parameters scoped to this route. */
  readonly paramMap: Signal<
    ParamMap & {get<K extends keyof RouteParams<TRoute>>(name: K): RouteParams<TRoute>[K] | null}
  >;

  /** An observable of a map of the query parameters available to this route. */
  readonly queryParamMap$: Observable<ParamMap>;
  /** A signal of a map of the query parameters available to this route. */
  readonly queryParamMap: Signal<ParamMap>;

  constructor(public readonly route: ActivatedRoute) {
    this.data$ = this.route.data as any;
    this.data = toSignal(this.data$, {initialValue: {} as ResolvedData<TRoute>});
    this.params$ = this.route.params as any;
    this.params = toSignal(this.params$, {initialValue: {} as RouteParams<TRoute>});
    this.queryParams$ = this.route.queryParams;
    this.queryParams = toSignal(this.queryParams$, {initialValue: {}});
    this.fragment$ = this.route.fragment;
    this.fragment = toSignal(this.fragment$, {initialValue: null});
    this.paramMap$ = this.route.paramMap as any;
    this.paramMap = toSignal(this.paramMap$, {initialValue: {get: () => null} as any});
    this.queryParamMap$ = this.route.queryParamMap;
    this.queryParamMap = toSignal(this.queryParamMap$, {initialValue: {get: () => null} as any});
  }

  // Expose snapshot for convenience, already typed.
  get snapshot(): SnapshotFromTypedRoute<TRoute> {
    return this.route.snapshot as SnapshotFromTypedRoute<TRoute>;
  }
}

export function injectTypedRoute<TRoute extends TypedRoute>(
  _route: TRoute,
): TypedActivatedRoute<TRoute> {
  const route = inject(ActivatedRoute);
  // Memoize the wrapper on the ActivatedRoute instance.
  if (!route._typedRoute) {
    route._typedRoute = new TypedActivatedRoute(route);
  }
  return route._typedRoute as TypedActivatedRoute<TRoute>;
}
