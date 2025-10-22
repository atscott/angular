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
  makeEnvironmentProviders,
  Signal,
  Type,
  ɵWritable as Writable,
} from '@angular/core';

import {Route, MaybeAsync, GuardResult} from './models';
import {provideRouter, RouterFeatures, withRouterConfig} from './provide_router';
import {Router} from './router';
import {ActivatedRoute, ActivatedRouteSnapshot, RouterStateSnapshot} from './router_state';
import {ParamMap, Params} from './shared';
import {toSignal} from '@angular/core/rxjs-interop';

export interface Register {}
export type RegisteredRouter<TRegister = Register> = TRegister extends {
  router: infer TRouter;
}
  ? TRouter
  : AnyRouter;

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
          ? TChildren extends ReadonlyArray<TypedRoute>
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

export type TypedRootRoute<TChildren = unknown> = TypedRouteBuilder<
  '',
  {},
  {},
  {},
  {},
  {},
  TChildren
>;

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
export type AnyRoute = TypedRoute<any, any, any, any, any, any>;

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

type CanActivateChildFn<
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

export type Constrain<T, TConstraint, TDefault = TConstraint> =
  | (T extends TConstraint ? T : never)
  | TDefault;

export type RouteAddChildrenFn<
  TPath extends string,
  TParentParams extends Record<string, unknown>,
  TParentData extends Record<string, unknown>,
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
  TResolve extends Record<string, unknown>,
> = <const TNewChildren>(
  children: Constrain<TNewChildren, ReadonlyArray<AnyRoute>>,
) => TypedRouteBuilder<TPath, TParentParams, TParentData, TParams, TData, TResolve, TNewChildren>;

class TypedRouteBuilder<
  TPath extends string,
  TParentParams extends Record<string, unknown>,
  TParentData extends Record<string, unknown>,
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
  TResolve extends Record<string, unknown>,
  TChildren = unknown,
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
  public canActivateChild?: CanActivateChildFn<TParentParams & TParams, TParentData & TData>[];
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

  addChildren: RouteAddChildrenFn<TPath, TParentParams, TParentData, TParams, TData, TResolve> = (
    children,
  ) => {
    (this as Writable<this>).children = children as any;
    return this as any;
  };

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
  TResolvers extends ResolverMap<
    (TParentRoute extends TypedRoute ? RouteParams<TParentRoute> : {}) & PathParams<TPath>,
    (TParentRoute extends TypedRoute ? ResolvedData<TParentRoute> : {}) & TData
  >,
  TComponent,
>(
  route: {
    path: TPath;
    getParentRoute?: () => TParentRoute;
    data?: TData;
    resolve?: TResolvers;
    component?: Type<TComponent>;
    canActivate?: CanActivateFn<
      (TParentRoute extends TypedRoute ? RouteParams<TParentRoute> : {}) & PathParams<TPath>,
      (TParentRoute extends TypedRoute ? ResolvedData<TParentRoute> : {}) &
        TData & {[K in keyof TResolvers]: ReturnType<TResolvers[K]>}
    >[];
    canActivateChild?: CanActivateChildFn<
      (TParentRoute extends TypedRoute ? RouteParams<TParentRoute> : {}) & PathParams<TPath>,
      (TParentRoute extends TypedRoute ? ResolvedData<TParentRoute> : {}) &
        TData & {[K in keyof TResolvers]: ReturnType<TResolvers[K]>}
    >[];
    canDeactivate?: CanDeactivateFn<
      TComponent,
      TParentRoute extends TypedRoute ? RouteParams<TParentRoute> : {},
      (TParentRoute extends TypedRoute ? ResolvedData<TParentRoute> : {}) &
        TData & {[K in keyof TResolvers]: ReturnType<TResolvers[K]>}
    >[];
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
    | 'canActivateChild'
    | 'canDeactivate'
  >,
): TypedRouteBuilder<
  TPath,
  TParentRoute extends TypedRoute ? RouteParams<TParentRoute> : {},
  TParentRoute extends TypedRoute ? ResolvedData<TParentRoute> : {},
  PathParams<TPath>,
  TData,
  {[K in keyof TResolvers]: ReturnType<TResolvers[K]>},
  never
> {
  return new TypedRouteBuilder(route as any);
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
): TypedRootRoute {
  // The root route has an empty path.
  return new TypedRouteBuilder({path: '', ...route}) as any;
}

export function provideTypedRouter<TRootRoute extends AnyRoute = RegisteredRouter['routeTree']>(
  route: TRootRoute,
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
export class TypedRouter<TRouteTree extends AnyRoute> {
  private router = inject(Router);
  routeTree = this.router.config[0] as TRouteTree;

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
export type AnyRouter = TypedRouter<AnyRoute>;

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
  /** A signal of the static and resolved data of this route. */
  readonly data: Signal<ResolvedData<TRoute>>;
  /** A signal of the matrix parameters scoped to this route. */
  readonly params: Signal<RouteParams<TRoute>>;
  /** A signal of the query parameters available to this route. */
  readonly queryParams: Signal<Params>;
  /** A signal of the URL fragment available to this route. */
  readonly fragment: Signal<string | null>;
  /** A signal of a map of the matrix parameters scoped to this route. */
  readonly paramMap: Signal<
    ParamMap & {get<K extends keyof RouteParams<TRoute>>(name: K): RouteParams<TRoute>[K] | null}
  >;

  /** A signal of a map of the query parameters available to this route. */
  readonly queryParamMap: Signal<ParamMap>;

  constructor(public readonly route: ActivatedRoute) {
    this.data = toSignal(this.route.data as any, {requireSync: true});
    this.params = toSignal(this.route.params as any, {requireSync: true});
    this.queryParams = toSignal(this.route.queryParams, {requireSync: true});
    this.fragment = toSignal(this.route.fragment, {requireSync: true});
    this.paramMap = toSignal(this.route.paramMap as any, {requireSync: true});
    this.queryParamMap = toSignal(this.route.queryParamMap, {requireSync: true});
  }

  // Expose snapshot for convenience, already typed.
  get snapshot(): SnapshotFromTypedRoute<TRoute> {
    return this.route.snapshot as SnapshotFromTypedRoute<TRoute>;
  }
}

export function injectTypedRouter(): TypedRouter<RegisteredRouter['routeTree']> {
  return inject(TypedRouter<RegisteredRouter['routeTree']>);
}

export function injectTypedRoute<
  TRouteTree extends TypedRoute = RegisteredRouter['routeTree'],
  TPath extends AllPaths<TRouteTree> = AllPaths<TRouteTree>,
>(_path: TPath): TypedActivatedRoute<RouteForPath<TRouteTree, TPath>> {
  const route = inject(ActivatedRoute);
  return new TypedActivatedRoute(route);
}
