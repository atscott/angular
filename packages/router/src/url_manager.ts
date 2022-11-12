import {Location} from '@angular/common';
import {inject, Injectable} from '@angular/core';

import {EventType, NavigationEnd, NavigationStart, RoutesRecognized} from './events';
import {NavigationTransition, RestoredState} from './router';
import {ROUTER_CONFIGURATION} from './router_config';
import {RouterStateModerator} from './router_state_moderator';
import {DefaultUrlHandlingStrategy, UrlHandlingStrategy} from './url_handling_strategy';
import {createEmptyUrlTree, UrlSerializer, UrlTree} from './url_tree';

@Injectable({providedIn: 'root'})
export class ComputedUrlManager {
  /**
   * Represents the activated `UrlTree` that the `Router` is configured to handle (through
   * `UrlHandlingStrategy`). That is, after we find the route config tree that we're going to
   * activate, run guards, and are just about to activate the route, we set the currentUrlTree.
   */
  currentUrlTree: UrlTree;
  /**
   * Represents the entire browser url after a successful navigation.
   */
  rawUrlTree: UrlTree;
  lastSuccessfulRawUrlTree: UrlTree;
  lastSuccessfulRouterUrlTree: UrlTree;

  private lastSuccessfulId: number = -1;

  private readonly urlUpdateStrategy = inject(ROUTER_CONFIGURATION).urlUpdateStrategy ?? 'deferred';
  private readonly urlHandlingStrategy =
      inject(UrlHandlingStrategy) ?? new DefaultUrlHandlingStrategy();

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

  constructor(
      private readonly location: Location, private urlSerializer: UrlSerializer,
      private readonly routerStateModerator: RouterStateModerator) {
    this.currentUrlTree = createEmptyUrlTree();
    this.rawUrlTree = this.currentUrlTree;
    this.lastSuccessfulRawUrlTree = this.currentUrlTree;
    this.lastSuccessfulRouterUrlTree = this.currentUrlTree;
    routerStateModerator.events.subscribe(e => {
      if (e.type === EventType.NavigationEnd) {
        this.lastSuccessfulId = e.navigation.id;
        this.currentPageId = this.targetPageId;
        this.lastSuccessfulRawUrlTree = e.navigation.urlAfterRedirects!;
        this.lastSuccessfulRouterUrlTree = e.navigation!.extractedUrl;
      }
      if (e.type === EventType.NavigationStart) {
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
      if (e.type === EventType.RoutesRecognized) {
        if (this.urlUpdateStrategy === 'eager') {
          const t = e.navigation;
          if (!t.extras?.skipLocationChange) {
            const rawUrl = this.urlHandlingStrategy.merge(t.urlAfterRedirects!, t.rawUrl);
            this.setBrowserUrl(rawUrl, t);
          }
        }
      }
      if (e instanceof OutletActivationStart) {
        const t = e.navigation;
        this.currentUrlTree = t.urlAfterRedirects!;
        this.rawUrlTree = this.urlHandlingStrategy.merge(t.urlAfterRedirects!, t.rawUrl);
        if (this.urlUpdateStrategy === 'deferred') {
          if (!t.extras.skipLocationChange) {
            this.setBrowserUrl(this.rawUrlTree, t);
          }
        }
      }
    });
  }

  setBrowserUrl(url: UrlTree, t: NavigationTransition) {
    const path = this.urlSerializer.serialize(url);
    const state = {
      ...t.extras.state,
      ...{
        navigationId: t.id, ɵrouterPageId: this.targetPageId,
      }
    };
    if (this.location.isCurrentPathEqualTo(path) || !!t.extras.replaceUrl) {
      this.location.replaceState(path, '', state);
    } else {
      this.location.go(path, '', state);
    }
  }


  restoreHistory(t: NavigationTransition) {
    const targetPagePosition = this.currentPageId - this.targetPageId;
    // The navigator change the location before triggered the browser event,
    // so we need to go back to the current url if the navigation is canceled.
    // Also, when navigation gets cancelled while using url update strategy eager, then we need to
    // go back. Because, when `urlUpdateSrategy` is `eager`; `setBrowserUrl` method is called
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
      this.resetState();
    } else {
      // The browser URL and router state was not updated before the navigation cancelled so
      // there's no restoration needed.
    }
  }

  private resetState(): void {
    this.currentUrlTree = this.lastSuccessfulRouterUrlTree;
    this.rawUrlTree = this.lastSuccessfulRawUrlTree;
    this.location.replaceState(
        this.urlSerializer.serialize(this.rawUrlTree), '',
        {navigationId: this.lastSuccessfulId, ɵrouterPageId: this.currentPageId});
  }
}

export class ReplaceUrlManager {
  /**
   * Represents the activated `UrlTree` that the `Router` is configured to handle (through
   * `UrlHandlingStrategy`). That is, after we find the route config tree that we're going to
   * activate, run guards, and are just about to activate the route, we set the currentUrlTree.
   *
   * This should match the `browserUrlTree` when a navigation succeeds. If the
   * `UrlHandlingStrategy.shouldProcessUrl` is `false`, only the `browserUrlTree` is updated.
   */
  currentUrlTree: UrlTree;
  lastSuccessfulRouterUrlTree: UrlTree;

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
  rawUrlTree: UrlTree;

  private lastSuccessfulId: number = -1;
  private readonly urlUpdateStrategy = inject(ROUTER_CONFIGURATION).urlUpdateStrategy ?? 'deferred';
  private readonly urlHandlingStrategy =
      inject(UrlHandlingStrategy) ?? new DefaultUrlHandlingStrategy();

  constructor(
      private readonly location: Location,
      private urlSerializer: UrlSerializer,
      private readonly routerStateModerator: RouterStateModerator,
  ) {
    this.currentUrlTree = createEmptyUrlTree();
    this.rawUrlTree = this.currentUrlTree;
    this.lastSuccessfulRouterUrlTree = this.currentUrlTree;
    routerStateModerator.events.subscribe(e => {
      if (e instanceof NavigationEnd) {
        this.lastSuccessfulId = e.id;
        this.lastSuccessfulRouterUrlTree = e.navigation.urlAfterRedirects!;
      }
      if (e instanceof NavigationStart) {
      }
      if (e instanceof RoutesRecognized) {
        if (this.urlUpdateStrategy === 'eager') {
          const t = e.navigation;
          if (!t.extras.skipLocationChange) {
            const rawUrl = this.urlHandlingStrategy.merge(t.urlAfterRedirects!, t.rawUrl);
            this.setBrowserUrl(rawUrl, e.navigation);
          }
        }
      }
      if (e instanceof OutletActivationStart) {
        const t = e.navigation;
        this.currentUrlTree = t.urlAfterRedirects!;
        this.rawUrlTree = this.urlHandlingStrategy.merge(t.urlAfterRedirects!, t.rawUrl);
        if (this.urlUpdateStrategy === 'deferred') {
          if (!t.extras.skipLocationChange) {
            this.setBrowserUrl(this.rawUrlTree, e.navigation);
          }
        }
      }
    });
  }

  setBrowserUrl(url: UrlTree, t: NavigationTransition) {
    const path = this.urlSerializer.serialize(url);
    const state = {
      ...t.extras.state,
      ...{navigationId: t.id},
    };
    if (this.location.isCurrentPathEqualTo(path) || !!t.extras.replaceUrl) {
      this.location.replaceState(path, '', state);
    } else {
      this.location.go(path, '', state);
    }
  }

  restoreHistory(t: NavigationTransition) {
    this.resetState(t);
  }

  private resetState(t: NavigationTransition): void {
    this.currentUrlTree = this.lastSuccessfulRouterUrlTree;
    // Note here that we use the urlHandlingStrategy to get the reset `rawUrlTree` because it may be
    // configured to handle only part of the navigation URL. This means we would only want to reset
    // the part of the navigation handled by the Angular router rather than the whole URL. In
    // addition, the URLHandlingStrategy may be configured to specifically preserve parts of the URL
    // when merging, such as the query params so they are not lost on a refresh.
    this.rawUrlTree = this.urlHandlingStrategy.merge(this.currentUrlTree, t!.rawUrl);
    this.location.replaceState(
        this.urlSerializer.serialize(this.rawUrlTree), '', {navigationId: this.lastSuccessfulId});
  }
}