import {
  EnvironmentProviders,
  inject,
  Injectable,
  makeEnvironmentProviders,
  Signal,
  Type,
  ɵWritable as Writable,
} from '@angular/core';
import {toSignal} from '@angular/core/rxjs-interop';

import {GuardResult, LoadChildrenCallback, MaybeAsync, Route as UntypedRoute} from './models';
import {NavigationExtras} from './navigation_transition';
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

type AddLeadingSlash<T> = T & `/${string}` extends never ? `/${T & string}` : T;
type RemoveTrailingSlashes<T> = T & `${string}/` extends never
  ? T
  : T extends `${infer R}/`
    ? R
    : T;
type RemoveLeadingSlashes<T> = T & `/${string}` extends never ? T : T extends `/${infer R}` ? R : T;

type JoinPath<TLeft extends string, TRight extends string> = TRight extends ''
  ? TLeft
  : TLeft extends ''
    ? TRight
    : `${RemoveTrailingSlashes<TLeft>}/${RemoveLeadingSlashes<TRight>}`;

type RemoveLastSegment<
  T extends string,
  TAcc extends string = '',
> = T extends `${infer TSegment}/${infer TRest}`
  ? TRest & `${string}/${string}` extends never
    ? TRest extends ''
      ? TAcc
      : `${TAcc}${TSegment}`
    : RemoveLastSegment<TRest, `${TAcc}${TSegment}/`>
  : TAcc;

type ResolveCurrentPath<TFrom extends string, TTo extends string> = TTo extends '.'
  ? TFrom
  : TTo extends './'
    ? TFrom
    : TTo & `./${string}` extends never
      ? never
      : TTo extends `./${infer TRest}`
        ? AddLeadingSlash<JoinPath<TFrom, TRest>>
        : never;
type ResolveParentPath<TFrom extends string, TTo extends string> = TTo extends '../' | '..'
  ? TFrom extends '' | '/'
    ? never
    : AddLeadingSlash<RemoveLastSegment<TFrom>>
  : TTo & `../${string}` extends never
    ? AddLeadingSlash<JoinPath<RemoveLastSegment<TFrom>, TTo>>
    : TFrom extends '' | '/'
      ? never
      : TTo extends `../${infer ToRest}`
        ? ResolveParentPath<RemoveLastSegment<TFrom>, ToRest>
        : AddLeadingSlash<JoinPath<RemoveLastSegment<TFrom>, TTo>>;

export type ResolveRelativePath<TFrom extends string, TTo = '.'> = string extends TFrom
  ? TTo
  : string extends TTo
    ? TFrom
    : undefined extends TTo
      ? TFrom
      : TTo extends string
        ? TFrom extends string
          ? TTo extends `/${string}`
            ? TTo
            : TTo extends `..${string}`
              ? ResolveParentPath<TFrom, TTo>
              : TTo extends `.${string}`
                ? ResolveCurrentPath<TFrom, TTo>
                : AddLeadingSlash<JoinPath<TFrom, TTo>>
          : never
        : never;

function resolvePath(from: string, to: string): string {
  if (to.startsWith('/')) {
    return to;
  }

  const fromParts = from.split('/').filter((p) => p);
  const toParts = to.split('/');

  // Remove the last segment of the `from` path if `to` starts with `..`
  if (to.startsWith('..')) {
    fromParts.pop();
  }

  for (const segment of toParts) {
    if (segment === '..') {
      fromParts.pop();
    } else if (segment !== '.' && segment !== '') {
      fromParts.push(segment);
    }
  }

  return '/' + fromParts.join('/');
}

export interface Register {}
export type RegisteredRouteMap<TRegister = Register> = TRegister extends {
  routeMap: infer TRouteMap;
}
  ? TRouteMap
  : Record<string, AnyRoute>;

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
export type AllPaths<TRouteMap extends Record<string, Route>> = keyof TRouteMap;

export type ParamsForPath<
  TRouteMap extends Record<string, Route>,
  TPath extends keyof TRouteMap,
> = AnyRoute extends TRouteMap[TPath] ? Record<string, any> : RouteParams<TRouteMap[TPath]>;

type RouteForPath<
  TRouteMap extends Record<string, Route>,
  TPath extends keyof TRouteMap,
> = AnyRoute extends TRouteMap[TPath] ? AnyRoute : TRouteMap[TPath];

export interface Route<
  TPath extends string = string,
  TFullPath extends string = string,
  TParentParams extends Record<string, unknown> = {},
  TParentData extends Record<string, unknown> = {},
  TData extends Record<string, unknown> = {},
  TResolved extends Record<string, unknown> = {},
> extends UntypedRoute {
  fullPath: TFullPath;
  // Note: this is a branding, not a real property
  type?: {
    path: TPath;
    fullPath: TFullPath;
    parentParams: TParentParams;
    parentData: TParentData;
    data: TData;
    resolved: TResolved;
  };
}
export type AnyRoute = Route<string, string, any, any, any, any>;

export type PathParams<TPath extends string> =
  // Split the path by slashes
  TPath extends `${infer Pre}/${infer Post}`
    ? // For each part, check if it's a parameter
      PathParams<Pre> & PathParams<Post>
    : // If the part is a parameter, extract its name
      TPath extends `:${infer Param}`
      ? {[K in Param]: string}
      : // Otherwise, it's not a parameter
        Record<never, never>;

export type RouteParams<T extends Route> =
  T extends Route<infer TPath, any, infer TParentParams, any, any, any>
    ? TParentParams & PathParams<TPath>
    : {};

export type ResolvedData<T extends Route | undefined> =
  T extends Route<string, string, any, infer TParentData, infer TData, infer TResolved>
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

class BaseRoute<
  TPath extends string,
  TFullPath extends string,
  TParentParams extends Record<string, unknown>,
  TParentData extends Record<string, unknown>,
  TData extends Record<string, unknown>,
  TResolve extends Record<string, unknown>,
> implements Route<TPath, TFullPath, TParentParams, TParentData, TData, TResolve>
{
  public parent?: Route;
  public path: TPath;
  public fullPath!: TFullPath;
  public getParentRoute?: () => Route | undefined;
  public data?: TData;
  public resolve?: ResolverMap<TParentParams & PathParams<TPath>, TParentData & TData>;
  public children?: UntypedRoute[];
  public loadChildren?: LoadChildrenCallback;
  public canActivate?: CanActivateFn<TParentParams & PathParams<TPath>, TParentData & TData>[];
  public canActivateChild?: CanActivateChildFn<
    TParentParams & PathParams<TPath>,
    TParentData & TData
  >[];
  public canDeactivate?: CanDeactivateFn<
    any,
    TParentParams & PathParams<TPath>,
    TParentData & TData
  >[];
  type?: {
    path: TPath;
    fullPath: TFullPath;
    parentParams: TParentParams;
    parentData: TParentData;
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
  }

  init() {
    const parent = this.getParentRoute?.();
    this.parent = parent;
    const parentFullPath = parent?.fullPath ?? '';
    this.fullPath = joinPaths(parentFullPath, this.path) as TFullPath;
  }

  setResolvers<
    const TNewResolvers extends ResolverMap<TParentParams & PathParams<TPath>, TParentData & TData>,
  >(
    resolvers: TNewResolvers,
  ): BaseRoute<
    TPath,
    TFullPath,
    TParentParams,
    TParentData,
    TData,
    {[K in keyof TNewResolvers]: ReturnType<TNewResolvers[K]>}
  > {
    (this as Writable<this>).resolve = resolvers;
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
    | 'component'
    | 'canActivate'
    | 'canActivateChild'
    | 'canDeactivate'
  >,
): BaseRoute<
  TPath,
  JoinPath<TParentRoute extends Route<any, infer P> ? P : '', TPath>,
  TParentRoute extends Route ? RouteParams<TParentRoute> : {},
  TParentRoute extends Route ? ResolvedData<TParentRoute> : {},
  TData,
  {[K in keyof TResolvers]: ReturnType<TResolvers[K]>}
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
    | 'pathMatch'
    | 'matcher'
  > & {
    data?: TData;
  } = {},
): BaseRoute<'', '/', {}, {}, TData, {}> {
  // The root route has an empty path.
  const newRoute = new BaseRoute({path: '', ...route});
  newRoute.init();
  return newRoute as any;
}

export function initRoutes(routes: Array<Route | UntypedRoute>, parent?: Route | UntypedRoute) {
  for (const route of routes) {
    if (parent) {
      (route as any).getParentRoute = () => parent as any;
    }
    (route as any).init?.();
    if (route.children) {
      initRoutes(route.children, route);
    }
  }
}

export function provideRouter(
  routes: UntypedRoute[],
  ...features: RouterFeatures[]
): EnvironmentProviders {
  initRoutes(routes);
  return makeEnvironmentProviders([
    provideUntypedRouter(
      routes,
      withRouterConfig({
        paramsInheritanceStrategy: 'always',
      }),
      ...features,
    ),
  ]);
}

@Injectable({providedIn: 'root'})
export class Router<TRouteMap extends Record<string, Route>> {
  private router = inject(UntypedRouter);

  navigate<TPath extends keyof TRouteMap>(
    path: TPath,
    params: TPath extends keyof TRouteMap ? ParamsForPath<TRouteMap, TPath> : never,
    extras?: NavigationExtras,
  ): Promise<boolean>;
  navigate<TFrom extends keyof TRouteMap, TTo extends string>(options: {
    to: TTo;
    from: TFrom;
    params:
      | ParamsForPath<TRouteMap, ResolveRelativePath<TFrom & string, TTo> & keyof TRouteMap>
      | ((
          prev: ParamsForPath<TRouteMap, TFrom>,
        ) => ParamsForPath<TRouteMap, ResolveRelativePath<TFrom & string, TTo> & keyof TRouteMap>);
    extras?: NavigationExtras;
  }): Promise<boolean>;
  navigate<TPath extends keyof TRouteMap>(options: {
    to: TPath;
    params: ParamsForPath<TRouteMap, TPath>;
    extras?: NavigationExtras;
  }): Promise<boolean>;
  navigate(
    pathOrOptions:
      | keyof TRouteMap
      | {
          to: string;
          from?: string;
          params?: Record<string, any> | ((prev: Record<string, any>) => Record<string, any>);
          extras?: NavigationExtras;
        },
    params?: Record<string, any>,
    extras?: NavigationExtras,
  ): Promise<boolean> {
    let path: string;
    let navParams: Record<string, any> | undefined;
    let navExtras: NavigationExtras | undefined;

    if (typeof pathOrOptions === 'string') {
      path = pathOrOptions as string;
      navParams = params;
      navExtras = extras;
    } else {
      const {
        to,
        from,
        params: optionsParams,
        extras: optionsExtras,
      } = pathOrOptions as Exclude<typeof pathOrOptions, string | number | symbol>;
      path = from ? resolvePath(from, to) : to;
      if (typeof optionsParams === 'function') {
        let currentSnapshot = this.router.routerState.snapshot.root;
        while (currentSnapshot.firstChild) {
          currentSnapshot = currentSnapshot.firstChild;
        }
        const prevParams = currentSnapshot.params;
        navParams = optionsParams(prevParams);
      } else {
        navParams = optionsParams as Record<string, any> | undefined;
      }
      navExtras = optionsExtras;
    }

    const pathSegments = (path as string).split('/').filter((s) => s !== '');
    const commands: any[] = [];
    for (const segment of pathSegments) {
      if (segment.startsWith(':')) {
        const paramName = segment.substring(1);
        commands.push((navParams as any)[paramName]);
      } else {
        commands.push(segment);
      }
    }

    return this.router.navigate(commands, navExtras);
  }
}
export type AnyRouter = Router<Record<string, AnyRoute>>;

export type SnapshotFromRoute<TRoute extends Route> = Omit<
  UntypedActivatedRouteSnapshot,
  'params' | 'data'
> & {
  params: RouteParams<TRoute>;
  data: TRoute extends Route<any, any, any, infer TParentData, infer TData, infer TResolved>
    ? TParentData & TData & TResolved
    : Record<never, never>;
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

export function injectRouter<
  TRouteMap extends Record<string, Route> = RegisteredRouteMap,
>(): Router<TRouteMap> {
  return inject(Router<TRouteMap>);
}

export function injectRoute<
  TRouteMap extends Record<string, Route> = RegisteredRouteMap,
  TPath extends AllPaths<TRouteMap> = AllPaths<TRouteMap>,
>(_path: TPath): ActivatedRoute<RouteForPath<TRouteMap, TPath>> {
  const route = inject(UntypedActivatedRoute);
  return new ActivatedRoute(route);
}

export function injectNavigate<
  TRouteMap extends Record<string, Route> = RegisteredRouteMap,
>(): Router<TRouteMap>['navigate'];
export function injectNavigate<
  TRouteMap extends Record<string, Route> = RegisteredRouteMap,
  TFrom extends AllPaths<TRouteMap> = AllPaths<TRouteMap>,
>(options: {
  from: TFrom;
}): <TTo extends string>(options: {
  to: TTo;
  params:
    | ParamsForPath<TRouteMap, ResolveRelativePath<TFrom & string, TTo> & AllPaths<TRouteMap>>
    | ((
        prev: ParamsForPath<TRouteMap, TFrom>,
      ) => ParamsForPath<
        TRouteMap,
        ResolveRelativePath<TFrom & string, TTo> & AllPaths<TRouteMap>
      >);
  extras?: NavigationExtras;
}) => Promise<boolean>;
export function injectNavigate<
  TRouteMap extends Record<string, Route> = RegisteredRouteMap,
  TFrom extends AllPaths<TRouteMap> = AllPaths<TRouteMap>,
>(options?: {from: TFrom}) {
  const router = injectRouter<TRouteMap>();

  if (options?.from) {
    const from = options.from;
    return (navOptions: any) => {
      return router.navigate({...navOptions, from});
    };
  }

  return router.navigate.bind(router);
}
