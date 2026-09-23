/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {DestroyRef, EnvironmentInjector, inject, Injectable} from '@angular/core';
import {Router} from './router';
import {NavigationTransitions} from './navigation_transition';
import {ROUTER_CONFIGURATION} from './router_config';
import {RouterConfigLoader} from './router_config_loader';
import {ROUTER_RESOURCES_FEATURE} from './router_resource_feature';
import {DEFAULT_PARAMS_INHERITANCE_STRATEGY} from './router_state';
import {UrlSerializer, UrlTree} from './url_tree';
import {MAX_ALLOWED_REDIRECTS, recognize} from './recognize';
import {loadComponents} from './load_components';
import {resolveAllData} from './operators/resolve_data';
import {isRedirectingNavigationCancelingError} from './navigation_canceling_error';

/**
 * Options for the preload function returned by `injectPreloadRoute`.
 *
 * @publicApi
 */
export interface PreloadRouteOptions {
  /**
   * Aborts the preload. Note that preloads of the same URL are shared: the underlying work is only
   * aborted once every caller of that URL has aborted.
   */
  signal?: AbortSignal;

  /**
   * Whether to also execute matched `resolve` resolvers and `resources` (when
   * `withRouterResources()` is configured) to warm the application's data cache.
   *
   * Defaults to `false` because Angular does not cache resolver or `resource()` results across
   * navigations out of the box (unlike code chunks, which the router caches on `Route`). Set to
   * `true` when your resolvers and resources read through a deduplicating cache (such as TanStack
   * Query or an application-level cache service).
   *
   * @default false
   */
  includeData?: boolean;

  /**
   * Controls whether downstream data stages wait for upstream stages when `includeData` is `true`.
   */
  downstreamDeps?: {
    /**
     * Whether resolvers and `resources` wait for `loadConfig` chunks to resolve before running.
     *
     * Set to `false` to assert that upfront resolvers and `resources` do not depend on `providers`,
     * `data`, or ancestor resolvers/`resources` defined inside `loadConfig`. This allows upfront
     * resolvers and `resources` on the static `Route` tree to run at `t = 0` in parallel with
     * `loadConfig` and `loadComponent` downloads.
     *
     * @default true
     */
    loadConfig?: boolean;

    /**
     * Whether `resources` wait for `resolve` resolvers to finish so that `ctx.data()` includes
     * resolver results. When `false`, `resolve` and `resources` start concurrently.
     *
     * @default true
     */
    resolvers?: boolean;
  };
}

/**
 * A function that preloads a route. Created with `injectPreloadRoute`.
 *
 * @publicApi
 */
export type PreloadRouteFn = (
  url: string | UrlTree,
  options?: PreloadRouteOptions,
) => Promise<void>;

/**
 * Creates a function that preloads a route so that navigating to it later is faster.
 *
 * Must be called in an injection context. The returned function can be called at any time, which
 * makes it usable from event handlers such as `mouseenter` or `click`.
 *
 * Preloading performs the work that can be done ahead of time for a URL:
 *
 * 1. loads the dynamic imports needed to render the route (`loadConfig`, `loadChildren`, and
 *    `loadComponent`). The configurations and components along the URL are loaded together rather
 *    than one route at a time.
 * 2. when `includeData: true` is passed, executes the route's resolvers and `resources` (when
 *    `withRouterResources()` is configured).
 *
 * Preloading never activates the route, never emits `Router` events, and does not affect
 * `Router.url`, the current `RouterState`, or an in-flight navigation. Concurrent preloads do not
 * cancel each other, and concurrent calls for the same URL share a single preload.
 *
 * @usageNotes
 * ```ts
 * @Component({...})
 * export class LinkComponent {
 *   private readonly preloadRoute = injectPreloadRoute();
 *
 *   onHover(url: string) {
 *     this.preloadRoute(url);
 *   }
 * }
 * ```
 *
 * Note the following about how preloading behaves:
 *
 * * **No router state is retained.** Loaded configurations and components are cached on the
 *   `Route` definitions by the router. When `includeData: true` is enabled, resolver results and
 *   resource values are discarded once preloading finishes, so the subsequent navigation runs them
 *   again; only enable `includeData: true` when your data layer caches and deduplicates requests.
 * * **Guards are not executed.** Guards such as `canActivate` can prompt the user and would stall
 *   the preload, and `canMatch` is skipped as well so that preloading runs no guard code at all.
 *   Preloading therefore loads routes that a `canMatch` guard would have rejected, does not follow
 *   the redirects such a guard would have issued, and (when `includeData: true`) runs resolvers and
 *   resources for routes that the user may not be allowed to activate.
 * * **Failures are ignored.** The returned promise resolves when preloading completes and never
 *   rejects; a failure to preload (an unmatched URL, a failing resolver, etc.) is reported with a
 *   warning in development mode only.
 *
 * @returns A function that preloads the given URL and returns a promise that resolves when
 *     preloading has finished.
 *
 * @publicApi
 */
export function injectPreloadRoute(): PreloadRouteFn {
  const runner = inject(RoutePreloadRunner);
  return (url, options) => runner.preload(url, options);
}

/** A preload that is currently in progress, shared by all callers that requested the same URL. */
interface InFlightPreload {
  promise: Promise<void>;
  abortController: AbortController;
  /** Number of callers that have not (yet) aborted this preload. */
  consumers: number;
}

/**
 * Runs and deduplicates the preloads requested through `preloadRoute`.
 *
 * This is an implementation detail of `preloadRoute` and is tree-shaken away when `preloadRoute`
 * is not used.
 */
@Injectable({providedIn: 'root'})
export class RoutePreloadRunner {
  private readonly router = inject(Router);
  private readonly navigationTransitions = inject(NavigationTransitions);
  private readonly injector = inject(EnvironmentInjector);
  private readonly configLoader = inject(RouterConfigLoader);
  private readonly urlSerializer = inject(UrlSerializer);
  private readonly paramsInheritanceStrategy =
    inject(ROUTER_CONFIGURATION, {optional: true})?.paramsInheritanceStrategy ??
    DEFAULT_PARAMS_INHERITANCE_STRATEGY;
  private readonly resourcesFeature = inject(ROUTER_RESOURCES_FEATURE, {optional: true});
  private readonly inFlight = new Map<string, InFlightPreload>();

  constructor() {
    inject(DestroyRef).onDestroy(() => {
      for (const entry of this.inFlight.values()) {
        entry.abortController.abort();
      }
      this.inFlight.clear();
    });
  }

  preload(url: string | UrlTree, options?: PreloadRouteOptions): Promise<void> {
    const signal = options?.signal;
    if (signal?.aborted) {
      return Promise.resolve();
    }

    const includeData = options?.includeData ?? false;
    const waitForLoadConfig = !includeData || (options?.downstreamDeps?.loadConfig ?? true);
    const waitForResolvers = options?.downstreamDeps?.resolvers ?? true;

    const urlTree = typeof url === 'string' ? this.urlSerializer.parse(url) : url;
    const key = `${this.urlSerializer.serialize(urlTree)}|${includeData ? 1 : 0}:${waitForLoadConfig ? 1 : 0}:${waitForResolvers ? 1 : 0}`;

    let entry = this.inFlight.get(key);
    const isNewEntry = entry === undefined;
    if (entry === undefined) {
      entry = {
        abortController: new AbortController(),
        consumers: 0,
        promise: Promise.resolve(),
      };
      this.inFlight.set(key, entry);
    }

    // The in-flight preload is shared, so it may only be aborted once _all_ of the callers that
    // are waiting on it have aborted. Callers that did not provide a signal never abort.
    const currentEntry = entry;
    currentEntry.consumers++;
    const release = () => {
      if (--currentEntry.consumers === 0) {
        currentEntry.abortController.abort();
      }
    };
    signal?.addEventListener('abort', release, {once: true});

    // Start the work in a microtask rather than synchronously. Preloading runs synchronously until
    // it reaches its first pending request, which is far enough to load a component and to observe
    // an abort. Waiting gives every caller made in this task the chance to register above, so that
    // one caller aborting cannot discard work the others are still waiting for.
    if (isNewEntry) {
      currentEntry.promise = Promise.resolve()
        .then(() =>
          this.runPreload(
            urlTree,
            currentEntry.abortController.signal,
            includeData,
            waitForLoadConfig,
            waitForResolvers,
          ),
        )
        .finally(() => {
          if (this.inFlight.get(key) === currentEntry) {
            this.inFlight.delete(key);
          }
        });
    }
    if (signal) {
      void currentEntry.promise.then(() => signal.removeEventListener('abort', release));
    }

    return currentEntry.promise;
  }

  private async runPreload(
    urlTree: UrlTree,
    abortSignal: AbortSignal,
    includeData: boolean,
    waitForLoadConfig: boolean,
    waitForResolvers: boolean,
  ): Promise<void> {
    let currentTree = urlTree;

    for (let redirects = 0; redirects <= MAX_ALLOWED_REDIRECTS; redirects++) {
      if (abortSignal.aborted) {
        return;
      }

      try {
        // Route matching also loads the lazy `loadConfig` and `loadChildren` configs of the
        // matched routes in parallel.
        const {state: targetSnapshot, configLoadPromise} = await recognize(
          this.injector,
          this.configLoader,
          this.navigationTransitions.rootComponentType,
          this.router.config,
          currentTree,
          this.urlSerializer,
          this.paramsInheritanceStrategy,
          abortSignal,
          true,
          waitForLoadConfig,
        );
        if (abortSignal.aborted) {
          return;
        }

        const runData = async () => {
          if (!includeData) {
            return;
          }
          if (!waitForResolvers) {
            await Promise.all([
              resolveAllData(targetSnapshot, this.paramsInheritanceStrategy, abortSignal),
              this.resourcesFeature?.preloadResources(targetSnapshot, abortSignal),
            ]);
            return;
          }
          await resolveAllData(targetSnapshot, this.paramsInheritanceStrategy, abortSignal);
          if (abortSignal.aborted) {
            return;
          }
          await this.resourcesFeature?.preloadResources(targetSnapshot, abortSignal);
        };

        await Promise.all([
          configLoadPromise,
          loadComponents(targetSnapshot.root, this.configLoader),
          runData(),
        ]);
        return;
      } catch (e: unknown) {
        // `canMatch` guards and resolvers can redirect. Restart the preload with the new URL.
        if (isRedirectingNavigationCancelingError(e)) {
          currentTree = e.url;
          continue;
        }
        // Preloading is speculative: failures (no match, failing resolver, etc.) must not surface
        // to the caller, but they're worth reporting during development.
        if (typeof ngDevMode === 'undefined' || ngDevMode) {
          console.warn(
            `Unable to preload '${this.urlSerializer.serialize(currentTree)}'. ` +
              `This is not an error: preloading is speculative and this URL was skipped.`,
            e,
          );
        }
        return;
      }
    }

    if (typeof ngDevMode === 'undefined' || ngDevMode) {
      console.warn(
        `Unable to preload '${this.urlSerializer.serialize(urlTree)}': ` +
          `exceeded the maximum number of redirects (${MAX_ALLOWED_REDIRECTS}).`,
      );
    }
  }
}
