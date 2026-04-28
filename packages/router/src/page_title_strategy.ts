/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {inject, EffectRef, Injector, Resource, effect, Service} from '@angular/core';
import {Title} from '@angular/platform-browser';

import {ActivatedRouteSnapshot, RouterStateSnapshot} from './router_state';
import {PRIMARY_OUTLET, RouteTitleKey} from './shared';
import {
  ROUTER_RESOURCES_FEATURE,
  RouterResourcesFeatureImplementation,
} from './resource_implementation_tokens';

/**
 * Provides a strategy for setting the page title after a router navigation.
 *
 * The built-in implementation traverses the router state snapshot and finds the deepest primary
 * outlet with `title` property. Given the `Routes` below, navigating to
 * `/base/child(popup:aux)` would result in the document title being set to "child".
 * ```ts
 * [
 *   {path: 'base', title: 'base', children: [
 *     {path: 'child', title: 'child'},
 *   ],
 *   {path: 'aux', outlet: 'popup', title: 'popupTitle'}
 * ]
 * ```
 *
 * This class can be used as a base class for custom title strategies. That is, you can create your
 * own class that extends the `TitleStrategy`. Note that in the above example, the `title`
 * from the named outlet is never used. However, a custom strategy might be implemented to
 * incorporate titles in named outlets.
 *
 * @publicApi
 * @see [Page title guide](guide/routing/define-routes#using-titlestrategy-for-page-titles)
 */
@Service({factory: () => inject(DefaultTitleStrategy)})
export abstract class TitleStrategy {
  /** Performs the application title update. */
  abstract updateTitle(snapshot: RouterStateSnapshot): void;

  /** @internal */
  currentTitleResource?: Resource<unknown>;

  /** @internal */
  protected readonly resourcesFeature?: RouterResourcesFeatureImplementation | null;

  constructor() {
    try {
      this.resourcesFeature = inject(ROUTER_RESOURCES_FEATURE, {optional: true});
    } catch {
      // ignore injection errors
    }

    this.resourcesFeature?.initializeTitleStrategy(this);
  }

  /**
   * @returns The `title` of the deepest primary route.
   */
  buildTitle(snapshot: RouterStateSnapshot): string | undefined {
    let pageTitle: string | undefined;
    let route: ActivatedRouteSnapshot | undefined = snapshot.root;
    while (route !== undefined) {
      pageTitle = this.getResolvedTitleForRoute(route) ?? pageTitle;
      route = route.children.find((child) => child.outlet === PRIMARY_OUTLET);
    }
    return pageTitle;
  }

  /**
   * Given an `ActivatedRouteSnapshot`, returns the final value of the
   * `Route.title` property, which can either be a static string or a resolved value.
   */
  getResolvedTitleForRoute(snapshot: ActivatedRouteSnapshot): string | undefined {
<<<<<<< HEAD
    return snapshot.data[RouteTitleKey];
=======
    const defaultTitle = snapshot.data[RouteTitleKey];
    if (defaultTitle !== undefined) {
      this.currentTitleResource = undefined; // Clear it! Static title wins!
      return defaultTitle;
    }
    return undefined;
>>>>>>> 66f0934653 (wip)
  }
}

/**
 * The default `TitleStrategy` used by the router that updates the title using the `Title` service.
 */
@Service()
export class DefaultTitleStrategy extends TitleStrategy {
  private currentEffect?: EffectRef;
  private injector = inject(Injector);
  private readonly title = inject(Title);

  constructor() {
    super();
  }

  /**
   * Sets the title of the browser to the given value.
   *
   * @param title The `pageTitle` from the deepest primary route.
   */
  override updateTitle(snapshot: RouterStateSnapshot): void {
    this.currentEffect?.destroy();
    this.currentTitleResource = undefined; // Reset before buildTitle!

    const title = this.buildTitle(snapshot);

    if (this.currentTitleResource) {
      this.currentEffect = this.resourcesFeature?.titleRunner(
        this.currentTitleResource,
        this.title,
        this.injector,
      );
    } else if (title !== undefined) {
      // It's a static string! No effect needed!
      this.title.setTitle(title);
    }
  }
}

export function initializeTitleStrategy(strategy: TitleStrategy): void {
  const original = strategy.getResolvedTitleForRoute.bind(strategy);
  strategy.getResolvedTitleForRoute = (snapshot: ActivatedRouteSnapshot) => {
    const res = snapshot.resources?.title;
    if (res) {
      strategy.currentTitleResource = res;
      const val = res.value();
      return typeof val === 'string' ? val : undefined;
    }
    return original(snapshot);
  };
}

export function titleRunner(
  titleResource: Resource<unknown>,
  titleService: Title,
  injector: Injector,
): EffectRef {
  let lastTitle: string | undefined = undefined;
  return effect(
    () => {
      const currentVal = titleResource.value();
      if (typeof currentVal === 'string') {
        lastTitle = currentVal;
      }
      if (lastTitle !== undefined) {
        titleService.setTitle(lastTitle);
      }
    },
    {injector},
  );
}
