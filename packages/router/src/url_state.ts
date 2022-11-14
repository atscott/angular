/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import {Location} from '@angular/common';
import {inject, Injectable} from '@angular/core';

import {NavigationCancellationCode} from './events';
import {isNavigationCancelingError, isRedirectingNavigationCancelingError} from './navigation_canceling_error';
import {NavigationTransition, RestoredState} from './router';
import {ROUTER_CONFIGURATION} from './router_config';
import {RouterState} from './router_state';
import {RouterStateEventType, RouterStateModerator} from './router_state_moderator';
import {DefaultUrlHandlingStrategy, UrlHandlingStrategy} from './url_handling_strategy';
import {createEmptyUrlTree, UrlSerializer, UrlTree} from './url_tree';

@Injectable({providedIn: 'root'})
export class UrlState {
  /**
   * Represents the activated `UrlTree` that the `Router` is configured to handle (through
   * `UrlHandlingStrategy`). That is, after we find the route config tree that we're going to
   * activate, run guards, and are just about to activate the route, we set the currentUrlTree.
   *
   * This should match the `browserUrlTree` when a navigation succeeds. If the
   * `UrlHandlingStrategy.shouldProcessUrl` is `false`, only the `browserUrlTree` is updated.
   */
  private currentUrlTree: UrlTree;
  /**
   * Meant to represent the entire browser url after a successful navigation. In the life of a
   * navigation transition:
   * 1. The rawUrl represents the full URL that's being navigated to
   * 2. We apply redirects, which might only apply to _part_ of the URL (due to
   * `UrlHandlingStrategy`).
   * 3. Right before activation (because we assume activation will succeed), we update the
   * rawUrlTree to be a combination of the urlAfterRedirects (again, this might only apply to part
   * of the initial url) and the rawUrl of the transition (which was the original navigation url in
   * its full form).
   */
  private rawUrlTree: UrlTree;

  /**
   * The id of the currently active page in the router.
   * Updated to the transition's target id on a successful navigation.
   *
   * This is used to track what page the router last activated. When an attempted navigation fails,
   * the router can then use this to compute how to restore the state back to the previously active
   * page.
   */
  private currentPageId: number = 0;
  private targetPageId: number = 0;

  /**
   * The ɵrouterPageId of whatever page is currently active in the browser history. This is
   * important for computing the target page id for new navigations because we need to ensure each
   * page id in the browser history is 1 more than the previous entry.
   */
  private get browserPageId(): number|undefined {
    return (this.location.getState() as RestoredState | null)?.ɵrouterPageId;
  }

  lastSuccessfulRawUrlTree: UrlTree;
  lastSuccessfulRouterUrlTree: UrlTree;
  private lastSuccessfulId: number = -1;

  private readonly urlUpdateStrategy = inject(ROUTER_CONFIGURATION).urlUpdateStrategy ?? 'deferred';
  private readonly urlHandlingStrategy =
      inject(UrlHandlingStrategy) ?? new DefaultUrlHandlingStrategy();
  private readonly canceledNavigationResolution =
      inject(ROUTER_CONFIGURATION).canceledNavigationResolution ?? 'replace';

  constructor(
      private readonly location: Location,
      private urlSerializer: UrlSerializer,
      routerStateModerator: RouterStateModerator,
  ) {
    this.currentUrlTree = createEmptyUrlTree();
    this.rawUrlTree = this.currentUrlTree;
    this.lastSuccessfulRawUrlTree = this.currentUrlTree;
    this.lastSuccessfulRouterUrlTree = this.currentUrlTree;
    routerStateModerator.events.subscribe(e => {
      if (e.type === RouterStateEventType.NavigationEnd) {
        this.lastSuccessfulId = e.navigation.id;
        this.currentPageId = this.targetPageId;
        this.lastSuccessfulRawUrlTree = e.navigation.urlAfterRedirects!;
        this.lastSuccessfulRouterUrlTree = e.navigation!.extractedUrl;
      }
      if (e.type === RouterStateEventType.NavigationStart) {
        // browserUrlTree is updated before redirects sometimes...
        // TODO: this state actually comes from the popstate navs. Where can we get this
        // information? Maybe we should have the location change listener here instead of in the
        // Router?
        let restoredState = e.navigation.restoredState;

        let targetPageId: number;
        const isInitialPage = this.currentPageId === 0;
        if (isInitialPage) {
          restoredState = this.location.getState() as RestoredState | null;
        }
        // If the `ɵrouterPageId` exist in the state then `targetpageId` should have the value of
        // `ɵrouterPageId`. This is the case for something like a page refresh where we assign the
        // target id to the previously set value for that page.
        if (restoredState && restoredState.ɵrouterPageId) {
          targetPageId = restoredState.ɵrouterPageId;
        } else {
          // If we're replacing the URL or doing a silent navigation, we do not want to increment
          // the page id because we aren't pushing a new entry to history.
          const replaceUrl = !!e.navigation.extras?.replaceUrl;
          const skipLocationChange = !!e.navigation.extras?.skipLocationChange;
          if (replaceUrl || skipLocationChange) {
            targetPageId = this.browserPageId ?? 0;
          } else {
            targetPageId = (this.browserPageId ?? 0) + 1;
          }
        }
        this.targetPageId = targetPageId;
      }
      if (e.type === RouterStateEventType.RoutesRecognized) {
        if (this.urlUpdateStrategy === 'eager') {
          const t = e.navigation;
          if (!t.extras.skipLocationChange) {
            const rawUrl = this.urlHandlingStrategy.merge(t.urlAfterRedirects!, t.rawUrl);
            this.setBrowserUrl(rawUrl, e.navigation);
          }
        }
      }
      if (e.type === RouterStateEventType.OutletActivationStart) {
        const t = e.navigation;
        this.currentUrlTree = t.urlAfterRedirects!;
        this.rawUrlTree = this.urlHandlingStrategy.merge(t.urlAfterRedirects!, t.rawUrl);
        if (this.urlUpdateStrategy === 'deferred') {
          if (!t.extras.skipLocationChange) {
            this.setBrowserUrl(this.rawUrlTree, e.navigation);
          }
        }
      }

      if (e.type === RouterStateEventType.NavigationCancel) {
        if (e.routerEvent.code === NavigationCancellationCode.GuardRejected ||
            e.routerEvent.code === NavigationCancellationCode.NoDataFromResolver) {
          // TODO: This is slightly different For CanLoad guard rejection: in the Router, this is
          // done by throwing an error. That would pass `true` to the `restoreHistory` function and
          // subsequently call `resetState`. That said, this doesn't matter because `canLoad` is so
          // early that `resetState` would be a no-op.
          this.restoreHistory(e.navigation);
        }
      }
      if (e.type === RouterStateEventType.NavigationError) {
        this.restoreHistory(e.navigation, true);
      }
    });
  }

  private setBrowserUrl(url: UrlTree, t: NavigationTransition) {
    const path = this.urlSerializer.serialize(url);
    const state = {...t.extras.state, ...this.generateNgRouterState(t.id, this.targetPageId)};
    if (this.location.isCurrentPathEqualTo(path) || !!t.extras.replaceUrl) {
      this.location.replaceState(path, '', state);
    } else {
      this.location.go(path, '', state);
    }
  }

  /**
   * Performs the necessary rollback action to restore the browser URL to the
   * state before the transition.
   */
  private restoreHistory(t: NavigationTransition, restoringFromCaughtError = false) {
    if (this.canceledNavigationResolution === 'computed') {
      const targetPagePosition = this.currentPageId - this.targetPageId;
      // The navigator change the location before triggered the browser event,
      // so we need to go back to the current url if the navigation is canceled.
      // Also, when navigation gets cancelled while using url update strategy eager, then we need to
      // go back. Because, when `urlUpdateStrategy` is `eager`; `setBrowserUrl` method is called
      // before any verification.
      const browserUrlUpdateOccurred =
          (t.source === 'popstate' || this.urlUpdateStrategy === 'eager' ||
           this.currentUrlTree === t.urlAfterRedirects);
      if (browserUrlUpdateOccurred && targetPagePosition !== 0) {
        this.location.historyGo(targetPagePosition);
      } else if (this.currentUrlTree === t.urlAfterRedirects && targetPagePosition === 0) {
        // We got to the activation stage (where currentUrlTree is set to the navigation's
        // finalUrl), but we weren't moving anywhere in history (skipLocationChange or replaceUrl).
        // We still need to reset the router state back to what it was when the navigation started.
        this.resetState(t);
        this.resetUrlToCurrentUrlTree();
      } else {
        // The browser URL and router state was not updated before the navigation cancelled so
        // there's no restoration needed.
      }
    } else if (this.canceledNavigationResolution === 'replace') {
      // TODO(atscott): It seems like we should _always_ reset the state here. It would be a no-op
      // for `deferred` navigations that haven't change the internal state yet because guards
      // reject. For 'eager' navigations, it seems like we also really should reset the state
      // because the navigation was cancelled. Investigate if this can be done by running TGP.
      if (restoringFromCaughtError) {
        this.resetState(t);
      }
      this.resetUrlToCurrentUrlTree();
    }
  }

  private resetState(t: NavigationTransition): void {
    // (this as {routerState: RouterState}).routerState = t.currentRouterState;
    this.currentUrlTree = t.currentUrlTree;
    // Note here that we use the urlHandlingStrategy to get the reset `rawUrlTree` because it may be
    // configured to handle only part of the navigation URL. This means we would only want to reset
    // the part of the navigation handled by the Angular router rather than the whole URL. In
    // addition, the URLHandlingStrategy may be configured to specifically preserve parts of the URL
    // when merging, such as the query params so they are not lost on a refresh.
    this.rawUrlTree = this.urlHandlingStrategy.merge(this.currentUrlTree, t.rawUrl);
  }

  private resetUrlToCurrentUrlTree(): void {
    this.location.replaceState(
        this.urlSerializer.serialize(this.rawUrlTree), '',
        this.generateNgRouterState(this.lastSuccessfulId, this.currentPageId));
  }

  private generateNgRouterState(navigationId: number, routerPageId?: number) {
    if (this.canceledNavigationResolution === 'computed') {
      return {navigationId, ɵrouterPageId: routerPageId};
    }
    return {navigationId};
  }
}
