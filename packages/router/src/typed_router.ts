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

import {Route as UntypedRoute, MaybeAsync, GuardResult} from './models';
import {
  provideRouter as provideUntypedRouter,
  RouterFeatures,
  withRouterConfig,
} from './provide_router';
import {Router as UntypedRouter} from './router';
import {
  ActivatedRoute as UntypedActivatedRoute,
  ActivatedRouteSnapshot as UntypedActivatedRouteSnapshot,
  RouterStateSnapshot,
} from './router_state';
import {ParamMap, Params} from './shared';
import {toSignal} from '@angular/core/rxjs-interop';
import {NavigationExtras} from './navigation_transition';

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

function joinPaths(a: string, b: string): string {
  if (b === '') {
    return a === '' ? '/' : a;
  }
  if (a === '') {
    return `/${b}`;
  }
  if (a === '/') {
    return `/${b}`;
  }
  return `${a}/${b}`;
}

type RouteInfo<
  TRoute extends Route,
  TParentPath extends string = '',
  TParentParams extends Record<string, unknown> = {},
> =
  TRoute extends BaseRoute<infer TPath, any, any, any, any, any, any, infer TChildren>
    ? {
        route: TRoute;
        path: TPath;
        fullPath: JoinPaths<TParentPath, TPath>;
        params: TParentParams & PathParams<TPath>;
        children: TChildren;
      }
    : never;

type AllRouteInfos<
  TRoute extends Route,
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
          ? TChildren extends ReadonlyArray<Route>
            ? AllRouteInfos<TChildren[number], TFullPath, TParams>
            : TChildren extends Record<string, Route>
              ? AllRouteInfos<TChildren[keyof TChildren], TFullPath, TParams>
              : never
          : never)
  : never;

export type AllPaths<TRouteTree extends Route> = AllRouteInfos<TRouteTree>['fullPath'];

export type ParamsForPath<TRouteTree extends Route, TPath extends string> = Extract<
  AllRouteInfos<TRouteTree>,
  {fullPath: TPath}
>['params'];

type RouteForPath<TRouteTree extends Route, TPath extends string> = Extract<
  AllRouteInfos<TRouteTree>,
  {fullPath: TPath}
>['route'];

export type RootRoute<TChildren = unknown> = BaseRoute<'', '/', {}, {}, {}, {}, {}, TChildren>;

export interface Route<
  TPath extends string = string,
  TFullPath extends string = string,
  TParentParams extends Record<string, unknown> = {},
  TParentData extends Record<string, unknown> = {},
  TParams extends Record<string, unknown> = {},
  TData extends Record<string, unknown> = {},
  TResolved extends Record<string, unknown> = {},
> extends UntypedRoute {
  fullPath: TFullPath;
  type?: {
    path: TPath;
    fullPath: TFullPath;
    parentParams: TParentParams;
    parentData: TParentData;
    params: TParams;
    data: TData;
    resolved: TResolved;
  };
}
export type AnyRoute = Route<any, any, any, any, any, any, any>;

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

export type RouteParams<T extends Route> =
  T extends Route<infer TPath, any, infer TParentParams, any, any, any, any>
    ? TParentParams & PathParams<TPath>
    : {};

export type ResolvedData<T extends Route | undefined> =
  T extends Route<string, string, any, infer TParentData, any, infer TData, infer TResolved>
    ? TParentData & TData & TResolved
    : {};

export type ActivatedRouteSnapshot<
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
> = Omit<UntypedActivatedRouteSnapshot, 'params' | 'data'> & {
  params: TParams;
  data: TData;
};

type CanActivateFn<
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
> = (
  route: ActivatedRouteSnapshot<TParams, TData>,
  state: RouterStateSnapshot,
) => MaybeAsync<GuardResult>;

type CanActivateChildFn<
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
> = (
  route: ActivatedRouteSnapshot<TParams, TData>,
  state: RouterStateSnapshot,
) => MaybeAsync<GuardResult>;

type CanDeactivateFn<
  T,
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
> = (
  component: T,
  currentRoute: ActivatedRouteSnapshot<TParams, TData>,
  currentState: RouterStateSnapshot,
  nextState?: RouterStateSnapshot,
) => MaybeAsync<GuardResult>;

type ResolverMap<
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
> = Record<
  string,
  (route: ActivatedRouteSnapshot<TParams, TData>, state: RouterStateSnapshot) => any
>;

export type Constrain<T, TConstraint, TDefault = TConstraint> =
  | (T extends TConstraint ? T : never)
  | TDefault;

export type RouteAddChildrenFn<
  TPath extends string,
  TFullPath extends string,
  TParentParams extends Record<string, unknown>,
  TParentData extends Record<string, unknown>,
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
  TResolve extends Record<string, unknown>,
> = <const TNewChildren>(
  children: Constrain<TNewChildren, ReadonlyArray<AnyRoute>>,
) => BaseRoute<
  TPath,
  TFullPath,
  TParentParams,
  TParentData,
  TParams,
  TData,
  TResolve,
  TNewChildren
>;

class BaseRoute<
  TPath extends string,
  TFullPath extends string,
  TParentParams extends Record<string, unknown>,
  TParentData extends Record<string, unknown>,
  TParams extends Record<string, unknown>,
  TData extends Record<string, unknown>,
  TResolve extends Record<string, unknown>,
  TChildren = unknown,
> implements Route<TPath, TFullPath, TParentParams, TParentData, TParams, TData, TResolve>
{
  public parent?: Route;
  public path: TPath;
  public fullPath: TFullPath;
  public getParentRoute?: () => Route | undefined;
  public data?: TData;
  public resolve?: ResolverMap<TParentParams & TParams, TParentData & TData>;
  public children?: UntypedRoute[];
  public load?: () => Promise<any>;
  public canActivate?: CanActivateFn<TParentParams & TParams, TParentData & TData>[];
  public canActivateChild?: CanActivateChildFn<TParentParams & TParams, TParentData & TData>[];
  public canDeactivate?: CanDeactivateFn<any, TParentParams & TParams, TParentData & TData>[];
  type?: {
    path: TPath;
    fullPath: TFullPath;
    parentParams: TParentParams;
    parentData: TParentData;
    params: TParams;
    data: TData;
    resolved: TResolve;
  };

  constructor(
    route: {
      path: TPath;
      getParentRoute?: () => Route | undefined;
      data?: TData;
    } & Omit<UntypedRoute, 'path' | 'data' | 'resolve' | 'children' | 'loadChildren' | 'load'>,
  ) {
    Object.assign(this, route);
    this.path = route.path;
    this.getParentRoute = route.getParentRoute;
    this.data = route.data;

    const parent = this.getParentRoute?.();
    const parentFullPath = parent?.fullPath ?? '';
    this.fullPath = joinPaths(parentFullPath, this.path) as TFullPath;
  }

  addChildren: RouteAddChildrenFn<
    TPath,
    TFullPath,
    TParentParams,
    TParentData,
    TParams,
    TData,
    TResolve
  > = (children) => {
    (this as Writable<this>).children = children as any;
    return this as any;
  };

  lazy<
    TLoadResolve extends Record<
      string,
      (
        route: ActivatedRouteSnapshot<TParentParams & TParams, TParentData & TData>,
        state: RouterStateSnapshot,
      ) => any
    >,
  >(
    loader: () => Promise<{component?: any; resolve?: TLoadResolve}>,
  ): BaseRoute<
    TPath,
    TFullPath,
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
  TParentRoute extends Route | undefined,
  TData extends Record<string, unknown>,
  TResolvers extends ResolverMap<
    (TParentRoute extends Route ? RouteParams<TParentRoute> : {}) & PathParams<TPath>,
    (TParentRoute extends Route ? ResolvedData<TParentRoute> : {}) & TData
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
      (TParentRoute extends Route ? RouteParams<TParentRoute> : {}) & PathParams<TPath>,
      (TParentRoute extends Route ? ResolvedData<TParentRoute> : {}) &
        TData & {[K in keyof TResolvers]: ReturnType<TResolvers[K]>}
    >[];
    canActivateChild?: CanActivateChildFn<
      (TParentRoute extends Route ? RouteParams<TParentRoute> : {}) & PathParams<TPath>,
      (TParentRoute extends Route ? ResolvedData<TParentRoute> : {}) &
        TData & {[K in keyof TResolvers]: ReturnType<TResolvers[K]>}
    >[];
    canDeactivate?: CanDeactivateFn<
      TComponent,
      TParentRoute extends Route ? RouteParams<TParentRoute> : {},
      (TParentRoute extends Route ? ResolvedData<TParentRoute> : {}) &
        TData & {[K in keyof TResolvers]: ReturnType<TResolvers[K]>}
    >[];
  } & Omit<
    UntypedRoute,
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
): BaseRoute<
  TPath,
  JoinPaths<TParentRoute extends Route<any, infer P> ? P : '', TPath>,
  TParentRoute extends Route ? RouteParams<TParentRoute> : {},
  TParentRoute extends Route ? ResolvedData<TParentRoute> : {},
  PathParams<TPath>,
  TData,
  {[K in keyof TResolvers]: ReturnType<TResolvers[K]>},
  never
> {
  return new BaseRoute(route as any) as any;
}

export function createRootRoute<TData extends Record<string, unknown> = {}>(
  route: Omit<
    UntypedRoute,
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
): RootRoute {
  // The root route has an empty path.
  return new BaseRoute({path: '', ...route}) as any;
}

export function provideRouter<TRootRoute extends AnyRoute = RegisteredRouter['routeTree']>(
  route: TRootRoute,
  ...features: RouterFeatures[]
): EnvironmentProviders {
  return makeEnvironmentProviders([
    provideUntypedRouter(
      [route as UntypedRoute],
      withRouterConfig({
        paramsInheritanceStrategy: 'always',
      }),
      ...features,
    ),
  ]);
}

@Injectable({providedIn: 'root'})
export class Router<TRouteTree extends AnyRoute> {
  private router = inject(UntypedRouter);
  routeTree = this.router.config[0] as TRouteTree;

  navigate<TPath extends AllPaths<TRouteTree>>(
    path: TPath,
    params: TPath extends AllPaths<TRouteTree> ? ParamsForPath<TRouteTree, TPath> : never,
    extras?: NavigationExtras,
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

    return this.router.navigate(commands, extras);
  }
}
export type AnyRouter = Router<AnyRoute>;

export type SnapshotFromRoute<TRoute extends Route> = Omit<
  UntypedActivatedRouteSnapshot,
  'params' | 'data'
> & {
  params: RouteParams<TRoute>;
  data: TRoute extends Route<any, any, any, infer TParentData, any, infer TData, infer TResolved>
    ? TParentData & TData & TResolved
    : {};
};

export class ActivatedRoute<TRoute extends Route> {
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

  constructor(public readonly route: UntypedActivatedRoute) {
    this.data = toSignal(this.route.data as any, {requireSync: true});
    this.params = toSignal(this.route.params as any, {requireSync: true});
    this.queryParams = toSignal(this.route.queryParams, {requireSync: true});
    this.fragment = toSignal(this.route.fragment, {requireSync: true});
    this.paramMap = toSignal(this.route.paramMap as any, {requireSync: true});
    this.queryParamMap = toSignal(this.route.queryParamMap, {requireSync: true});
  }

  // Expose snapshot for convenience, already typed.
  get snapshot(): SnapshotFromRoute<TRoute> {
    return this.route.snapshot as SnapshotFromRoute<TRoute>;
  }
}

export function injectRouter(): Router<RegisteredRouter['routeTree']> {
  return inject(Router<RegisteredRouter['routeTree']>);
}

export function injectRoute<
  TRouteTree extends Route = RegisteredRouter['routeTree'],
  TPath extends AllPaths<TRouteTree> = AllPaths<TRouteTree>,
>(_path: TPath): ActivatedRoute<RouteForPath<TRouteTree, TPath>> {
  const route = inject(UntypedActivatedRoute);
  return new ActivatedRoute(route);
}
