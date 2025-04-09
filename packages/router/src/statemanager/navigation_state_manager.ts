/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import {PlatformLocation, ɵPlatformNavigation as PlatformNavigation} from '@angular/common';
import {EnvironmentInjector, inject, Injectable, afterNextRender} from '@angular/core';
import {Subject, SubscriptionLike} from 'rxjs';

import {
  BeforeActivateRoutes,
  BeforeRoutesRecognized,
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  NavigationTrigger,
  PrivateRouterEvents,
} from '../events';
import {Navigation, RestoredState} from '../navigation_transition';

import {StateManager} from './state_manager';
import {ROUTER_SCROLLER} from '../router_scroller';
import {ROUTER_CONFIGURATION} from '../router_config';

type NavigationInfo = RouterTransitionNavigationInfo | RollbackNavigationInfo;

/// <reference types="dom-navigation" />

interface RouterTransitionNavigationInfo {
  intercept: true;
  focusReset: 'after-transition' | 'manual';
  scroll: 'after-transition' | 'manual';
}

interface RollbackNavigationInfo {
  intercept: false;
}

@Injectable({providedIn: 'root'})
export class NavigationStateManager extends StateManager {
  private readonly base = new URL(inject(PlatformLocation).href).origin;
  private readonly appRootURL = new URL(this.location.prepareExternalUrl?.('/') ?? '/', this.base)
    .href;
  private readonly navigation = inject(PlatformNavigation);
  private readonly injector = inject(EnvironmentInjector);
  private readonly inMemoryScrollingEnabled = inject(ROUTER_SCROLLER, {optional: true}) !== null;

  /**
   * The NavigationHistoryEntry for the active state. This enables restoring history if an ongoing
   * navigation cancels.
   */
  private activeHistoryEntry: NavigationHistoryEntry = this.navigation.currentEntry!;

  override restoredState(): RestoredState | null | undefined {
    return this.navigation.currentEntry!.getState() as RestoredState | null | undefined;
  }

  private nonRouterCurrentEntryChangeSubject = new Subject<{
    path: string;
    state: RestoredState | null | undefined;
  }>();

  private currentNavigation: {
    routerTransition?: Navigation;
    navigateEvent?: NavigateEvent;
    commitUrl?: () => Promise<void>;
    rejectNavigateEvent?: () => void;
    resolvePostCommitHandler?: () => void;
    removeAbortListener?: () => void;
  } = {};

  constructor() {
    super();

    const options = inject(ROUTER_CONFIGURATION, {optional: true}) || {};
    if (options.canceledNavigationResolution === 'replace') {
      throw new Error(
        'Navigation API-based router only supports `computed` canceledNavigationResolution.',
      );
    }
    this.navigation.addEventListener('navigate', (event: NavigateEvent) => {
      this.handleNavigate(event);
    });
    this.navigation.addEventListener('navigatesuccess', () => {
      this.activeHistoryEntry = this.navigation.currentEntry!;
    });
  }

  registered = false;
  override registerNonRouterCurrentEntryChangeListener(
    listener: (
      url: string,
      state: RestoredState | null | undefined,
      trigger: NavigationTrigger,
    ) => void,
  ): SubscriptionLike {
    this.registered = true;
    return this.nonRouterCurrentEntryChangeSubject.subscribe(({path, state}) => {
      listener(path, state, 'navigate');
    });
  }

  override async handleRouterEvent(
    e: Event | PrivateRouterEvents,
    transition: Navigation,
  ): Promise<void> {
    this.currentNavigation.routerTransition = transition;
    if (e instanceof NavigationStart) {
      this.updateStateMemento();
      const path = this.createBrowserPath(transition);
      if (!this.currentNavigation.navigateEvent) {
        // we don't have a navigate event yet for this router transition. create one
        onNextNavigateEventWithRouterInfo(this.navigation, () =>
          transition.navigationStartHandled.next(true),
        );
        this.navigate(path, transition);
      } else {
        transition.navigationStartHandled.next(true);
      }
    } else if (e instanceof NavigationSkipped) {
      this.finishNavigation();
      this.commitTransition(transition);
    } else if (e instanceof BeforeRoutesRecognized) {
      if (this.urlUpdateStrategy === 'eager') {
        await this.currentNavigation.commitUrl?.();
      }
      transition.routesRecognizeHandled.next(true);
    } else if (e instanceof BeforeActivateRoutes) {
      if (this.urlUpdateStrategy === 'deferred') {
        await this.currentNavigation.commitUrl?.();
      }
      // TODO(atscott): Add test which covers the need for moving commitTransition to after the URL commit
      // There was a problem with a navigation being cancelled after the commit transition but before the
      // commit URL finished. And then the rollback is skipped as well.
      // Also, while moving this to after the commit is probably the right move, it was likely only necessary
      // for that failing test because there's something off with the internal state restoration on canceled
      // navigations. It probably needs to be called in more situations. History would advance synchronously
      // to the activation stage after synchronously setting the URL so there was no opportunity to cancel
      // a navigation there. Now there is so that probably presents a problem where state needs to be reset.
      // Also check what happens if navigation is cancelled while we are waiting for the commit. I think
      // maybe the commitUrl rejects? But not sure.
      this.commitTransition(transition);
      transition.beforeActivateHandled.next(true);
    } else if (e instanceof NavigationCancel || e instanceof NavigationError) {
      // we want to retain the navigate event through the redirect
      // However, if we already committed the URL, then we have to cancel the navigation and start a new one
      const redirectingBeforeUrlCommit =
        e instanceof NavigationCancel &&
        e.code === NavigationCancellationCode.Redirect &&
        !!this.currentNavigation.commitUrl;
      if (redirectingBeforeUrlCommit) {
        return;
      }
      void this.cancel(transition, e);
    } else if (e instanceof NavigationEnd) {
      const {removeAbortListener, resolvePostCommitHandler} = this.currentNavigation;
      this.currentNavigation = {};
      removeAbortListener?.();
      afterNextRender({read: () => resolvePostCommitHandler?.()}, {injector: this.injector});
    }
  }

  private finishNavigation() {
    this.currentNavigation.commitUrl?.();
    this.currentNavigation?.resolvePostCommitHandler?.();
    this.currentNavigation = {};
  }

  private navigate(internalPath: string, transition: Navigation) {
    const path = transition.extras.skipLocationChange
      ? this.navigation.currentEntry!.url!
      : this.location.prepareExternalUrl(internalPath);
    const state = {
      ...transition.extras.state,
      navigationId: transition.id, // history state manager does this and it's on the RestoredState type...
    };
    const ɵrouterInfo: RouterTransitionNavigationInfo = {
      intercept: true,
      focusReset: 'manual',
      scroll: this.inMemoryScrollingEnabled ? 'manual' : 'after-transition',
    };

    const info = {ɵrouterInfo};
    const history =
      this.location.isCurrentPathEqualTo(path) ||
      transition.extras.replaceUrl ||
      transition.extras.skipLocationChange
        ? 'replace'
        : 'push';
    handleResultRejections(
      this.navigation.navigate(path, {
        state,
        history,
        info,
      }),
    );
  }

  private async cancel(transition: Navigation, event: NavigationCancel | NavigationError) {
    const {currentNavigation} = this;

    currentNavigation.rejectNavigateEvent?.();
    const clearedState = {};
    this.currentNavigation = clearedState;

    // kind of have no choice but to wait because we need to not do a rollback if
    // the navigation was canceled due to another navigation coming in (i.e. 2 back button clicks)
    // the abort of the previous one happens first and we don't have a way to observe
    // that another one is happening
    if (
      event instanceof NavigationCancel &&
      event.code !== NavigationCancellationCode.GuardRejected &&
      event.code !== NavigationCancellationCode.NoDataFromResolver
    ) {
      await new Promise((resolve) => setTimeout(resolve));
    }

    // skip rollback if we already moved on to a new navigation
    if (this.currentNavigation !== clearedState) {
      return;
    }

    if (this.navigation.currentEntry!.id === this.activeHistoryEntry.id) {
      // nothing to roll back. Finish cleanup and return
      return;
    }

    const ɵrouterInfo: RollbackNavigationInfo = {intercept: false};
    this.resetInternalState(transition);
    if (this.navigation.currentEntry!.key !== this.activeHistoryEntry.key) {
      handleResultRejections(
        this.navigation.traverseTo(this.activeHistoryEntry.key, {info: {ɵrouterInfo}}),
      );
    } else {
      // If ID differs but key is the same, we were doing a replace navigation
      handleResultRejections(
        this.navigation.navigate(this.urlSerializer.serialize(this.getCurrentUrlTree()), {
          state: this.activeHistoryEntry.getState(),
          history: 'replace',
          info: {ɵrouterInfo},
        }),
      );
    }
  }

  private handleNavigate(event: NavigateEvent) {
    this.currentNavigation = {
      routerTransition: this.currentNavigation.routerTransition,
    };
    if (!event.canIntercept) {
      return;
    }

    const routerInfo = ((event?.info as any)?.ɵrouterInfo as NavigationInfo) ?? null;
    if (routerInfo && !routerInfo.intercept) {
      return;
    }

    this.currentNavigation.navigateEvent = event;
    const abortHandler = () => {
      this.currentNavigation.routerTransition?.abort();
    };
    event.signal.addEventListener('abort', abortHandler);
    this.currentNavigation.removeAbortListener = () =>
      event.signal.removeEventListener('abort', abortHandler);

    let resolveCommitted: () => void;
    // TODO(atscott): Change to Navigation.transition.committed (https://github.com/WICG/navigation-api/issues/285)
    const committed = new Promise<void>((resolve) => {
      resolveCommitted = resolve;
    });
    const interceptOptions: NavigationInterceptOptions = {};
    if (
      // cannot defer commit if not cancelable
      event.cancelable &&
      // defering a traversal is broken at the moment
      event.navigationType !== 'traverse'
    ) {
      let redirect: ((url: string) => void) | null = null;
      let commit: () => Promise<void>;
      const precommitHandlerPromise = new Promise<void>((resolve, reject) => {
        this.currentNavigation.rejectNavigateEvent = () => {
          event.signal.removeEventListener('abort', abortHandler);
          reject();
        };
        commit = () => {
          resolve();
          return committed;
        };
      });
      // Prevent unhandled rejections if ZoneJS microtasks queue drain causes this to reject before its handled by Navigation
      precommitHandlerPromise.catch(() => {});
      // cast to any because deferred commit isn't yet in the spec
      (interceptOptions as any).precommitHandler = (controller: any) => {
        redirect = controller.redirect;
        return precommitHandlerPromise;
      };
      this.currentNavigation.commitUrl = async () => {
        this.currentNavigation.commitUrl = undefined;

        const transition = this.currentNavigation.routerTransition;
        if (transition === undefined || redirect === null) {
          return await commit();
        }
        const internalPath = this.createBrowserPath(transition);
        // this might be a path or an actual URL depending on the baseHref
        const pathOrUrl = this.location.prepareExternalUrl(internalPath);
        if (event.navigationType !== 'traverse') {
          if (!transition.extras.skipLocationChange) {
            // TODO(atscott): Should add correct state, not just update URL
            redirect(pathOrUrl);
          }
          await commit();
          return;
        }

        await commit();
        const eventDestination = new URL(event.destination.url);
        if (new URL(pathOrUrl, eventDestination.origin).href === eventDestination.href) {
          return;
        }

        await this.commitRedirectedTraversal(internalPath, transition);
      };
    }

    let rejectPostCommitHandler: () => void;
    const postCommitHandler = new Promise<void>((resolve, reject) => {
      rejectPostCommitHandler = () => {
        event.signal.removeEventListener('abort', abortHandler);
        reject();
      };
      this.currentNavigation.resolvePostCommitHandler = () => {
        event.signal.removeEventListener('abort', abortHandler);
        resolve();
      };
    });
    interceptOptions.handler = () => {
      resolveCommitted();
      this.currentNavigation.rejectNavigateEvent = rejectPostCommitHandler;
      return postCommitHandler;
    };

    event.intercept(interceptOptions);

    // navigate event from outside router.
    const isTriggeredByRouterTransition = !!routerInfo;
    if (!isTriggeredByRouterTransition) {
      this.handleNavigateEventTriggeredOutsideRouterAPIs(event);
    }
  }

  /**
   * Does a best effort at handling a traversal that gets redirected
   *
   * You can't truly redirect a traverse so we start a new one with `replace`.
   *
   * TODO(atscott): We don't actually have any test cases covering this logic
   * presumably it could happen if an auth cookie times out and your
   * traversal to a page requiring auth is then redirected
   */
  private commitRedirectedTraversal(redirectedPath: string, currentTransition: Navigation) {
    this.currentNavigation.resolvePostCommitHandler?.();
    this.currentNavigation.removeAbortListener?.();
    return new Promise<void>((resolve) => {
      onNextNavigateEventWithRouterInfo(this.navigation, async () => {
        await this.currentNavigation.commitUrl?.();
        resolve();
      });
      this.navigate(redirectedPath, {
        ...currentTransition,
        extras: {...currentTransition.extras, replaceUrl: true},
      });
    });
  }

  private handleNavigateEventTriggeredOutsideRouterAPIs(event: NavigateEvent) {
    if (!this.registered) {
      // Don't convert events to router events until we're supposed to be listening
      this.finishNavigation();
      return;
    }
    // TODO: if destination URL doesn't start with the appRootURL, should probably finishNavigation or not even intercept in the first place
    const path = event.destination.url.substring(this.appRootURL.length - 1);
    const state = event.destination.getState() as RestoredState | null | undefined;
    this.nonRouterCurrentEntryChangeSubject.next({path, state});
  }
}

function handleResultRejections(result: NavigationResult): NavigationResult {
  result.finished.catch(() => {});
  result.committed.catch(() => {});
  return result;
}

function onNextNavigateEventWithRouterInfo(
  navigation: PlatformNavigation,
  fn: (e: NavigateEvent) => void,
) {
  const navigateHandler = (e: NavigateEvent) => {
    if (!(e.info as {ɵrouterInfo: unknown})?.ɵrouterInfo) {
      return;
    }
    fn(e);
    navigation.removeEventListener('navigate', navigateHandler);
  };
  navigation.addEventListener('navigate', navigateHandler);
}
