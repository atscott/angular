/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  EnvironmentProviders,
  inject,
  Injectable,
  InjectionToken,
  makeEnvironmentProviders,
  Signal,
  Type,
  ɵWritable as Writable,
} from '@angular/core';
import {Observable} from 'rxjs';

import {Route, MaybeAsync, GuardResult} from './models';
import {provideRouter, RouterFeatures, withRouterConfig} from './provide_router';
import {Router} from './router';
import {ActivatedRoute, ActivatedRouteSnapshot, RouterStateSnapshot} from './router_state';
import {ParamMap, Params} from './shared';
import {toSignal} from '@angular/core/rxjs-interop';

type JoinPaths<A extends string, B extends string> = B extends ''
  ? A extends ''
    ? '/'
    : A
  : A extends ''
    ? `/${B}`
    : A extends '/'
      ? `/${B}`
      : `${A}/${B}`;

type RouteInfo<
  TRoute extends TypedRoute,
  TParentPath extends string = '',
  TParentParams extends Record<string, unknown> = {},
> =
  TRoute extends TypedRouteBuilder<infer TPath, any, any, any, any, any, infer TChildren>
    ? {
        route: TRoute;
        path: TPath;
        fullPath: JoinPaths<TParentPath, TPath>;
        params: TParentParams & PathParams<TPath>;
        children: TChildren;
      }
    : never;

type AllRouteInfos<
  TRoute extends TypedRoute,
  TParentPath extends string = '',
  TParentParams extends Record<string, unknown> = {},
> = TRoute extends any // Distribute over union
  ?
      | RouteInfo<TRoute, TParentPath, TParentParams>
      | (RouteInfo<TRoute, TParentPath, TParentParams> extends {
          children: infer TChildren;
          fullPath: infer TFullPath extends string;
          params: infer TParams extends Record<string, unknown>;
        }
          ? TChildren extends TypedRoute[]
            ? AllRouteInfos<TChildren[number], TFullPath, TParams>
            : TChildren extends Record<string, TypedRoute>
              ? AllRouteInfos<TChildren[keyof TChildren], TFullPath, TParams>
              : never
          : never)
  : never;

export type AllPaths<TRouteTree extends TypedRoute> = AllRouteInfos<TRouteTree>['fullPath'];

export type ParamsForPath<TRouteTree extends TypedRoute, TPath extends string> = Extract<
  AllRouteInfos<TRouteTree>,
  {fullPath: TPath}
>['params'];

type RouteForPath<TRouteTree extends TypedRoute, TPath extends string> = Extract<
  AllRouteInfos<TRouteTree>,
  {fullPath: TPath}
>['route'];

export type TypedRootRoute<
  TData extends Record<string, unknown> = {},
  TResolve extends Record<string, unknown> = {},
  TChildren extends TypedRoute[] | Record<string, TypedRoute> = never,
> = TypedRouteBuilder<'', {}, {}, {}, TData, TResolve, TChildren>;

export interface TypedRoute<
  TPath extends string = string,
  TParentParams extends Record<string, unknown> = {},
  TParentData extends Record<string, unknown> = {},
  TParams extends Record<string, unknown> = {},
  TData extends Record<string, unknown> = {},
  TResolved extends Record<string, unknown> = {},
> extends Route {
  type?: {
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
  T extends TypedRoute<string, any, infer TParentData, any, infer TData, infer TResolved>
    ? TParentData & TData & TResolved
    : {};

export type TypedActivatedRouteSnapshot<
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
> = Omit<ActivatedRouteSnapshot, 'params' | 'data'> & {
  params: TParams;
  data: TData;
};

type CanActivateFn<
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
> = (
  route: TypedActivatedRouteSnapshot<TParams, TData>,
  state: RouterStateSnapshot,
) => MaybeAsync<GuardResult>;

type CanDeactivateFn<
  T,
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
> = (
  component: T,
  currentRoute: TypedActivatedRouteSnapshot<TParams, TData>,
  currentState: RouterStateSnapshot,
  nextState?: RouterStateSnapshot,
) => MaybeAsync<GuardResult>;

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
  TChildren extends TypedRoute[] | Record<string, TypedRoute> = never,
> implements TypedRoute<TPath, TParentParams, TParentData, TParams, TData, TResolve>
{
  public parent?: TypedRoute;
  public path: TPath;
  public getParentRoute?: () => TypedRoute | undefined;
  public data?: TData;
  public resolve?: ResolverMap<TParentParams & TParams, TParentData & TData>;
  public children?: Route[];
  public load?: () => Promise<any>;
  public canActivate?: CanActivateFn<TParentParams & TParams, TParentData & TData>[];
  public canDeactivate?: CanDeactivateFn<any, TParentParams & TParams, TParentData & TData>[];
  type?: {
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
  }

  addCanActivate(
    guards: CanActivateFn<TParentParams & TParams, TParentData & TData>[],
  ): TypedRouteBuilder<TPath, TParentParams, TParentData, TParams, TData, TResolve, TChildren> {
    (this as Writable<this>).canActivate = [...(this.canActivate ?? []), ...guards];
    return this;
  }

  addCanDeactivate<TComponent>(
    guards: CanDeactivateFn<TComponent, TParentParams & TParams, TParentData & TData>[],
  ): TypedRouteBuilder<TPath, TParentParams, TParentData, TParams, TData, TResolve, TChildren> {
    (this as Writable<this>).canDeactivate = [...(this.canDeactivate ?? []), ...guards];
    return this;
  }

  setResolvers<TNewResolvers extends ResolverMap<TParentParams & TParams, TParentData & TData>>(
    resolvers: TNewResolvers,
  ): TypedRouteBuilder<
    TPath,
    TParentParams,
    TParentData,
    TParams,
    TData,
    {[K in keyof TNewResolvers]: ReturnType<TNewResolvers[K]>},
    TChildren
  > {
    (this as Writable<this>).resolve = resolvers;
    return this as any;
  }

  addChildren<const TNewChildren extends TypedRoute[]>(
    children: TNewChildren,
  ): TypedRouteBuilder<TPath, TParentParams, TParentData, TParams, TData, TResolve, TNewChildren> {
    (this as Writable<this>).children = children as any;
    for (const child of this.children!) {
      (child as any).parent = this;
    }
    return this as any;
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
    TResolve & {[K in keyof TLoadResolve]: ReturnType<TLoadResolve[K]>},
    TChildren
  > {
    (this as Writable<this>).load = loader;
    return this as any;
  }
}

export function createRoute<
  TPath extends string,
  TParentRoute extends TypedRoute | undefined,
  TData extends Record<string, unknown>,
  TComponent,
>(
  route: {
    path: TPath;
    getParentRoute?: () => TParentRoute;
    data?: TData;
    component?: Type<TComponent>;
  } & Omit<
    Route,
    | 'path'
    | 'data'
    | 'resolve'
    | 'children'
    | 'loadChildren'
    | 'load'
    | 'component'
    | 'canActivate'
    | 'canDeactivate'
  >,
): TypedRouteBuilder<
  TPath,
  TParentRoute extends TypedRoute ? RouteParams<TParentRoute> : {},
  TParentRoute extends TypedRoute ? ResolvedData<TParentRoute> : {},
  PathParams<TPath>,
  TData,
  {},
  never
> {
  return new TypedRouteBuilder(route);
}

export function createRootRoute<TData extends Record<string, unknown> = {}>(
  route: Omit<
    Route,
    | 'path'
    | 'component'
    | 'data'
    | 'resolve'
    | 'children'
    | 'loadChildren'
    | 'load'
    | 'getParentRoute'
  > & {
    data?: TData;
  } = {},
): TypedRootRoute<TData, {}, never> {
  // The root route has an empty path.
  return new TypedRouteBuilder({path: '', ...route}) as any;
}

export function provideTypedRouter(
  route: TypedRootRoute<any, any>,
  ...features: RouterFeatures[]
): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideRouter(
      [route as Route],
      withRouterConfig({
        paramsInheritanceStrategy: 'always',
      }),
      ...features,
    ),
  ]);
}

@Injectable({providedIn: 'root'})
export class TypedRouter<TRouteTree extends TypedRoute> {
  private router = inject(Router);

  navigate<TPath extends AllPaths<TRouteTree>>(
    path: TPath,
    params: TPath extends AllPaths<TRouteTree> ? ParamsForPath<TRouteTree, TPath> : never,
    extras?: {queryParams?: Record<string, unknown>; hash?: string},
  ): Promise<boolean> {
    const pathSegments = (path as string).split('/');
    const commands: any[] = [];
    for (const segment of pathSegments) {
      if (segment.startsWith(':')) {
        const paramName = segment.substring(1);
        commands.push((params as any)[paramName]);
      } else {
        commands.push(segment);
      }
    }

    return this.router.navigate(commands, {
      queryParams: extras?.queryParams,
      fragment: extras?.hash,
    });
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
    this.data = toSignal(this.data$, {requireSync: true});
    this.params$ = this.route.params as any;
    this.params = toSignal(this.params$, {requireSync: true});
    this.queryParams$ = this.route.queryParams;
    this.queryParams = toSignal(this.queryParams$, {requireSync: true});
    this.fragment$ = this.route.fragment;
    this.fragment = toSignal(this.fragment$, {requireSync: true});
    this.paramMap$ = this.route.paramMap as any;
    this.paramMap = toSignal(this.paramMap$, {requireSync: true});
    this.queryParamMap$ = this.route.queryParamMap;
    this.queryParamMap = toSignal(this.queryParamMap$, {requireSync: true});
  }

  // Expose snapshot for convenience, already typed.
  get snapshot(): SnapshotFromTypedRoute<TRoute> {
    return this.route.snapshot as SnapshotFromTypedRoute<TRoute>;
  }
}

export function injectTypedRoute<TRouteTree extends TypedRoute, TPath extends AllPaths<TRouteTree>>(
  _routeTree: TRouteTree, // for type inference
  _path: TPath,
): TypedActivatedRoute<RouteForPath<TRouteTree, TPath>> {
  const route = inject(ActivatedRoute);
  return new TypedActivatedRoute(route);
}
