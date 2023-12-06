/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {PlatformLocation, PlatformNavigation} from '@angular/common';
import {afterNextRender, EnvironmentInjector, inject, Injectable} from '@angular/core';
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
import {ROUTER_SCROLLER} from '../router_scroller';

import {StateManager} from './state_manager';

/**
 * Defines the type of information passed via `NavigateEvent.info` for router-related navigations.
 * This helps distinguish router-initiated navigations from external ones and dictates how they
 * should be handled.
 */
type NavigationInfo = RouterTransitionNavigationInfo | RollbackNavigationInfo;

// Ensures TypeScript type checking for the Navigation API.
/// <reference types="dom-navigation" />

/**
 * Information object for a standard router navigation transition.
 * It signals that the navigation should be intercepted and handled by the Angular Router.
 */
interface RouterTransitionNavigationInfo {
  /** Indicates that the router should intercept this navigation. */
  intercept: true;
  /**
   * Determines how focus should be managed after the transition.
   * 'after-transition': Router default behavior (likely scroll to top or element).
   * 'manual': Router will not manage focus.
   */
  focusReset: 'after-transition' | 'manual';
  /**
   * Determines how scrolling should be managed after the transition.
   * 'after-transition': Router default behavior (likely scroll to top or element based on URL
   * fragment). 'manual': Router will not manage scrolling.
   */
  scroll: 'after-transition' | 'manual';
}

/**
 * Information object for a navigation that is intended to roll back a previous state.
 * It signals that the router should not intercept this navigation, allowing the Navigation API
 * to handle it directly (e.g., a `traverseTo` call for rollback).
 */
interface RollbackNavigationInfo {
  /** Indicates that the router should *not* intercept this navigation. */
  intercept: false;
}

/** Pre-created info object for rollback navigations to avoid repeated object creation. */
const rollbackNavigationInfo = {ɵrouterInfo: {intercept: false} satisfies RollbackNavigationInfo};

/**
 * @description
 *
 * Manages the router's interaction with the browser's state and URL using the **Navigation API**.
 *
 * This class is responsible for:
 * - Listening to `navigate` events from the Navigation API.
 * - Intercepting navigations and integrating them with the Angular Router's lifecycle.
 * - Updating the browser's URL and history entries using `navigation.navigate()` and
 *   `navigation.traverseTo()`.
 * - Restoring application state from `NavigationHistoryEntry.getState()`.
 * - Handling navigation cancellations and errors by potentially rolling back to a previous valid
 *   state using Navigation API methods.
 * - Communicating with the `NavigationTransitions` service to drive the router's internal
 *   navigation pipeline.
 *
 * It offers a more modern and potentially more robust approach compared to `HistoryStateManager`,
 * which relies on the older `history` API. The Navigation API provides more explicit control over
 * navigation interception and lifecycle.
 *
 * @see HistoryStateManager for the traditional history API based implementation.
 * @see https://developer.mozilla.org/en-US/docs/Web/API/Navigation_API
 */
@Injectable({providedIn: 'root'})
export class NavigationStateManager extends StateManager {
  /** The base origin of the application, extracted from PlatformLocation. */
  private readonly base = new URL(inject(PlatformLocation).href).origin;
  /** The root URL of the Angular application, considering the base href. */
  private readonly appRootURL = new URL(this.location.prepareExternalUrl?.('/') ?? '/', this.base)
    .href;
  /** Instance of the Navigation API, injected via `PlatformNavigation`. */
  private readonly navigation = inject(PlatformNavigation);
  private readonly injector = inject(EnvironmentInjector);
  private readonly inMemoryScrollingEnabled = inject(ROUTER_SCROLLER, {optional: true}) !== null;
  override readonly canceledNavigationResolution =
    this.options.canceledNavigationResolution || /*'computed'*/ 'replace';

  /**
   * The `NavigationHistoryEntry` from the Navigation API that corresponds to the last successfully
   * activated router state. This is crucial for restoring the browser state if an ongoing navigation
   * is canceled or fails, allowing a precise rollback to a known good entry.
   * It's updated on `navigatesuccess`.
   */
  private activeHistoryEntry: NavigationHistoryEntry = this.navigation.currentEntry!;

  /**
   * Retrieves the router-specific state (e.g., `navigationId`) stored in the current
   * `NavigationHistoryEntry`. This is the Navigation API equivalent of `history.state`.
   */
  override restoredState(): RestoredState | null | undefined {
    return this.navigation.currentEntry!.getState() as RestoredState | null | undefined;
  }

  /**
   * Subject used to notify listeners (typically the `Router`) of URL/state changes
   * that were initiated outside the Angular Router but detected via the Navigation API's
   * `navigate` event (e.g., user clicking browser back/forward, or manual URL changes if
   * interceptable by the Navigation API).
   */
  private nonRouterCurrentEntryChangeSubject = new Subject<{
    path: string;
    state: RestoredState | null | undefined;
  }>();

  /**
   * Holds state related to the currently processing navigation that was intercepted from a
   * `navigate` event. This includes the router's internal `Navigation` object, the original
   * `NavigateEvent`, and promises/callbacks to manage the pre- and post-commit phases
   * of the intercepted navigation.
   */
  private currentNavigation: {
    /** The Angular Router's internal representation of the ongoing navigation. */
    routerTransition?: Navigation;
    /** The `NavigateEvent` from the Navigation API that triggered this router transition. */
    navigateEvent?: NavigateEvent;
    /**
     * A function that, when called, commits the URL change for the current navigation.
     * This is used for deferred URL updates. It might involve calling `event.commit()`
     * or `controller.redirect()` from the Navigation API.
     */
    commitUrl?: () => Promise<void>;
    /**
     * A function to reject the `precommitHandler` promise of an intercepted `NavigateEvent`,
     * effectively canceling the URL commit.
     */
    rejectNavigateEvent?: () => void;
    /**
     * A function to resolve the `handler` promise of an intercepted `NavigateEvent` after
     * all post-commit actions (like rendering) are done.
     */
    resolvePostCommitHandler?: () => void;
    /** Function to remove the abort listener from the `NavigateEvent`'s signal. */
    removeAbortListener?: () => void;
  } = {};

  constructor() {
    super();

    // Listen to the 'navigate' event from the Navigation API.
    // This is the primary entry point for intercepting and handling navigations.
    this.navigation.addEventListener('navigate', (event: NavigateEvent) => {
      this.handleNavigate(event);
    });

    // Listen to 'navigatesuccess' to update the `activeHistoryEntry`.
    // This ensures `activeHistoryEntry` always points to the latest successfully committed state.
    this.navigation.addEventListener('navigatesuccess', () => {
      this.activeHistoryEntry = this.navigation.currentEntry!;
    });
  }

  /** Flag to track if a listener for non-router changes has been registered. */
  registered = false;

  /**
   * Registers a listener for URL/state changes initiated outside the Angular Router.
   * This method allows the Router to be notified of such changes, which are detected
   * by intercepting `navigate` events from the Navigation API.
   *
   * @param listener The callback function to execute when an external navigation occurs.
   *                 It receives the new URL path, restored state, and the trigger type ('navigate').
   * @returns A `SubscriptionLike` object to unsubscribe the listener.
   */
  override registerNonRouterCurrentEntryChangeListener(
    listener: (
      url: string,
      state: RestoredState | null | undefined,
      trigger: NavigationTrigger,
    ) => void,
  ): SubscriptionLike {
    this.registered = true;
    return this.nonRouterCurrentEntryChangeSubject.subscribe(({path, state}) => {
      // For Navigation API, the trigger is always 'navigate' when intercepted here.
      // 'popstate' or 'hashchange' are typically associated with the older history API.
      listener(path, state, 'navigate');
    });
  }

  /**
   * Handles router events emitted by the `NavigationTransitions` service.
   * This method orchestrates the interaction with the Navigation API based on the
   * current stage of the router's internal navigation pipeline.
   *
   * @param e The router event (e.g., `NavigationStart`, `NavigationEnd`).
   * @param transition The Angular Router's internal navigation object.
   */
  override async handleRouterEvent(
    e: Event | PrivateRouterEvents,
    transition: Navigation,
  ): Promise<void> {
    this.currentNavigation.routerTransition = transition;
    if (e instanceof NavigationStart) {
      // Preserve the current router state before starting a new navigation.
      this.updateStateMemento();
      const path = this.createBrowserPath(transition);
      // If a `NavigateEvent` from the Navigation API isn't already associated with this router
      // transition (i.e., this router navigation was initiated imperatively via `router.navigate`
      // and not by an already intercepted browser navigation event), then we need to trigger one
      // using `this.navigation.navigate()`.
      if (!this.currentNavigation.navigateEvent) {
        // Ensure the NavigationStart event is marked as handled once the corresponding
        // browser `navigate` event is processed by our listener.
        onNextNavigateEventWithRouterInfo(this.navigation, () =>
          transition.navigationStartHandled.next(),
        );
        // Programmatically trigger a navigation via the Navigation API.
        this.navigate(path, transition);
      } else {
        // A `NavigateEvent` already exists (e.g., user click intercepted), so just mark as handled.
        transition.navigationStartHandled.next();
      }
    } else if (e instanceof NavigationSkipped) {
      // Navigation was skipped (e.g., `UrlHandlingStrategy` decided not to process).
      // Finalize any pending Navigation API operations and commit the router state.
      this.finishNavigation();
      this.commitTransition(transition);
    } else if (e instanceof BeforeRoutesRecognized) {
      // If URL update strategy is 'eager', commit the URL now.
      if (this.urlUpdateStrategy === 'eager') {
        try {
          // `commitUrl` will call `event.commit()` or `controller.redirect()` on the
          // intercepted `NavigateEvent`.
          await this.currentNavigation.commitUrl?.();
        } catch {
          // If commit fails (e.g., precommitHandler rejects), abort.
          return;
        }
      }
      transition.routesRecognizeHandled.next();
    } else if (e instanceof BeforeActivateRoutes) {
      // If URL update strategy is 'deferred', commit the URL now (before activation).
      if (this.urlUpdateStrategy === 'deferred') {
        try {
          await this.currentNavigation.commitUrl?.();
        } catch {
          return;
        }
      }
      // Commit the internal router state.
      this.commitTransition(transition);
      transition.beforeActivateHandled.next();
    } else if (e instanceof NavigationCancel || e instanceof NavigationError) {
      // Handle navigation cancellation or error.
      // If redirecting and the URL hasn't been committed yet (deferred mode),
      // the redirect will be handled by `commitUrl` using `controller.redirect`.
      // Otherwise, a full cancellation and rollback is needed.
      const redirectingBeforeUrlCommit =
        e instanceof NavigationCancel &&
        e.code === NavigationCancellationCode.Redirect &&
        !!this.currentNavigation.commitUrl;
      if (redirectingBeforeUrlCommit) {
        return;
      }
      void this.cancel(transition, e);
    } else if (e instanceof NavigationEnd) {
      // Navigation completed successfully.
      const {removeAbortListener, resolvePostCommitHandler} = this.currentNavigation;
      this.currentNavigation = {}; // Clear current navigation state.
      removeAbortListener?.(); // Clean up abort listener.
      // Update `activeHistoryEntry` to the new current entry from Navigation API.
      this.activeHistoryEntry = this.navigation.currentEntry!;
      // Resolve the `handler` promise of the intercepted `NavigateEvent`,
      // potentially after the next render to allow UI updates (e.g., scrolling) to settle.
      afterNextRender({read: () => resolvePostCommitHandler?.()}, {injector: this.injector});
    }
  }

  /**
   * Finalizes the current navigation by committing the URL (if not already done)
   * and resolving the post-commit handler promise. Clears the `currentNavigation` state.
   */
  private finishNavigation() {
    this.currentNavigation.commitUrl?.();
    this.currentNavigation?.resolvePostCommitHandler?.();
    this.currentNavigation = {};
  }

  /**
   * Initiates a navigation using the browser's Navigation API (`navigation.navigate`).
   * This is called when the Angular Router starts an imperative navigation.
   *
   * @param internalPath The internal path generated by the router.
   * @param transition The Angular Router's navigation object.
   */
  private navigate(internalPath: string, transition: Navigation) {
    // Determine the actual browser path, considering skipLocationChange.
    const path = transition.extras.skipLocationChange
      ? this.navigation.currentEntry!.url! // If skipping, use the current URL.
      : this.location.prepareExternalUrl(internalPath); // Otherwise, prepare the external URL.

    // Prepare the state to be stored in the NavigationHistoryEntry.
    const state = {
      ...transition.extras.state,
      navigationId: transition.id, // Include router's navigationId for tracking.
    };

    // Prepare `info` object for `navigation.navigate`. This tells our `handleNavigate`
    // listener that this is a Router-initiated transition that should be intercepted.
    const ɵrouterInfo: RouterTransitionNavigationInfo = {
      intercept: true,
      focusReset: 'manual', // Router handles focus via its own mechanisms or user config.
      scroll: this.inMemoryScrollingEnabled ? 'manual' : 'after-transition',
    };
    const info = {ɵrouterInfo};

    // Determine if this should be a 'push' or 'replace' history operation.
    const history =
      this.location.isCurrentPathEqualTo(path) ||
      transition.extras.replaceUrl ||
      transition.extras.skipLocationChange
        ? 'replace'
        : 'push';

    // Call the Navigation API and prevent unhandled promise rejections of the
    // returned promises from `navigation.navigate`.
    handleResultRejections(
      this.navigation.navigate(path, {
        state,
        history,
        info,
      }),
    );
  }

  /**
   * Handles the cancellation of a navigation. It resets the router's internal state
   * and then attempts to restore the browser's URL and history to the state before
   * the canceled navigation.
   *
   * @param transition The Angular Router's navigation object that was canceled.
   * @param event The `NavigationCancel` or `NavigationError` event.
   */
  private async cancel(transition: Navigation, event: NavigationCancel | NavigationError) {
    // Determine if the rollback should be a traversal to a specific previous entry
    // or a replacement of the current URL.
    const isTraversalReset =
      this.canceledNavigationResolution === 'computed' &&
      this.navigation.currentEntry!.key !== this.activeHistoryEntry.key;
    this.resetInternalState(transition, isTraversalReset);

    // Reject the precommit handler of the intercepted NavigateEvent, if it's still pending.
    // This prevents the URL from changing if it was deferred.
    this.currentNavigation.rejectNavigateEvent?.();
    const clearedState = {}; // Marker to detect if a new navigation started during async ops.
    this.currentNavigation = clearedState;

    // If the current browser entry ID is already the same as our target active entry,
    // no browser history manipulation is needed.
    if (this.navigation.currentEntry!.id === this.activeHistoryEntry.id) {
      return;
    }

    // If the cancellation was not due to a guard or resolver (e.g., superseded by another
    // navigation, or aborted by user), there's a race condition. Another navigation might
    // have already started. A small timeout is used to see if `currentNavigation` changes,
    // indicating a new navigation has taken over. This is a heuristic.
    if (
      event instanceof NavigationCancel &&
      event.code !== NavigationCancellationCode.GuardRejected &&
      event.code !== NavigationCancellationCode.NoDataFromResolver
    ) {
      await new Promise((resolve) => setTimeout(resolve));
      if (this.currentNavigation !== clearedState) {
        // A new navigation has started, so don't attempt to roll back this one.
        return;
      }
    }

    // Perform the rollback using Navigation API methods.
    if (isTraversalReset) {
      // Traverse back to the specific `NavigationHistoryEntry` that was active before.
      handleResultRejections(
        this.navigation.traverseTo(this.activeHistoryEntry.key, {
          info: rollbackNavigationInfo, // Pass info to indicate this is a rollback.
        }),
      );
    } else {
      // Replace the current history entry with the state of the last known good URL/state.
      const internalPath = this.urlSerializer.serialize(this.getCurrentUrlTree());
      const pathOrUrl = this.location.prepareExternalUrl(internalPath);
      handleResultRejections(
        this.navigation.navigate(pathOrUrl, {
          state: this.activeHistoryEntry.getState(),
          history: 'replace',
          info: rollbackNavigationInfo, // Pass info to indicate this is a rollback.
        }),
      );
    }
  }

  /**
   * Handles the `navigate` event from the browser's Navigation API.
   * This is the core interception point.
   *
   * @param event The `NavigateEvent` from the Navigation API.
   */
  private handleNavigate(event: NavigateEvent) {
    // Preserve the router's current transition if one is already in progress and this
    // `NavigateEvent` corresponds to it.
    this.currentNavigation = {
      routerTransition: this.currentNavigation.routerTransition,
    };

    // If the event cannot be intercepted (e.g., cross-origin, or some browser-internal
    // navigations), let the browser handle it.
    if (!event.canIntercept) {
      return;
    }

    // Check the `info` field of the event. If it contains `ɵrouterInfo` and `intercept` is false,
    // it means this navigation was triggered by our own rollback logic (e.g., `this.cancel`),
    // so we should not intercept it again.
    const routerInfo = ((event?.info as any)?.ɵrouterInfo as NavigationInfo) ?? null;
    if (routerInfo && !routerInfo.intercept) {
      return;
    }

    this.currentNavigation.navigateEvent = event;

    // Setup an abort handler. If the `NavigateEvent` is aborted (e.g., user clicks stop,
    // or another navigation supersedes this one), we need to abort the Angular Router's
    // internal navigation transition as well.
    const abortHandler = () => {
      this.currentNavigation.routerTransition?.abort();
    };

    // Create promises to manage the pre-commit and post-commit (handler) phases of the
    // intercepted navigation. These are given to `event.intercept()`.
    const [precommitHandlerPromise, resolvePrecommitHandler, rejectPrecommitHandler] =
      promiseWithResolvers();
    const commit = async () => {
      resolvePrecommitHandler();
      // Wait for the Navigation API's own `committed` promise if available (part of transition object)
      // This ensures we respect the browser's timing for when the commit actually happens.
      await this.navigation.transition?.committed;
    };
    // Prevent unhandled rejections for the precommit promise.
    precommitHandlerPromise.catch(() => {});
    event.signal.addEventListener('abort', abortHandler);
    this.currentNavigation.removeAbortListener = () =>
      event.signal.removeEventListener('abort', abortHandler);

    const interceptOptions: NavigationInterceptOptions = {};
    let redirect: // Function provided by `precommitHandler`'s controller to perform a redirect.
    ((url: string, options: {state: unknown; history?: 'push' | 'replace'}) => void) | null = null;

    const deferCommitWithPrecommitHandler =
      // Cannot defer commit if not cancelable by the Navigation API's rules.
      event.cancelable &&
      // Deferring a traversal commit is currently problematic or not fully supported.
      event.navigationType !== 'traverse';
    // Setup `precommitHandler` if the navigation is cancelable and not a traversal.
    // The `precommitHandler` allows modifying or redirecting the navigation *before* the URL
    // officially changes in the browser.
    if (deferCommitWithPrecommitHandler) {
      // The `precommitHandler` option is not in the standard DOM types yet
      (interceptOptions as any).precommitHandler = (controller: any) => {
        if (event.navigationType !== 'traverse') {
          // Store the redirect function from the controller to be used in `commitUrl`.
          redirect = controller.redirect;
        }
        return precommitHandlerPromise;
      };
      // If the precommit phase is rejected, this function will be called.
      this.currentNavigation.rejectNavigateEvent = () => {
        event.signal.removeEventListener('abort', abortHandler);
        rejectPrecommitHandler();
      };
    }

    // `commitUrl` is a function that will be called by the router's lifecycle
    // (e.g., in `BeforeRoutesRecognized` or `BeforeActivateRoutes` depending on `urlUpdateStrategy`)
    // to actually perform the URL change via the Navigation API.
    this.currentNavigation.commitUrl = async () => {
      this.currentNavigation.commitUrl = undefined; // Ensure it's only called once.

      const transition = this.currentNavigation.routerTransition;
      if (transition === undefined) {
        // This can happen if a `navigate` event is caught before the router is fully listening
        // or for navigations completely outside the router's knowledge.
        return await commit();
      }
      const internalPath = this.createBrowserPath(transition);
      // this might be a path or an actual URL depending on the baseHref
      const pathOrUrl = this.location.prepareExternalUrl(internalPath);

      // If the URL is already committed (e.g. we could not defer the commit),
      // or redirect function is not available, just run the basic commit.
      if (!deferCommitWithPrecommitHandler || redirect === null) {
        await commit();
        // If after commit, the expected path/URL differs from the event's destination,
        // it we didn't go to the right place. Attempt to correct this.
        const eventDestination = new URL(event.destination.url);
        if (
          !transition.extras.skipLocationChange &&
          new URL(pathOrUrl, eventDestination.origin).href !== eventDestination.href
        ) {
          await this.redirectNavigationWithAlreadyCommittedUrl(internalPath, transition);
        }
        return;
      }

      // If not skipping location change, use the `redirect` function (from `precommitHandler`'s
      // controller) to perform the URL update with the correct state and history action.
      if (!transition.extras.skipLocationChange) {
        const state = {
          ...transition.extras.state,
          navigationId: transition.id,
        };
        const history =
          this.location.isCurrentPathEqualTo(internalPath) || !!transition.extras.replaceUrl
            ? 'replace'
            : 'push';
        redirect(pathOrUrl, {state, history});
      }
      return await commit(); // Finalize the commit with the Navigation API.
    };

    const [postCommitHandlerPromise, resolvePostCommitHandler, rejectPostCommitHandler] =
      promiseWithResolvers();
    this.currentNavigation.resolvePostCommitHandler = () => {
      event.signal.removeEventListener('abort', abortHandler);
      resolvePostCommitHandler();
    };
    interceptOptions.handler = () => {
      // If the main handler phase is rejected (e.g., router guard fails after URL commit).
      this.currentNavigation.rejectNavigateEvent = () => {
        event.signal.removeEventListener('abort', abortHandler);
        rejectPostCommitHandler();
      };
      return postCommitHandlerPromise;
    };

    // Intercept the navigation event with the configured options.
    event.intercept(interceptOptions);

    // If `routerInfo` is null, this `NavigateEvent` was not triggered by one of the Router's
    // own `this.navigation.navigate()` calls. It's an external navigation (e.g., user click,
    // browser back/forward that the Navigation API surfaces). We need to inform the Router.
    const isTriggeredByRouterTransition = !!routerInfo;
    if (!isTriggeredByRouterTransition) {
      this.handleNavigateEventTriggeredOutsideRouterAPIs(event);
    }
  }

  /**
   * Handles a scenario where a navigation (often a traversal) has already had its URL committed by
   * the browser, but the Angular Router subsequently determines a redirect is necessary.
   * Since `controller.redirect()` from a `precommitHandler` cannot be used post-commit,
   * this initiates a new `navigation.navigate()` call with `replaceUrl: true` to achieve
   * the redirect effect.
   *
   * This is a best-effort approach, particularly for traversals which cannot be truly
   * "redirected" in the Navigation API once they've begun processing.
   *
   * @param redirectedPath The new path the router wants to navigate to.
   * @param currentTransition The current Angular Router navigation object.
   */
  private redirectNavigationWithAlreadyCommittedUrl(
    redirectedPath: string,
    currentTransition: Navigation,
  ) {
    // Clean up handlers from the current (being redirected) navigation.
    this.currentNavigation.resolvePostCommitHandler?.();
    this.currentNavigation.removeAbortListener?.();

    return new Promise<void>((resolve, reject) => {
      // Set up a listener for the *next* `navigate` event that will be triggered by our
      // `this.navigate` call below. Once that event is processed by `handleNavigate` and its
      // URL is committed, resolve this promise.
      onNextNavigateEventWithRouterInfo(this.navigation, async () => {
        try {
          await this.currentNavigation.commitUrl?.(); // Ensure the new navigation's URL is committed.
          resolve();
        } catch {
          reject(); // Should not happen if handled correctly by `handleNavigate`.
        }
      });
      // Trigger a new navigation to the redirected path, effectively replacing the current one.
      this.navigate(redirectedPath, {
        ...currentTransition,
        extras: {...currentTransition.extras, replaceUrl: true}, // Ensure it's a replacement.
      });
    });
  }

  /**
   * Handles `NavigateEvent`s that were not initiated by the Angular Router's own API calls
   * (e.g., `router.navigate()`). These are typically from user interactions like back/forward
   * buttons or direct URL manipulation if the Navigation API intercepts them.
   *
   * It converts such an event into a format the Angular Router can understand and processes it
   * via the `nonRouterCurrentEntryChangeSubject`.
   *
   * @param event The `NavigateEvent` from the Navigation API.
   */
  private handleNavigateEventTriggeredOutsideRouterAPIs(event: NavigateEvent) {
    if (!this.registered) {
      // If the router isn't set up to listen for these yet, just finish the nav.
      this.finishNavigation();
      return;
    }
    // TODO(atscott): Consider if the destination URL doesn't start with `appRootURL`.
    // Should we ignore it or not intercept in the first place?
    // Extract the application-relative path from the full destination URL.
    const path = event.destination.url.substring(this.appRootURL.length - 1);
    const state = event.destination.getState() as RestoredState | null | undefined;
    this.nonRouterCurrentEntryChangeSubject.next({path, state});
  }
}

/**
 * Utility to create a Promise along with its resolve and reject functions.
 * This is a common pattern for managing promise lifecycles manually.
 */
function promiseWithResolvers<T = void>(): [
  promise: Promise<T>,
  resolve: (v: T) => void,
  reject: () => void,
] {
  let resolve: (v: T) => void;
  let reject: () => void;
  const promise = new Promise<T>((r, rej) => {
    resolve = r;
    reject = rej;
  });
  return [promise, resolve!, reject!] as const;
}

/**
 * Attaches a no-op `.catch(() => {})` to the `committed` and `finished` promises of a
 * `NavigationResult`. This is to prevent unhandled promise rejection errors in the console
 * if the consumer of the navigation method (e.g., `router.navigate()`) doesn't explicitly
 * handle rejections on both promises. Navigations can be legitimately aborted (e.g., by a
 * subsequent navigation), and this shouldn't necessarily manifest as an unhandled error
 * if the application code doesn't specifically need to react to the `committed` promise
 * rejecting in such cases. The `finished` promise is more commonly used to determine
 * overall success/failure.
 */
function handleResultRejections(result: NavigationResult): NavigationResult {
  result.finished.catch(() => {});
  result.committed.catch(() => {});
  return result;
}

/**
 * Helper function to listen for the next `navigate` event on the provided `PlatformNavigation`
 * instance that has `ɵrouterInfo` in its `info` object. Once such an event is caught,
 * it executes the provided callback `fn` and removes the listener.
 *
 * This is used to synchronize Angular Router's imperative navigations (which call
 * `navigation.navigate()`) with the `navigate` event that the Navigation API subsequently fires.
 *
 * @param navigation The `PlatformNavigation` instance.
 * @param fn The callback to execute with the `NavigateEvent`.
 */
function onNextNavigateEventWithRouterInfo(
  navigation: PlatformNavigation,
  fn: (e: NavigateEvent) => void,
) {
  const navigateHandler = (e: NavigateEvent) => {
    // Check if the event's info object contains the marker for router-initiated navigations.
    if (!(e.info as {ɵrouterInfo: unknown})?.ɵrouterInfo) {
      return; // Not a router-initiated event, ignore.
    }
    fn(e); // Execute the callback.
    navigation.removeEventListener('navigate', navigateHandler); // Clean up the listener.
  };
  navigation.addEventListener('navigate', navigateHandler);
}
