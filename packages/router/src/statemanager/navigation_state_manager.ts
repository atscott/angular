import {ɵPlatformNavigation as PlatformNavigation} from '@angular/common';
import {afterNextRender, EnvironmentInjector, inject, Injectable} from '@angular/core';
import {Subject, SubscriptionLike} from 'rxjs';

import {
  BeforeActivateRoutes,
  ExcludeButRunGuards,
  NavigationCancel,
  NavigationCancellationCode,
  NavigationEnd,
  NavigationError,
  NavigationSkipped,
  NavigationStart,
  PrivateRouterEvents,
  RoutesRecognized,
} from '../events';
import {Navigation, RestoredState} from '../navigation_transition';

import {StateManager} from './state_manager';
import {ROUTER_SCROLLER} from '../router_scroller';
import {ROUTER_CONFIGURATION} from '../router_config';
import {
  NavigateEvent,
  NavigationHistoryEntry,
  NavigationInterceptOptions,
  NavigationResult,
} from '@angular/core/primitives/dom-navigation';

type NavigationInfo = RouterTransitionNavigationInfo | RollbackNavigationInfo;

interface RouterTransitionNavigationInfo {
  intercept: true;
  focusReset: 'after-transition' | 'manual';
  scroll: 'after-transition' | 'manual';
  routerTransition: Navigation;
}

interface RollbackNavigationInfo {
  intercept: false;
}

@Injectable({providedIn: 'root'})
export class NavigationStateManager extends StateManager {
  private readonly navigation = inject(PlatformNavigation);
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
    event?: NavigateEvent;
  }>();

  private currentNavigation: Readonly<{
    routerTransition?: Navigation;
    navigateEvent?: NavigateEvent;
    rejectNavigateEvent?: () => void;
    commitUrl?: () => void;
    resolveNavigateEvent?: () => void;
  }> = {};

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
      transitionData?: unknown,
    ) => void,
  ): SubscriptionLike {
    this.registered = true;
    return this.nonRouterCurrentEntryChangeSubject.subscribe(({path, state, event}) => {
      listener(path, state, event);
    });
  }

  override handleRouterEvent(e: Event | PrivateRouterEvents, transition: Navigation): void {
    if (e instanceof NavigationStart) {
      this.currentNavigation = {...this.currentNavigation, routerTransition: transition};
      console.log(e);
      this.updateStateMemento();
    } else if (e instanceof NavigationSkipped) {
      console.log(e);
      this.finishNavigation();
      this.commitTransition(transition);
    } else if (e instanceof RoutesRecognized || e instanceof ExcludeButRunGuards) {
      // TODO: Should trigger a reload if location change is skipped. Otherwise we don't get the loading indicator.
      const path = this.createBrowserPath(transition);
      if (!this.currentNavigation.navigateEvent) {
        // we don't have a navigate event yet for this router transition. create one
        this.navigate(path, transition);
      } else {
        // this branch means we already have a navigationEvent for the transition before getting here
        // it means the event preceeded the router navigation, i.e. a back/forward button on the browser
        if (
          transition.targetBrowserUrl ||
          this.urlSerializer.serialize(transition.finalUrl!) ===
            this.urlSerializer.serialize(transition.extractedUrl)
        ) {
          transition.routesRecognizedHandled.next(true);
        } else {
          // we got redirected!
          // We need to commit the initial navigation and then replace it with a new one
          this.currentNavigation?.commitUrl?.();
          // this.currentNavigation?.resolveNavigateEvent?.(); // don't resolve because it didn't really succeed
          // delete the tracked event from the stored transition. We need a new navigate event. privateTransitionData is the navigateEvent and used to match the transition to the abort signal of the event
          this.currentNavigation.routerTransition!.privateTransitionData = undefined;
          if (!transition.extras.replaceUrl) {
            throw new Error(
              'that will not work. we need to commit the old event and then replace it beacuse there is no ability to redirect on navigation API',
            );
          }
          this.navigate(path, transition);
        }
      }
    } else if (e instanceof BeforeActivateRoutes) {
      this.commitTransition(transition);
      // Commit URL for `urlUpdateStrategy === 'deferred'`.
      this.currentNavigation.commitUrl?.();
    } else if (e instanceof NavigationCancel || e instanceof NavigationError) {
      console.log(e);
      this.cancel(transition, e);
    } else if (e instanceof NavigationEnd) {
      console.log(e);
      this.finishNavigation();
    }
  }

  private readonly injector = inject(EnvironmentInjector);
  private finishNavigation() {
    const resolve = this.currentNavigation?.resolveNavigateEvent;
    if (resolve !== undefined) {
      // TODO(atscott): is this necessary or can we resolve before rendering
      // might affect scroll restoration if we don't wait
      afterNextRender({read: resolve}, {injector: this.injector});
    }
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
      routerTransition: transition,
    };

    // TODO(atscott): Maybe don't need to hide info behind "private" indicator
    // maybe copy over transition.extras.info?
    const info = {ɵrouterInfo};
    const history =
      this.location.isCurrentPathEqualTo(path) ||
      transition.extras.replaceUrl ||
      transition.extras.skipLocationChange
        ? 'replace'
        : 'push';
    console.log('navigating with history strategy', history);
    handleResultRejections(
      this.navigation.navigate(path, {
        state,
        history,
        info,
      }),
    );
  }

  private async cancel(transition: Navigation, event: NavigationCancel | NavigationError) {
    if (transition.id !== this.currentNavigation.routerTransition?.id) {
      throw new Error(
        'we should never handle a transition cancelation if we did not track that transition. how did this happen',
      );
    }
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
      console.log('aborting rollback due to observed new transition');
      return;
    }

    if (this.navigation.currentEntry!.id === this.activeHistoryEntry.id) {
      console.log('nothing to roll back');
      // nothing to roll back. Finish cleanup and return
      return;
    }

    const ɵrouterInfo: RollbackNavigationInfo = {intercept: false};
    this.resetInternalState(transition);
    if (this.navigation.currentEntry!.key !== this.activeHistoryEntry.key) {
      console.log('doing traversal rollback');
      handleResultRejections(
        this.navigation.traverseTo(this.activeHistoryEntry.key, {info: {ɵrouterInfo}}),
      );
    } else {
      console.log('doing replace rollback');
      // We got to the activation stage (where currentUrlTree is set to the navigation's
      // finalUrl), but we weren't moving anywhere in history (skipLocationChange or
      // replaceUrl). We still need to reset the router state back to what it was when the
      // navigation started.
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
    console.log('navigate event', event.destination);
    this.currentNavigation?.routerTransition?.routesRecognizedHandled.next(true);
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

    const handler = new Promise<void>((resolve, reject) => {
      this.currentNavigation = {
        ...this.currentNavigation,
        rejectNavigateEvent: reject,
        resolveNavigateEvent: resolve,
        navigateEvent: event,
      };
    });
    const interceptOptions: NavigationInterceptOptions = {
      handler: () => handler,
    };
    if (
      this.urlUpdateStrategy === 'deferred' &&
      event.cancelable &&
      // defering a traversal is broken at the moment
      event.navigationType !== 'traverse'
    ) {
      // cast to any because deferred commit isn't yet in the spec
      (interceptOptions as any).commit = 'after-transition';
      this.currentNavigation = {
        ...this.currentNavigation,
        commitUrl: () => (event as any).commit(),
      };
    }
    event.intercept(interceptOptions);
    // probably don't need this because it's covered by the navigateerror listener
    // but maybe there is some use in it to differentiate different types of aborts
    const {routerTransition} = this.currentNavigation;
    event.signal.addEventListener('abort', (reason: any) => {
      console.log('abort signal', reason);
      // got an abort event and are still processing the transition for it
      // don't need to check navigate event because new navigate event can't happen until previous one aborts
      // this will cause NavigateCancel event synchronously
      if (routerTransition) {
        console.log(
          `aborting transition with id ${routerTransition.id}. It's okay if this transition finished already because abort signal won't be listend to anymore`,
        );
        routerTransition.abort();
      } else {
        const eventOnTransition = this.currentNavigation.routerTransition?.privateTransitionData;
        if (eventOnTransition === event) {
          this.currentNavigation.routerTransition?.abort();
        } else {
          console.log(
            'currently processing a transition that does not match the aborted navigate event',
          );
        }
      }
    });
    const isTriggeredByRouterTransition = !!routerInfo;
    if (!isTriggeredByRouterTransition) {
      if (!this.registered) {
        this.currentNavigation.resolveNavigateEvent?.();
        this.currentNavigation = {routerTransition: this.currentNavigation.routerTransition};
        return;
      }
      const path = this.location.getPathFromUrl(new URL(event.destination.url));
      const state = event.destination.getState() as RestoredState | null | undefined;
      this.nonRouterCurrentEntryChangeSubject.next({path, state, event});
    }
  }
}

function handleResultRejections(result: NavigationResult): NavigationResult {
  result.finished.catch(() => {});
  result.committed.catch(() => {});
  return result;
}
