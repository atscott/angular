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
 * 1. loads the dynamic imports needed to render the route (`loadChildren` and `loadComponent`)
 * 2. executes the route's resolvers
 * 3. executes the route's resources, when `withRouterResources()` is configured
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
 * * **No router state is retained.** Resolver results and resource values are discarded once
 *   preloading finishes, so the subsequent navigation runs them again. The benefit of preloading
 *   comes from the lazy chunks that stay loaded and from the caches that sit underneath the data
 *   loading (an HTTP cache, a service worker, or a cache in the application's own data layer).
 *   Preloading a resolver or resource that does not read through such a cache only costs an extra
 *   request.
 * * **Guards are not executed**, aside from `canMatch`, because guards such as `canActivate` can
 *   prompt the user and would stall the preload. As a result, resolvers and resources run for
 *   routes that the user may not be allowed to activate. Do not preload routes whose data loading
 *   has side effects or whose requests would fail authorization.
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
  return (url, options) => runner.preload(url, options?.signal);
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

  preload(url: string | UrlTree, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.resolve();
    }

    const urlTree = typeof url === 'string' ? this.urlSerializer.parse(url) : url;
    const key = this.urlSerializer.serialize(urlTree);

    let entry = this.inFlight.get(key);
    if (entry === undefined) {
      const abortController = new AbortController();
      const newEntry: InFlightPreload = {
        abortController,
        consumers: 0,
        promise: Promise.resolve(),
      };
      newEntry.promise = this.runPreload(urlTree, abortController.signal).finally(() => {
        if (this.inFlight.get(key) === newEntry) {
          this.inFlight.delete(key);
        }
      });
      this.inFlight.set(key, newEntry);
      entry = newEntry;
    }

    // The in-flight preload is shared, so it may only be aborted once _all_ of the callers that
    // are waiting on it have aborted. Callers that did not provide a signal never abort.
    const currentEntry = entry;
    currentEntry.consumers++;
    if (signal) {
      const release = () => {
        if (--currentEntry.consumers === 0) {
          currentEntry.abortController.abort();
        }
      };
      signal.addEventListener('abort', release, {once: true});
      void currentEntry.promise.then(() => signal.removeEventListener('abort', release));
    }

    return currentEntry.promise;
  }

  private async runPreload(urlTree: UrlTree, abortSignal: AbortSignal): Promise<void> {
    let currentTree = urlTree;

    for (let redirects = 0; redirects <= MAX_ALLOWED_REDIRECTS; redirects++) {
      if (abortSignal.aborted) {
        return;
      }

      try {
        // Route matching also loads the lazy `loadChildren` configs of the matched routes.
        const {state: targetSnapshot} = await recognize(
          this.injector,
          this.configLoader,
          this.navigationTransitions.rootComponentType,
          this.router.config,
          currentTree,
          this.urlSerializer,
          this.paramsInheritanceStrategy,
          abortSignal,
          // `canLoad` is deprecated and pending removal. Unlike `canMatch`, it cannot affect which
          // route matches, so preloading always loads the config without running it.
          /* skipCanLoadGuards */ true,
        );
        if (abortSignal.aborted) {
          return;
        }

        await loadComponents(targetSnapshot.root, this.configLoader);
        if (abortSignal.aborted) {
          return;
        }

        await resolveAllData(targetSnapshot, this.paramsInheritanceStrategy, abortSignal);
        if (abortSignal.aborted) {
          return;
        }

        await this.resourcesFeature?.preloadResources(targetSnapshot, abortSignal);
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
