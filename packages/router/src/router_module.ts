/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {HashLocationStrategy, LOCATION_INITIALIZED, LocationStrategy, PathLocationStrategy, ViewportScroller} from '@angular/common';
import {APP_BOOTSTRAP_LISTENER, APP_INITIALIZER, ApplicationRef, ComponentRef, ENVIRONMENT_INITIALIZER, inject, InjectFlags, InjectionToken, Injector, ModuleWithProviders, NgModule, NgProbeToken, Optional, Provider, SkipSelf, Type, ɵRuntimeError as RuntimeError} from '@angular/core';
import {of, Subject} from 'rxjs';
import {filter, map, take} from 'rxjs/operators';

import {EmptyOutletComponent} from './components/empty_outlet';
import {RouterLink, RouterLinkWithHref} from './directives/router_link';
import {RouterLinkActive} from './directives/router_link_active';
import {RouterOutlet} from './directives/router_outlet';
import {RuntimeErrorCode} from './errors';
import {Event, NavigationCancel, NavigationCancellationCode, NavigationEnd, NavigationError, stringifyEvent} from './events';
import {Routes} from './models';
import {Router} from './router';
import {ExtraOptions, ROUTER_CONFIGURATION} from './router_config';
import {ROUTES} from './router_config_loader';
import {PreloadingStrategy, RouterPreloader} from './router_preloader';
import {RouterScroller} from './router_scroller';

const NG_DEV_MODE = typeof ngDevMode === 'undefined' || ngDevMode;

/**
 * The directives defined in the `RouterModule`.
 */
const ROUTER_DIRECTIVES =
    [RouterOutlet, RouterLink, RouterLinkWithHref, RouterLinkActive, EmptyOutletComponent];

/**
 * @docsNotRequired
 */
export const ROUTER_FORROOT_GUARD = new InjectionToken<void>(
    NG_DEV_MODE ? 'router duplicate forRoot guard' : 'ROUTER_FORROOT_GUARD');

export function routerNgProbeToken() {
  return new NgProbeToken('Router', Router);
}

/**
 * @description
 *
 * Adds directives and providers for in-app navigation among views defined in an application.
 * Use the Angular `Router` service to declaratively specify application states and manage state
 * transitions.
 *
 * You can import this NgModule multiple times, once for each lazy-loaded bundle.
 * However, only one `Router` service can be active.
 * To ensure this, there are two ways to register routes when importing this module:
 *
 * * The `forRoot()` method creates an `NgModule` that contains all the directives, the given
 * routes, and the `Router` service itself.
 * * The `forChild()` method creates an `NgModule` that contains all the directives and the given
 * routes, but does not include the `Router` service.
 *
 * @see [Routing and Navigation guide](guide/router) for an
 * overview of how the `Router` service should be used.
 *
 * @publicApi
 */
@NgModule({
  imports: ROUTER_DIRECTIVES,
  exports: ROUTER_DIRECTIVES,
})
export class RouterModule {
  private guard = inject(ROUTER_FORROOT_GUARD, {optional: true});

  /**
   * Creates and configures a module with all the router providers and directives.
   * Optionally sets up an application listener to perform an initial navigation.
   *
   * When registering the NgModule at the root, import as follows:
   *
   * ```
   * @NgModule({
   *   imports: [RouterModule.forRoot(ROUTES)]
   * })
   * class MyNgModule {}
   * ```
   *
   * @param routes An array of `Route` objects that define the navigation paths for the application.
   * @param config An `ExtraOptions` configuration object that controls how navigation is performed.
   * @return The new `NgModule`.
   *
   */
  static forRoot(routes: Routes, config?: ExtraOptions): ModuleWithProviders<RouterModule> {
    return {
      ngModule: RouterModule,
      providers: [
        NG_DEV_MODE ? (config?.enableTracing ? provideTracing() : []) : [],
        provideRoutes(routes),
        {
          provide: ROUTER_FORROOT_GUARD,
          useFactory: provideForRootGuard,
          deps: [[Router, new Optional(), new SkipSelf()]]
        },
        {provide: ROUTER_CONFIGURATION, useValue: config ? config : {}},
        config?.useHash ? provideHashLocationStrategy() : providePathLocationStrategy(),
        provideRouterScroller(),
        config?.preloadingStrategy ? providePreloading(config.preloadingStrategy) : [],
        {provide: NgProbeToken, multi: true, useFactory: routerNgProbeToken},
        config?.initialNavigation ? provideInitialNavigation(config) : [],
        provideRouterInitializer(),
      ],
    };
  }

  /**
   * Creates a module with all the router directives and a provider registering routes,
   * without creating a new Router service.
   * When registering for submodules and lazy-loaded submodules, create the NgModule as follows:
   *
   * ```
   * @NgModule({
   *   imports: [RouterModule.forChild(ROUTES)]
   * })
   * class MyNgModule {}
   * ```
   *
   * @param routes An array of `Route` objects that define the navigation paths for the submodule.
   * @return The new NgModule.
   *
   */
  static forChild(routes: Routes): ModuleWithProviders<RouterModule> {
    return {ngModule: RouterModule, providers: [provideRoutes(routes)]};
  }
}

export function provideRouterScroller(): Provider {
  return {
    provide: APP_BOOTSTRAP_LISTENER,
    multi: true,
    useFactory: () => {
      const viewportScroller = inject(ViewportScroller);
      const config: ExtraOptions = inject(ROUTER_CONFIGURATION);
      if (config.scrollOffset) {
        viewportScroller.setOffset(config.scrollOffset);
      }
      inject(RouterScroller).init();
    },
  };
}

function provideHashLocationStrategy(): Provider {
  return {provide: LocationStrategy, useClass: HashLocationStrategy};
}

function providePathLocationStrategy(): Provider {
  return {provide: LocationStrategy, useClass: PathLocationStrategy};
}

export function provideForRootGuard(router: Router): any {
  if (NG_DEV_MODE && router) {
    throw new RuntimeError(
        RuntimeErrorCode.FOR_ROOT_CALLED_TWICE,
        `RouterModule.forRoot() called twice. Lazy loaded modules should use RouterModule.forChild() instead.`);
  }
  return 'guarded';
}

/**
 * Registers a [DI provider](guide/glossary#provider) for a set of routes.
 * @param routes The route configuration to provide.
 *
 * @usageNotes
 *
 * ```
 * @NgModule({
 *   imports: [RouterModule.forChild(ROUTES)],
 *   providers: [provideRoutes(EXTRA_ROUTES)]
 * })
 * class MyNgModule {}
 * ```
 *
 * @publicApi
 */
export function provideRoutes(routes: Routes): Provider[] {
  return [
    {provide: ROUTES, multi: true, useValue: routes},
  ];
}


export function getBootstrapListener() {
  const injector = inject(Injector);
  return (bootstrappedComponentRef: ComponentRef<unknown>) => {
    const ref = injector.get(ApplicationRef);

    if (bootstrappedComponentRef !== ref.components[0]) {
      return;
    }

    const router = injector.get(Router);
    const bootstrapDone = injector.get(BOOTSTRAP_DONE);

    // Default case
    if (injector.get(INITIAL_NAVIGATION, null, InjectFlags.Optional) === null) {
      router.initialNavigation();
    }

    router.resetRootComponentType(ref.componentTypes[0]);
    bootstrapDone.next();
    bootstrapDone.complete();
  };
}

// TODO(atscott): This should not be in the public API
/**
 * A [DI token](guide/glossary/#di-token) for the router initializer that
 * is called after the app is bootstrapped.
 *
 * @publicApi
 */
export const ROUTER_INITIALIZER = new InjectionToken<(compRef: ComponentRef<any>) => void>(
    NG_DEV_MODE ? 'Router Initializer' : '');

function provideInitialNavigation(config: Pick<ExtraOptions, 'initialNavigation'>): Provider[] {
  return [
    config.initialNavigation === 'disabled' ? provideDisabledInitialNavigation() : [],
    config.initialNavigation === 'enabledBlocking' ? provideEnabledBlockingInitialNavigation() : [],
  ];
}

function provideRouterInitializer(): Provider[] {
  return [
    // ROUTER_INITIALIZER token should be removed. It's public API but shouldn't be. We can just
    // have `getBootstrapListener` directly attached to APP_BOOTSTRAP_LISTENER.
    {provide: ROUTER_INITIALIZER, useFactory: getBootstrapListener},
    {provide: APP_BOOTSTRAP_LISTENER, multi: true, useExisting: ROUTER_INITIALIZER},
  ];
}

/**
 * A subject used to indicate that the bootstrapping phase is done. When initial navigation is
 * `enabledBlocking`, the first navigation waits until bootstrapping is finished before continuing
 * to the activation phase.
 */
const BOOTSTRAP_DONE =
    new InjectionToken<Subject<void>>(NG_DEV_MODE ? 'bootstrap done indicator' : '', {
      factory: () => {
        return new Subject<void>();
      }
    });

function provideEnabledBlockingInitialNavigation(): Provider {
  return [
    {provide: INITIAL_NAVIGATION, useValue: 'enabledBlocking'},
    {
      provide: APP_INITIALIZER,
      multi: true,
      deps: [Injector],
      useFactory: (injector: Injector) => {
        const locationInitialized: Promise<any> =
            injector.get(LOCATION_INITIALIZED, Promise.resolve(null));
        let initNavigation = false;

        /**
         * Performs the given action once the router finishes its next/current navigation.
         *
         * If the navigation is canceled or errors without a redirect, the navigation is considered
         * complete. If the `NavigationEnd` event emits, the navigation is also considered complete.
         */
        function afterNextNavigation(action: () => void) {
          const router = injector.get(Router);
          router.events
              .pipe(
                  filter(
                      (e): e is NavigationEnd|NavigationCancel|NavigationError =>
                          e instanceof NavigationEnd || e instanceof NavigationCancel ||
                          e instanceof NavigationError),
                  map(e => {
                    if (e instanceof NavigationEnd) {
                      // Navigation assumed to succeed if we get `ActivationStart`
                      return true;
                    }
                    const redirecting = e instanceof NavigationCancel ?
                        (e.code === NavigationCancellationCode.Redirect ||
                         e.code === NavigationCancellationCode.SupersededByNewNavigation) :
                        false;
                    return redirecting ? null : false;
                  }),
                  filter((result): result is boolean => result !== null),
                  take(1),
                  )
              .subscribe(() => {
                action();
              });
        }

        return () => {
          return locationInitialized.then(() => {
            return new Promise(resolve => {
              const router = injector.get(Router);
              const bootstrapDone = injector.get(BOOTSTRAP_DONE);
              afterNextNavigation(() => {
                // Unblock APP_INITIALIZER in case the initial navigation was canceled or errored
                // without a redirect.
                resolve(true);
                initNavigation = true;
              });

              router.afterPreactivation = () => {
                // Unblock APP_INITIALIZER once we get to `afterPreactivation`. At this point, we
                // assume activation will complete successfully (even though this is not
                // guaranteed).
                resolve(true);
                // only the initial navigation should be delayed until bootstrapping is done.
                if (!initNavigation) {
                  return bootstrapDone.closed ? of(void 0) : bootstrapDone;
                  // subsequent navigations should not be delayed
                } else {
                  return of(void 0);
                }
              };
              router.initialNavigation();
            });
          });
        };
      }
    },
  ];
}

const INITIAL_NAVIGATION =
    new InjectionToken<'disabled'|'enabledBlocking'>(NG_DEV_MODE ? 'initial navigation' : '');

function provideDisabledInitialNavigation(): Provider[] {
  return [
    {
      provide: APP_INITIALIZER,
      multi: true,
      useFactory: () => {
        const router = inject(Router);
        return () => {
          router.setUpLocationChangeListener();
        };
      }
    },
    {provide: INITIAL_NAVIGATION, useValue: 'disabled'}
  ];
}

function provideTracing(): Provider[] {
  if (NG_DEV_MODE) {
    return [{
      provide: ENVIRONMENT_INITIALIZER,
      multi: true,
      useFactory: () => {
        const router = inject(Router);
        return () => router.events.subscribe((e: Event) => {
          // tslint:disable:no-console
          console.group?.(`Router Event: ${(<any>e.constructor).name}`);
          console.log(stringifyEvent(e));
          console.log(e);
          console.groupEnd?.();
          // tslint:enable:no-console
        });
      }
    }];
  } else {
    return [];
  }
}

export function providePreloading(preloadingStrategy: Type<PreloadingStrategy>): Provider[] {
  return [
    RouterPreloader, {provide: PreloadingStrategy, useExisting: preloadingStrategy}, {
      provide: APP_BOOTSTRAP_LISTENER,
      multi: true,
      useFactory: () => {
        inject(RouterPreloader).setUpPreloading();
      },
    }
  ];
}
