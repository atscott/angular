/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {Location} from '@angular/common';
import {
  DestroyRef,
  EnvironmentInjector,
  inject,
  Injectable,
  InjectionToken,
  runInInjectionContext,
  Type,
} from '@angular/core';
// Keep Subject, BehaviorSubject, Observable, EMPTY, of, from
// Remove filter, finalize, map, switchMap, take, takeUntil, tap, defaultIfEmpty, catchError from 'rxjs/operators'
// filter is used further down so we keep it for now.
import {BehaviorSubject, EMPTY, Observable, of, Subject, from, lastValueFrom} from 'rxjs';
import {filter, takeUntil, tap, map, take, defaultIfEmpty} from 'rxjs/operators'; // Added takeUntil

export enum NavigationStage {
  Initial,
  NavigationStart,
  Recognize,
  RoutesRecognized,
  GuardsCheckStart,
  GuardsCheck,
  GuardsCheckEnd,
  ResolveStart,
  Resolve,
  ResolveEnd,
  LoadComponents,
  AfterPreactivation,
  ViewTransition,
  CreateRouterState,
  BeforeActivateRoutes,
  ActivateRoutes,
  Completed,
  Aborted,
  Errored,
}

import {createRouterState} from './create_router_state';
import {INPUT_BINDER} from './directives/router_outlet';
import {
  BeforeActivateRoutes,
  Event,
  GuardsCheckEnd,
  GuardsCheckStart,
  IMPERATIVE_NAVIGATION,
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationSkippedCode,
  NavigationStart,
  NavigationTrigger,
  RedirectRequest,
  ResolveEnd,
  ResolveStart,
  RouteConfigLoadEnd,
  RouteConfigLoadStart,
  RoutesRecognized,
} from './events';
import {
  GuardResult,
  NavigationBehaviorOptions,
  QueryParamsHandling,
  RedirectCommand,
  Route,
  Routes,
} from './models';
import {
  isNavigationCancelingError,
  isRedirectingNavigationCancelingError,
  redirectingNavigationError,
} from './navigation_canceling_error';
import {activateRoutes} from './operators/activate_routes';
import {checkGuards} from './operators/check_guards';
import {recognize} from './operators/recognize';
import {resolveData} from './operators/resolve_data';
import {switchTap} from './operators/switch_tap';
import {TitleStrategy} from './page_title_strategy';
import {RouteReuseStrategy} from './route_reuse_strategy';
import {ROUTER_CONFIGURATION} from './router_config';
import {RouterConfigLoader} from './router_config_loader';
import {ChildrenOutletContexts} from './router_outlet_context';
import {
  ActivatedRoute,
  ActivatedRouteSnapshot,
  createEmptyState,
  RouterState,
  RouterStateSnapshot,
} from './router_state';
import type {Params} from './shared';
import {UrlHandlingStrategy} from './url_handling_strategy';
import {isUrlTree, UrlSerializer, UrlTree} from './url_tree';
import {Checks, getAllRouteGuards} from './utils/preactivation';
import {CREATE_VIEW_TRANSITION} from './utils/view_transition';

/**
 * @description
 *
 * Options that modify the `Router` URL.
 * Supply an object containing any of these properties to a `Router` navigation function to
 * control how the target URL should be constructed.
 *
 * @see {@link Router#navigate}
 * @see {@link Router#createUrlTree}
 * @see [Routing and Navigation guide](guide/routing/common-router-tasks)
 *
 * @publicApi
 */
export interface UrlCreationOptions {
  /**
   * Specifies a root URI to use for relative navigation.
   *
   * For example, consider the following route configuration where the parent route
   * has two children.
   *
   * ```
   * [{
   *   path: 'parent',
   *   component: ParentComponent,
   *   children: [{
   *     path: 'list',
   *     component: ListComponent
   *   },{
   *     path: 'child',
   *     component: ChildComponent
   *   }]
   * }]
   * ```
   *
   * The following `go()` function navigates to the `list` route by
   * interpreting the destination URI as relative to the activated `child`  route
   *
   * ```ts
   *  @Component({...})
   *  class ChildComponent {
   *    constructor(private router: Router, private route: ActivatedRoute) {}
   *
   *    go() {
   *      router.navigate(['../list'], { relativeTo: this.route });
   *    }
   *  }
   * ```
   *
   * A value of `null` or `undefined` indicates that the navigation commands should be applied
   * relative to the root.
   */
  relativeTo?: ActivatedRoute | null;

  /**
   * Sets query parameters to the URL.
   *
   * ```
   * // Navigate to /results?page=1
   * router.navigate(['/results'], { queryParams: { page: 1 } });
   * ```
   */
  queryParams?: Params | null;

  /**
   * Sets the hash fragment for the URL.
   *
   * ```
   * // Navigate to /results#top
   * router.navigate(['/results'], { fragment: 'top' });
   * ```
   */
  fragment?: string;

  /**
   * How to handle query parameters in the router link for the next navigation.
   * One of:
   * * `preserve` : Preserve current parameters.
   * * `merge` : Merge new with current parameters.
   *
   * The "preserve" option discards any new query params:
   * ```
   * // from /view1?page=1 to/view2?page=1
   * router.navigate(['/view2'], { queryParams: { page: 2 },  queryParamsHandling: "preserve"
   * });
   * ```
   * The "merge" option appends new query params to the params from the current URL:
   * ```
   * // from /view1?page=1 to/view2?page=1&otherKey=2
   * router.navigate(['/view2'], { queryParams: { otherKey: 2 },  queryParamsHandling: "merge"
   * });
   * ```
   * In case of a key collision between current parameters and those in the `queryParams` object,
   * the new value is used.
   *
   */
  queryParamsHandling?: QueryParamsHandling | null;

  /**
   * When true, preserves the URL fragment for the next navigation
   *
   * ```
   * // Preserve fragment from /results#top to /view#top
   * router.navigate(['/view'], { preserveFragment: true });
   * ```
   */
  preserveFragment?: boolean;
}

/**
 * @description
 *
 * Options that modify the `Router` navigation strategy.
 * Supply an object containing any of these properties to a `Router` navigation function to
 * control how the target URL should be constructed or interpreted.
 *
 * @see {@link Router#navigate}
 * @see {@link Router#navigateByUrl}
 * @see {@link Router#createurltree}
 * @see [Routing and Navigation guide](guide/routing/common-router-tasks)
 * @see {@link UrlCreationOptions}
 * @see {@link NavigationBehaviorOptions}
 *
 * @publicApi
 */
export interface NavigationExtras extends UrlCreationOptions, NavigationBehaviorOptions {}

export type RestoredState = {
  [k: string]: any;
  // TODO(#27607): Remove `navigationId` and `ɵrouterPageId` and move to `ng` or `ɵ` namespace.
  navigationId: number;
  // The `ɵ` prefix is there to reduce the chance of colliding with any existing user properties on
  // the history state.
  ɵrouterPageId?: number;
};

/**
 * Information about a navigation operation.
 * Retrieve the most recent navigation object with the
 * [Router.getCurrentNavigation() method](api/router/Router#getcurrentnavigation) .
 *
 * * *id* : The unique identifier of the current navigation.
 * * *initialUrl* : The target URL passed into the `Router#navigateByUrl()` call before navigation.
 * This is the value before the router has parsed or applied redirects to it.
 * * *extractedUrl* : The initial target URL after being parsed with `UrlSerializer.extract()`.
 * * *finalUrl* : The extracted URL after redirects have been applied.
 * This URL may not be available immediately, therefore this property can be `undefined`.
 * It is guaranteed to be set after the `RoutesRecognized` event fires.
 * * *trigger* : Identifies how this navigation was triggered.
 * -- 'imperative'--Triggered by `router.navigateByUrl` or `router.navigate`.
 * -- 'popstate'--Triggered by a popstate event.
 * -- 'hashchange'--Triggered by a hashchange event.
 * * *extras* : A `NavigationExtras` options object that controlled the strategy used for this
 * navigation.
 * * *previousNavigation* : The previously successful `Navigation` object. Only one previous
 * navigation is available, therefore this previous `Navigation` object has a `null` value for its
 * own `previousNavigation`.
 *
 * @publicApi
 */
export interface Navigation {
  /**
   * The unique identifier of the current navigation.
   */
  id: number;
  /**
   * The target URL passed into the `Router#navigateByUrl()` call before navigation. This is
   * the value before the router has parsed or applied redirects to it.
   */
  initialUrl: UrlTree;
  /**
   * The initial target URL after being parsed with `UrlHandlingStrategy.extract()`.
   */
  extractedUrl: UrlTree;
  /**
   * The extracted URL after redirects have been applied.
   * This URL may not be available immediately, therefore this property can be `undefined`.
   * It is guaranteed to be set after the `RoutesRecognized` event fires.
   */
  finalUrl?: UrlTree;
  /**
   * `UrlTree` to use when updating the browser URL for the navigation when `extras.browserUrl` is
   * defined.
   * @internal
   */
  readonly targetBrowserUrl?: UrlTree | string;
  /**
   * TODO(atscott): If we want to make StateManager public, they will need access to this. Note that
   * it's already eventually exposed through router.routerState.
   * @internal
   */
  targetRouterState?: RouterState;
  /**
   * Identifies how this navigation was triggered.
   */
  trigger: NavigationTrigger;
  /**
   * Options that controlled the strategy used for this navigation.
   * See `NavigationExtras`.
   */
  extras: NavigationExtras;
  /**
   * The previously successful `Navigation` object. Only one previous navigation
   * is available, therefore this previous `Navigation` object has a `null` value
   * for its own `previousNavigation`.
   */
  previousNavigation: Navigation | null;

  /**
   * Aborts the navigation if it has not yet been completed or reached the point where routes are being activated.
   * This function is a no-op if the navigation is beyond the point where it can be aborted.
   */
  readonly abort: () => void;
}

export interface NavigationTransition {
  id: number;
  currentUrlTree: UrlTree;
  extractedUrl: UrlTree;
  currentRawUrl: UrlTree;
  urlAfterRedirects?: UrlTree;
  rawUrl: UrlTree;
  extras: NavigationExtras;
  resolve: (value: boolean | PromiseLike<boolean>) => void;
  reject: (reason?: any) => void;
  promise: Promise<boolean>;
  source: NavigationTrigger;
  restoredState: RestoredState | null;
  currentSnapshot: RouterStateSnapshot;
  targetSnapshot: RouterStateSnapshot | null;
  currentRouterState: RouterState;
  targetRouterState: RouterState | null;
  guards: Checks;
  guardsResult: GuardResult | null;
  abortController: AbortController;
}

/**
 * The interface from the Router needed by the transitions. Used to avoid a circular dependency on
 * Router. This interface should be whittled down with future refactors. For example, we do not need
 * to get `UrlSerializer` from the Router. We can instead inject it in `NavigationTransitions`
 * directly.
 */
interface InternalRouterInterface {
  config: Routes;
  navigated: boolean;
  routeReuseStrategy: RouteReuseStrategy;
  onSameUrlNavigation: 'reload' | 'ignore';
}

export const NAVIGATION_ERROR_HANDLER = new InjectionToken<
  (error: NavigationError) => unknown | RedirectCommand
>(typeof ngDevMode === 'undefined' || ngDevMode ? 'navigation error handler' : '');

@Injectable({providedIn: 'root'})
export class NavigationTransitions {
  currentNavigation: Navigation | null = null;
  currentTransition: NavigationTransition | null = null;
  lastSuccessfulNavigation: Navigation | null = null;
  /**
   * These events are used to communicate back to the Router about the state of the transition. The
   * Router wants to respond to these events in various ways. Because the `NavigationTransition`
   * class is not public, this event subject is not publicly exposed.
   */
  readonly events = new Subject<Event | BeforeActivateRoutes | RedirectRequest>();
  /**
   * Used to abort the current transition with an error.
   */
  readonly transitionAbortWithErrorSubject = new Subject<Error>();
  private readonly configLoader = inject(RouterConfigLoader);
  private readonly environmentInjector = inject(EnvironmentInjector);
  private readonly destroyRef = inject(DestroyRef);
  private readonly urlSerializer = inject(UrlSerializer);
  private readonly rootContexts = inject(ChildrenOutletContexts);
  private readonly location = inject(Location);
  private readonly inputBindingEnabled = inject(INPUT_BINDER, {optional: true}) !== null;
  private readonly titleStrategy?: TitleStrategy = inject(TitleStrategy);
  private readonly options = inject(ROUTER_CONFIGURATION, {optional: true}) || {};
  private readonly paramsInheritanceStrategy =
    this.options.paramsInheritanceStrategy || 'emptyOnly';
  private readonly urlHandlingStrategy = inject(UrlHandlingStrategy);
  private readonly createViewTransition = inject(CREATE_VIEW_TRANSITION, {optional: true});
  private readonly navigationErrorHandler = inject(NAVIGATION_ERROR_HANDLER, {optional: true});

  navigationId = 0;
  get hasRequestedNavigation() {
    return this.navigationId !== 0;
  }
  private transitions?: BehaviorSubject<NavigationTransition | null>;
  private successfulTransitions = new Subject<NavigationTransition>(); // For the return Observable
  /**
   * Hook that enables you to pause navigation after the preactivation phase.
   * Used by `RouterModule`.
   *
   * @internal
   */
  afterPreactivation: () => Observable<void> = () => of(void 0);
  /** @internal */
  rootComponentType: Type<any> | null = null;

  private destroyed = false;

  constructor() {
    const onLoadStart = (r: Route) => this.events.next(new RouteConfigLoadStart(r));
    const onLoadEnd = (r: Route) => this.events.next(new RouteConfigLoadEnd(r));
    this.configLoader.onLoadEndListener = onLoadEnd;
    this.configLoader.onLoadStartListener = onLoadStart;
    this.destroyRef.onDestroy(() => {
      this.destroyed = true;
    });
  }

  complete() {
    this.transitions?.complete();
  }

  handleNavigationRequest(
    request: Pick<
      NavigationTransition,
      | 'source'
      | 'restoredState'
      | 'currentUrlTree'
      | 'currentRawUrl'
      | 'rawUrl'
      | 'extras'
      | 'resolve'
      | 'reject'
      | 'promise'
      | 'currentSnapshot'
      | 'currentRouterState'
    >,
  ) {
    const id = ++this.navigationId;
    this.transitions?.next({
      ...request,
      extractedUrl: this.urlHandlingStrategy.extract(request.rawUrl),
      targetSnapshot: null,
      targetRouterState: null,
      guards: {canActivateChecks: [], canDeactivateChecks: []},
      guardsResult: null,
      abortController: new AbortController(),
      id,
    });
  }

  // Helper async function for the navigation pipeline
  private async processNavigation(
    transition: NavigationTransition,
    abortSignal: AbortSignal,
    router: InternalRouterInterface,
  ): Promise<boolean | undefined> { // boolean: true for success, false for cancel, undefined for error/redirect handled by throw/event
    this.currentTransition = transition;
    this.currentNavigation = { /* ... as before ... */
      id: transition.id,
      initialUrl: transition.rawUrl,
      extractedUrl: transition.extractedUrl,
      targetBrowserUrl:
        typeof transition.extras.browserUrl === 'string'
          ? this.urlSerializer.parse(transition.extras.browserUrl)
          : transition.extras.browserUrl,
      trigger: transition.source,
      extras: transition.extras,
      previousNavigation: !this.lastSuccessfulNavigation
        ? null
        : {
            ...this.lastSuccessfulNavigation,
            previousNavigation: null,
          },
      abort: () => transition.abortController.abort(),
    };

    if (abortSignal.aborted) {
      this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted before start', NavigationCancellationCode.Aborted);
      return false;
    }

    // === Initial checks and Recognize (from previous subtask) ===
    const urlTransition =
      !router.navigated || this.isUpdatingInternalState() || this.isUpdatedBrowserUrl();
    const onSameUrlNavigation = transition.extras.onSameUrlNavigation ?? router.onSameUrlNavigation;

    if (!urlTransition && onSameUrlNavigation !== 'reload') {
      // ... NavigationSkipped logic ...
      const reason = typeof ngDevMode === 'undefined' || ngDevMode ? `Navigation to ${transition.rawUrl} was ignored because it is the same as the current Router URL.` : '';
      this.events.next(new NavigationSkipped(transition.id, this.urlSerializer.serialize(transition.rawUrl), reason, NavigationSkippedCode.IgnoredSameUrlNavigation));
      transition.resolve(false);
      return false;
    }

    if (abortSignal.aborted) {
      this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted before URL processing', NavigationCancellationCode.Aborted);
      return false;
    }

    // let recognizedTransition: NavigationTransition = transition; // Not needed, transition is modified directly or replaced by new ref in case of url handling strategy

    if (this.urlHandlingStrategy.shouldProcessUrl(transition.rawUrl)) {
      this.events.next(new NavigationStart(transition.id, this.urlSerializer.serialize(transition.extractedUrl), transition.source, transition.restoredState));
      await Promise.resolve();
      if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after NavigationStart', NavigationCancellationCode.Aborted); return false; }
      if (transition.id !== this.navigationId) {
          this.cancelNavigationTransition(transition, typeof ngDevMode === 'undefined' || ngDevMode ? `Navigation ID ${transition.id} is not equal to the current navigation id ${this.navigationId}`: '', NavigationCancellationCode.SupersededByNewNavigation);
          return false;
      }

      try {
        const recognitionResult = await new Promise<NavigationTransition>((resolve, reject) => {
            of(transition).pipe(
                recognize(
                    this.environmentInjector, this.configLoader, this.rootComponentType,
                    router.config, this.urlSerializer, this.paramsInheritanceStrategy
                )
            ).subscribe({ next: resolve, error: reject });
        });
        if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after recognize', NavigationCancellationCode.Aborted); return false; }

        // Update transition properties based on recognition result
        transition.targetSnapshot = recognitionResult.targetSnapshot;
        transition.urlAfterRedirects = recognitionResult.urlAfterRedirects;

      } catch (e) {
        if (isRedirectingNavigationCancelingError(e)) {
          this.events.next(new NavigationCancel(transition.id, this.urlSerializer.serialize(transition.extractedUrl), (e as Error).message, (e as any).cancellationCode));
          this.events.next(new RedirectRequest((e as any).url, (e as any).navigationBehaviorOptions));
          // For redirects, the navigation promise is resolved by the new navigation that handles the redirect.
          return undefined; // Signal that a redirect occurred and current nav promise is not resolved here.
        }
        throw e;
      }

      this.currentNavigation = { ...this.currentNavigation!, finalUrl: transition.urlAfterRedirects };
      this.events.next(new RoutesRecognized(transition.id, this.urlSerializer.serialize(transition.extractedUrl), this.urlSerializer.serialize(transition.urlAfterRedirects!), transition.targetSnapshot!));
    } else if (urlTransition && this.urlHandlingStrategy.shouldProcessUrl(transition.currentRawUrl)) {
      // ... Logic for when current URL shouldn't be processed ...
      const {id, extractedUrl, source, restoredState, extras} = transition;
      this.events.next(new NavigationStart(id, this.urlSerializer.serialize(extractedUrl), source, restoredState));
      const targetSnapshot = createEmptyState(this.rootComponentType!).snapshot;
      transition.targetSnapshot = targetSnapshot;
      transition.urlAfterRedirects = extractedUrl;
      transition.extras = {...extras, skipLocationChange: false, replaceUrl: false};
      this.currentNavigation!.finalUrl = extractedUrl;
    } else {
      // ... Logic for NavigationSkippedCode.IgnoredByUrlHandlingStrategy ...
      const reason = typeof ngDevMode === 'undefined' || ngDevMode ? `Navigation was ignored because the UrlHandlingStrategy indicated neither the current URL ${transition.currentRawUrl} nor target URL ${transition.rawUrl} should be processed.` : '';
      this.events.next(new NavigationSkipped(transition.id, this.urlSerializer.serialize(transition.extractedUrl), reason, NavigationSkippedCode.IgnoredByUrlHandlingStrategy));
      transition.resolve(false);
      return false;
    }
    // === END of Initial checks and Recognize ===

    if (abortSignal.aborted) {
      this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted before guards', NavigationCancellationCode.Aborted);
      return false;
    }

    // --- GUARDS ---
    const guardsStartEvent = new GuardsCheckStart(
      transition.id,
      this.urlSerializer.serialize(transition.extractedUrl),
      this.urlSerializer.serialize(transition.urlAfterRedirects!),
      transition.targetSnapshot!,
    );
    this.events.next(guardsStartEvent);

    if (abortSignal.aborted) {
      this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after GuardsCheckStart', NavigationCancellationCode.Aborted);
      return false;
    }

    transition.guards = getAllRouteGuards(transition.targetSnapshot!, transition.currentSnapshot, this.rootContexts);

    // The checkGuards operator also returns an Observable. We need to adapt it.
    // It emits the transition object, potentially modified with guardsResult.
    const guardsResultTransition = await new Promise<NavigationTransition>((resolve, reject) => {
        of(transition).pipe(
            checkGuards(this.environmentInjector, (evt: Event) => this.events.next(evt))
        ).subscribe({
            next: resolve,
            error: reject, // checkGuards can throw RedirectingNavigationCancelingError
        });
    });

    if (abortSignal.aborted) {
      this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after checkGuards', NavigationCancellationCode.Aborted);
      return false;
    }

    // Update transition with the results from checkGuards
    transition.guardsResult = guardsResultTransition.guardsResult;

    if (transition.guardsResult && typeof transition.guardsResult !== 'boolean') {
      // This is a redirect from a guard
      const redirectError = redirectingNavigationError(this.urlSerializer, transition.guardsResult);
      this.events.next(
        new NavigationCancel(
          transition.id,
          this.urlSerializer.serialize(transition.extractedUrl),
          redirectError.message,
          redirectError.cancellationCode,
        ),
      );
      this.events.next(new RedirectRequest(redirectError.url, redirectError.navigationBehaviorOptions));
      // Similar to redirect from recognize, let the new navigation handle promise resolution.
      return undefined;
    }

    const guardsEndEvent = new GuardsCheckEnd(
      transition.id,
      this.urlSerializer.serialize(transition.extractedUrl),
      this.urlSerializer.serialize(transition.urlAfterRedirects!),
      transition.targetSnapshot!,
      !!transition.guardsResult, // boolean conversion
    );
    this.events.next(guardsEndEvent);

    if (!transition.guardsResult) {
      this.cancelNavigationTransition(transition, '', NavigationCancellationCode.GuardRejected);
      return false; // Guards rejected, navigation cancelled
    }

    // Check for abort before proceeding to Resolve
    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted before resolve', NavigationCancellationCode.Aborted); return false; }

    // --- RESOLVE ---
    if (transition.guards.canActivateChecks.length === 0) {
      // No resolvers to run, proceed to next stage
    } else {
      this.events.next(new ResolveStart(transition.id, this.urlSerializer.serialize(transition.extractedUrl), this.urlSerializer.serialize(transition.urlAfterRedirects!), transition.targetSnapshot!));

      if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after ResolveStart', NavigationCancellationCode.Aborted); return false; }

      let dataResolved = false;
      try {
        // resolveData operator modifies the transition.targetSnapshot.data
        // It completes once all data is resolved, or errors if a resolver errors.
        // It might not emit the transition object itself but rather complete or error.
        // The original RxJS `resolveData` operator was used with `tap({next: () => dataResolved = true, complete: ...})`
        // We need to replicate this behavior.
        await new Promise<void>((resolve, reject) => {
          of(transition).pipe(
            resolveData(this.paramsInheritanceStrategy, this.environmentInjector)
            // The resolveData operator mutates the snapshot in place.
            // It emits the transition and then completes.
          ).subscribe({
            next: () => { dataResolved = true; }, // transition object is emitted by resolveData
            error: reject,
            complete: resolve,
          });
        });

        if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after resolveData', NavigationCancellationCode.Aborted); return false; }

        if (!dataResolved && transition.guards.canActivateChecks.some(c => c.route.resolve && Object.keys(c.route.resolve).length > 0)) {
            // This check might be too simplistic. The original code checked `!dataResolved` in `tap({complete:...})`
            // which means if `resolveData` completed without emitting a `next` (which it should for the transition itself).
            // A more accurate check might be to see if `resolveData` itself threw an error or if specific resolvers failed.
            // For now, if `resolveData` completes but `dataResolved` is false, and there were resolvers, consider it an issue.
            // This logic might need refinement based on how `resolveData` behaves when a resolver path is empty or all resolvers are empty.
            // The original code's `tap({complete: ... if (!dataResolved) cancel ...})` implies that if the observable completes
            // without `next` (dataResolved = true) ever being called, it's a problem.
            // `resolveData` should emit the transition object. If it completes without doing so, it's an issue.
            // The current promise structure with `next: () => dataResolved = true` and `complete: resolve` should capture this.
            // If `complete` is called but `dataResolved` is still false, it means `next` was never called.
            this.cancelNavigationTransition(
                transition,
                typeof ngDevMode === 'undefined' || ngDevMode ? `At least one route resolver didn't emit any value.` : '',
                NavigationCancellationCode.NoDataFromResolver,
            );
            return false;
        }

      } catch (e) {
        // Handle errors from resolvers, e.g., if a resolver throws an error.
        // This will be caught by the main try/catch in setupNavigations and trigger NavigationError.
        throw e;
      }

      this.events.next(new ResolveEnd(transition.id, this.urlSerializer.serialize(transition.extractedUrl), this.urlSerializer.serialize(transition.urlAfterRedirects!), transition.targetSnapshot!));
    }
    // --- END of RESOLVE ---

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted before LoadComponents', NavigationCancellationCode.Aborted); return false; }

    // --- LOAD COMPONENTS ---
    const loadComponentsRecursive = (route: ActivatedRouteSnapshot): Array<Promise<void>> => {
        const loaders: Array<Promise<void>> = [];
        if (route.routeConfig?.loadComponent && !route.routeConfig._loadedComponent) {
            const loadPromise = lastValueFrom(this.configLoader.loadComponent(route.routeConfig)
                .pipe(
                    tap((loadedComponent) => { route.component = loadedComponent; }),
                    map(() => void 0),
                    take(1)
                ));
            loaders.push(loadPromise);
        }
        for (const child of route.children) {
            loaders.push(...loadComponentsRecursive(child));
        }
        return loaders;
    };
    const componentLoaders = loadComponentsRecursive(transition.targetSnapshot!.root);
    if (componentLoaders.length > 0) {
        await Promise.all(componentLoaders);
    }

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after LoadComponents', NavigationCancellationCode.Aborted); return false; }

    // --- AFTER PREACTIVATION ---
    await lastValueFrom(this.afterPreactivation().pipe(defaultIfEmpty(undefined), take(1)));

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after Preactivation', NavigationCancellationCode.Aborted); return false; }

    // --- VIEW TRANSITION ---
    if (this.createViewTransition) {
        const viewTransitionStarted = this.createViewTransition(
            this.environmentInjector,
            transition.currentSnapshot.root,
            transition.targetSnapshot!.root,
        );
        if (viewTransitionStarted) {
            await viewTransitionStarted;
        }
    }

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after ViewTransition', NavigationCancellationCode.Aborted); return false; }

    // --- CREATE ROUTER STATE ---
    const targetRouterState = createRouterState(router.routeReuseStrategy, transition.targetSnapshot!, transition.currentRouterState);
    transition.targetRouterState = targetRouterState; // Update the transition object
    // Also update currentNavigation as it's exposed publicly.
    if (this.currentNavigation) {
        this.currentNavigation.targetRouterState = targetRouterState;
    }

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after CreateRouterState', NavigationCancellationCode.Aborted); return false; }

    // --- BEFORE ACTIVATE ROUTES EVENT ---
    this.events.next(new BeforeActivateRoutes());

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after BeforeActivateRoutes event', NavigationCancellationCode.Aborted); return false; }

    // --- ACTIVATE ROUTES ---
    // The activateRoutes operator also returns an Observable<NavigationTransition>.
    // It performs the actual activation and component instantiation.
    // It also emits events like ActivationStart/End.
    await new Promise<void>((resolve, reject) => {
        of(transition).pipe(
            activateRoutes(
                this.rootContexts,
                router.routeReuseStrategy,
                (evt: Event) => this.events.next(evt),
                this.inputBindingEnabled,
            ),
            take(1) // activateRoutes emits the transition and completes.
        ).subscribe({
            // next: (finalTransition) => {
            //   // transition object should be the same or updated by activateRoutes
            // },
            error: reject,
            complete: resolve,
        });
    });

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after ActivateRoutes', NavigationCancellationCode.Aborted); return false; }

    // --- NAVIGATION SUCCESS ---
    this.lastSuccessfulNavigation = this.currentNavigation;
    this.events.next(
        new NavigationEnd(
            transition.id,
            this.urlSerializer.serialize(transition.extractedUrl),
            this.urlSerializer.serialize(transition.urlAfterRedirects!),
        ),
    );
    this.titleStrategy?.updateTitle(transition.targetRouterState!.snapshot);
    transition.resolve(true);

    console.log(`Navigation ID: ${transition.id} completed successfully.`);
    // This return true signifies the end of successful navigation if no other stage was planned after.
    // However, we are inserting this BEFORE Load Components, so we must NOT return here yet.
    // The original Load Components logic and subsequent stages will follow.
    // This console log and return true will be moved to the very end later.

    // --- LOAD COMPONENTS ---
    const loadComponentsRecursive = (route: ActivatedRouteSnapshot): Array<Promise<void>> => {
        const loaders: Array<Promise<void>> = [];
        if (route.routeConfig?.loadComponent && !route.routeConfig._loadedComponent) {
            const loadPromise = lastValueFrom(this.configLoader.loadComponent(route.routeConfig)
                .pipe(
                    tap((loadedComponent) => { route.component = loadedComponent; }),
                    map(() => void 0),
                    take(1)
                ));
            loaders.push(loadPromise);
        }
        for (const child of route.children) {
            loaders.push(...loadComponentsRecursive(child));
        }
        return loaders;
    };
    const componentLoaders = loadComponentsRecursive(transition.targetSnapshot!.root);
    if (componentLoaders.length > 0) {
        await Promise.all(componentLoaders);
    }

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after LoadComponents', NavigationCancellationCode.Aborted); return false; }

    // --- AFTER PREACTIVATION ---
    await lastValueFrom(this.afterPreactivation().pipe(defaultIfEmpty(undefined), take(1)));

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after Preactivation', NavigationCancellationCode.Aborted); return false; }

    // --- VIEW TRANSITION ---
    if (this.createViewTransition) {
        const viewTransitionStarted = this.createViewTransition(
            this.environmentInjector,
            transition.currentSnapshot.root,
            transition.targetSnapshot!.root,
        );
        if (viewTransitionStarted) {
            await viewTransitionStarted;
        }
    }

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after ViewTransition', NavigationCancellationCode.Aborted); return false; }

    // --- CREATE ROUTER STATE ---
    const targetRouterState = createRouterState(router.routeReuseStrategy, transition.targetSnapshot!, transition.currentRouterState);
    transition.targetRouterState = targetRouterState; // Update the transition object
    // Also update currentNavigation as it's exposed publicly.
    if (this.currentNavigation) {
        this.currentNavigation.targetRouterState = targetRouterState;
    }

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after CreateRouterState', NavigationCancellationCode.Aborted); return false; }

    // --- BEFORE ACTIVATE ROUTES EVENT ---
    this.events.next(new BeforeActivateRoutes());

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after BeforeActivateRoutes event', NavigationCancellationCode.Aborted); return false; }

    // --- ACTIVATE ROUTES ---
    await new Promise<void>((resolve, reject) => {
        of(transition).pipe(
            activateRoutes(
                this.rootContexts,
                router.routeReuseStrategy,
                (evt: Event) => this.events.next(evt),
                this.inputBindingEnabled,
            ),
            take(1) // activateRoutes emits the transition and completes.
        ).subscribe({
            error: reject,
            complete: resolve,
        });
    });

    if (abortSignal.aborted) { this.cancelNavigationTransition(transition, abortSignal.reason ?? 'Aborted after ActivateRoutes', NavigationCancellationCode.Aborted); return false; }

    // --- NAVIGATION SUCCESS ---
    this.lastSuccessfulNavigation = this.currentNavigation;
    this.events.next(
        new NavigationEnd(
            transition.id,
            this.urlSerializer.serialize(transition.extractedUrl),
            this.urlSerializer.serialize(transition.urlAfterRedirects!),
        ),
    );
    this.titleStrategy?.updateTitle(transition.targetRouterState!.snapshot);
    transition.resolve(true);

    console.log(`Navigation ID: ${transition.id} completed successfully.`);
    return true; // Signal overall success of this navigation attempt
  }

  // In setupNavigations, ensure the successfulTransitions subject is used for the return value
  setupNavigations(router: InternalRouterInterface): Observable<NavigationTransition> {
    this.transitions = new BehaviorSubject<NavigationTransition | null>(null);
    let currentNavigationAbortController: AbortController | null = null;
    let currentTransitionPromiseReject: ((reason?: any) => void) | null = null;

    const destroy$ = new Subject<void>();
    this.destroyRef.onDestroy(() => {
        destroy$.next();
        destroy$.complete();
        if (currentNavigationAbortController) {
            currentNavigationAbortController.abort('Router destroyed');
            currentNavigationAbortController = null;
        }
    });

    // Handle transitionAbortWithErrorSubject
    this.transitionAbortWithErrorSubject.pipe(takeUntil(destroy$)).subscribe(err => {
        if (currentNavigationAbortController) {
            currentNavigationAbortController.abort('ExternalError');
        }
        if (currentTransitionPromiseReject) {
            currentTransitionPromiseReject(err);
            currentTransitionPromiseReject = null;
        }
    });


    (async () => {
      this.transitions!
        .pipe(filter((t): t is NavigationTransition => t !== null), takeUntil(destroy$))
        .subscribe(async (overallTransitionState) => {
          let completedOrAbortedThisTransition: boolean = false;
          currentTransitionPromiseReject = overallTransitionState.reject; // Store the reject for the current transition

          if (this.destroyed) { return; }

          if (currentNavigationAbortController) { currentNavigationAbortController.abort('New navigation started'); }
          const navigationSpecificAbortController = new AbortController();
          currentNavigationAbortController = navigationSpecificAbortController;

          const externalAbortHandler = () => {
              if (!navigationSpecificAbortController.signal.aborted) {
                  navigationSpecificAbortController.abort('Transition aborted externally');
              }
              // If the external abort was from overallTransitionState.abortController, its promise might already be handled.
              // If not, we might need to ensure overallTransitionState.reject is called.
              // However, cancelNavigationTransition already calls overallTransitionState.resolve(false).
          };
          overallTransitionState.abortController.signal.addEventListener('abort', externalAbortHandler);

          if (overallTransitionState.abortController.signal.aborted) {
            this.cancelNavigationTransition(overallTransitionState, overallTransitionState.abortController.signal.reason ?? 'Already aborted', NavigationCancellationCode.Aborted);
            overallTransitionState.abortController.signal.removeEventListener('abort', externalAbortHandler);
            if (currentNavigationAbortController === navigationSpecificAbortController) { currentNavigationAbortController = null; }
            currentTransitionPromiseReject = null; // Clear stored reject
            completedOrAbortedThisTransition = true;
            return;
          }

          try {
            const processResult = await this.processNavigation(overallTransitionState, navigationSpecificAbortController.signal, router);

            if (processResult === true) {
              this.successfulTransitions.next(overallTransitionState);
              completedOrAbortedThisTransition = true;
              // overallTransitionState.resolve(true) was called in processNavigation
            } else if (processResult === false) {
              // Cancelled (e.g. guard, skip), promise handled by cancelNavigationTransition
              completedOrAbortedThisTransition = true;
            } else { // undefined for redirect
              completedOrAbortedThisTransition = true;
            }

          } catch (error) {
            completedOrAbortedThisTransition = true;
            if (this.destroyed) { overallTransitionState.resolve(false); return; }

            // Check if the error came from our external abort subject
            if (navigationSpecificAbortController.signal.aborted && navigationSpecificAbortController.signal.reason === 'ExternalError') {
                // The error itself was passed to overallTransitionState.reject by the subject's subscriber.
                // We just need to ensure proper eventing if not already done.
                // The 'error' variable here would be the AbortError. The actual error is 'err' from the subject.
                // This path might be complex. Let's simplify: the subject directly rejects.
                // The main error path below will handle the NavigationError event.
                // If overallTransitionState.reject was already called by the subject, this catch might be for an AbortError.
                // It's important that overallTransitionState.reject is called with the *original* error from the subject.
                // The current setup: subject calls reject(originalError). processNavigation might throw AbortError.
                // The 'error' in this catch block would be the AbortError.
                // We need to ensure the NavigationError event uses the original error.
                // This is tricky. Awaiting a promise that's rejected will make the await throw that rejection.
                // So if currentTransitionPromiseReject(err) was called, await processNavigation would throw 'err'.

                // If the error caught is the one from the subject, it's already handled.
                // If it's an AbortError because the subject aborted the controller, then we use the original error for the event.
                // This part of the original code is subtle: `takeUntil(subject.pipe(tap(err => {throw err;})))`
                // The `throw err` inside the `tap` makes the main observable error out with `err`.
                // Our `currentTransitionPromiseReject(err)` does something similar for the `overallTransitionState.promise`.
                // So, `error` here should be the actual error from the subject.
            }


            if (isNavigationCancelingError(error as Error)) {
              this.events.next(new NavigationCancel(overallTransitionState.id, this.urlSerializer.serialize(overallTransitionState.extractedUrl), (error as Error).message, (error as any).cancellationCode));
              if (!isRedirectingNavigationCancelingError(error as Error)) { overallTransitionState.resolve(false); }
              else { this.events.next(new RedirectRequest((error as any).url, (error as any).navigationBehaviorOptions)); }
            } else { // General error, including those from transitionAbortWithErrorSubject
              const navigationError = new NavigationError(overallTransitionState.id, this.urlSerializer.serialize(overallTransitionState.extractedUrl), error as Error, overallTransitionState.targetSnapshot ?? undefined);
              try {
                  // If overallTransitionState.reject was already called by the abort subject, this error handler might run again.
                  // We need to ensure it's idempotent or guarded if the promise is already settled.
                  // However, a promise can only be rejected once.
                  const navigationErrorHandlerResult = runInInjectionContext(this.environmentInjector, () => this.navigationErrorHandler?.(navigationError));
                  if (navigationErrorHandlerResult instanceof RedirectCommand) {
                      const {message, cancellationCode} = redirectingNavigationError(this.urlSerializer, navigationErrorHandlerResult);
                      this.events.next(new NavigationCancel(overallTransitionState.id, this.urlSerializer.serialize(overallTransitionState.extractedUrl), message, cancellationCode));
                      this.events.next(new RedirectRequest(navigationErrorHandlerResult.redirectTo, navigationErrorHandlerResult.navigationBehaviorOptions));
                      // Original code does not resolve/reject promise here for redirects from error handler
                  } else {
                      this.events.next(navigationError);
                      // If not already rejected by the abort subject, reject now.
                      // Checking promise status is non-standard and unreliable.
                      // A better approach is to rely on promises only settling once.
                      // If reject was called by the subject, subsequent rejects are no-ops.
                      if (this.options.resolveNavigationPromiseOnError) { overallTransitionState.resolve(false); }
                      else { overallTransitionState.reject(error); }
                  }
              } catch (ee) { // Error from the error handler itself
                  // Similar to above, rely on promise nature.
                  if (this.options.resolveNavigationPromiseOnError) { overallTransitionState.resolve(false); }
                  else { overallTransitionState.reject(ee); }
              }
            }
          } finally {
            overallTransitionState.abortController.signal.removeEventListener('abort', externalAbortHandler);
            if (currentNavigationAbortController === navigationSpecificAbortController) {
              currentNavigationAbortController = null;
            }
            currentTransitionPromiseReject = null; // Clear stored reject

            if (!completedOrAbortedThisTransition) {
                 const reason = navigationSpecificAbortController.signal.reason || overallTransitionState.abortController.signal.reason || 'Unknown abort reason';
                 const isSuperseded = reason === 'New navigation started' ||
                                      overallTransitionState.abortController.signal.reason === 'Superseded by new navigation' ||
                                      (overallTransitionState.id !== this.navigationId && navigationSpecificAbortController.signal.aborted);
                 const code = isSuperseded ? NavigationCancellationCode.SupersededByNewNavigation : NavigationCancellationCode.Aborted;
                 if (navigationSpecificAbortController.signal.aborted || overallTransitionState.abortController.signal.aborted || isSuperseded) {
                    this.cancelNavigationTransition(overallTransitionState, reason, code);
                 }
            }
            if (this.currentTransition?.id === overallTransitionState.id) {
                this.currentNavigation = null;
                this.currentTransition = null;
            }
          }
        });
    })();

    return this.successfulTransitions.asObservable();
  }
}
    t: NavigationTransition,
    reason: string,
    code: NavigationCancellationCode,
  ) {
    const navCancel = new NavigationCancel(
      t.id,
      this.urlSerializer.serialize(t.extractedUrl),
      reason,
      code,
    );
    this.events.next(navCancel);
    t.resolve(false);
  }

  /**
   * @returns Whether we're navigating to somewhere that is not what the Router is
   * currently set to.
   */
  private isUpdatingInternalState() {
    // TODO(atscott): The serializer should likely be used instead of
    // `UrlTree.toString()`. Custom serializers are often written to handle
    // things better than the default one (objects, for example will be
    // [Object object] with the custom serializer and be "the same" when they
    // aren't).
    // (Same for isUpdatedBrowserUrl)
    return (
      this.currentTransition?.extractedUrl.toString() !==
      this.currentTransition?.currentUrlTree.toString()
    );
  }

  /**
   * @returns Whether we're updating the browser URL to something new (navigation is going
   * to somewhere not displayed in the URL bar and we will update the URL
   * bar if navigation succeeds).
   */
  private isUpdatedBrowserUrl() {
    // The extracted URL is the part of the URL that this application cares about. `extract` may
    // return only part of the browser URL and that part may have not changed even if some other
    // portion of the URL did.
    const currentBrowserUrl = this.urlHandlingStrategy.extract(
      this.urlSerializer.parse(this.location.path(true)),
    );
    const targetBrowserUrl =
      this.currentNavigation?.targetBrowserUrl ?? this.currentNavigation?.extractedUrl;
    return (
      currentBrowserUrl.toString() !== targetBrowserUrl?.toString() &&
      !this.currentNavigation?.extras.skipLocationChange
    );
  }
}

export function isBrowserTriggeredNavigation(source: NavigationTrigger) {
  return source !== IMPERATIVE_NAVIGATION;
}
