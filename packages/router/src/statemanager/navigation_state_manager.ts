import {PlatformNavigation} from '@angular/common/src/navigation/platform_navigation';
import {inject, Injectable} from '@angular/core';
import {Subject, SubscriptionLike} from 'rxjs';

import {
  BeforeActivateRoutes,
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
import {UrlTree} from '../url_tree';

import {StateManager} from './state_manager';
import {ROUTER_SCROLLER} from '../router_scroller';

interface NavigationInfo {
  intercept?: boolean;
  focusReset?: 'after-transition' | 'manual';
  scroll?: 'after-transition' | 'manual';
  deferredCommit?: boolean;
  transition?: Navigation;
  rollback?: boolean;
}

/**
 * @internal
 */
@Injectable({providedIn: 'root'})
export class NavigationStateManager extends StateManager {
  private readonly navigation = inject(PlatformNavigation);
  private readonly inMemoryScrollingEnabled = inject(ROUTER_SCROLLER, {optional: true}) === null;

  /**
   * The NavigationHistoryEntry for the active state. This enables restoring history if an ongoing
   * navigation cancels.
   */
  private activeHistoryEntry: NavigationHistoryEntry = this.navigation.currentEntry!;

  override restoredState(): RestoredState | null | undefined {
    return this.navigation.currentEntry!.getState() as RestoredState | null | undefined;
  }

  private nonRouterCurrentEntryChangeSubject = new Subject<NavigationCurrentEntryChangeEvent>();

  private info: NavigationInfo | null = null;

  constructor() {
    super();
    if (this.canceledNavigationResolution !== 'computed') {
      throw new Error(
        'Navigation API-based router only supports `computed` canceledNavigationResolution.',
      );
    }

    this.navigation.addEventListener('navigate', (event) => {
      this.handleNavigate(event);
    });

    this.navigation.addEventListener('currententrychange', (event) => {
      this.handleCurrentEntryChange(event);
    });
  }

  override registerNonRouterCurrentEntryChangeListener(
    listener: (url: string, state: RestoredState | null | undefined) => void,
  ): SubscriptionLike {
    return this.nonRouterCurrentEntryChangeSubject.subscribe(() => {
      const currentEntry = this.navigation.currentEntry!;
      listener(currentEntry.url!, currentEntry.getState() as RestoredState | null | undefined);
    });
  }

  override handleRouterEvent(e: Event | PrivateRouterEvents, transition: Navigation): void {
    if (e instanceof NavigationStart) {
      this.stateMemento = this.createStateMemento();
    } else if (e instanceof NavigationSkipped) {
      this.rawUrlTree = transition.initialUrl;
    } else if (e instanceof RoutesRecognized) {
      if (!transition.extras.skipLocationChange) {
        const rawUrl = this.urlHandlingStrategy.merge(transition.finalUrl!, transition.initialUrl);
        this.navigate(rawUrl, transition);
      }
    } else if (e instanceof BeforeActivateRoutes) {
      // Commit URL for `urlUpdateStrategy === 'deferred'`.
      transition.commitUrl?.();
    } else if (
      e instanceof NavigationCancel &&
      (e.code === NavigationCancellationCode.GuardRejected ||
        e.code === NavigationCancellationCode.NoDataFromResolver)
    ) {
      this.cancel(transition);
    } else if (e instanceof NavigationError) {
      this.cancel(transition);
    } else if (e instanceof NavigationEnd) {
      // Should this finish in afterNextRender instead?
      transition.finish?.();
      this.activeHistoryEntry = this.navigation.currentEntry!;
    }
  }

  private navigate(rawUrl: UrlTree, transition: Navigation) {
    const path = this.urlSerializer.serialize(rawUrl);
    const state = {
      ...transition.extras.state,
    };
    const history =
      this.location.isCurrentPathEqualTo(path) && transition.extras.replaceUrl ? 'replace' : 'push';
    const ɵrouterInfo: NavigationInfo = {
      intercept: true,
      focusReset: 'manual',
      scroll: this.inMemoryScrollingEnabled ? 'manual' : 'after-transition',
      deferredCommit: this.urlUpdateStrategy === 'deferred',
      transition,
      rollback: false,
    };
    this.navigation.navigate(path, {
      state,
      history,
      info: {ɵrouterInfo, ...(transition.extras.info ?? {})},
    });
  }

  private cancel(transition: Navigation) {
    transition.cancel?.();
    if (this.navigation.currentEntry!.id !== this.activeHistoryEntry.id) {
      const ɵrouterInfo: NavigationInfo = {rollback: true};
      if (this.navigation.currentEntry!.key !== this.activeHistoryEntry.key) {
        this.navigation.traverseTo(this.activeHistoryEntry.key, {info: {ɵrouterInfo}});
      } else {
        // We got to the activation stage (where currentUrlTree is set to the navigation's
        // finalUrl), but we weren't moving anywhere in history (skipLocationChange or
        // replaceUrl). We still need to reset the router state back to what it was when the
        // navigation started.
        this.resetInternalState(transition);
        this.navigation.navigate(this.urlSerializer.serialize(this.rawUrlTree), {
          state: this.activeHistoryEntry.getState(),
          history: 'replace',
          info: {ɵrouterInfo},
        });
      }
    }
  }

  private handleNavigate(event: NavigateEvent) {
    const info = (this.info = (event.info?.ɵrouterInfo as NavigationInfo | undefined) ?? null);

    const intercept = info?.intercept;
    if (event.canIntercept && intercept) {
      const interceptOptions: NavigationInterceptOptions = {
        focusReset: info.focusReset,
        scroll: info.scroll,
        // Resolved when the `transition.finish()` is called.
        handler: () =>
          new Promise<void>((resolve, reject) => {
            info.transition!.finish = resolve;
            info.transition!.cancel = reject;
          }),
      };
      if (info.deferredCommit) {
        // cast to any because deferred commit isn't yet in the spec
        (interceptOptions as any).commit = 'after-transition';
        // Defer commit until `transition.commitUrl` is called.
        info.transition!.commitUrl = () => {
          (event as any).commit();
        };
      }
      event.intercept(interceptOptions);
      event.signal.addEventListener('abort', () => {
        // TODO(atscott): Need to abort the navigation transition
      });
    }
  }

  private handleCurrentEntryChange(event: NavigationCurrentEntryChangeEvent) {
    if (this.info === null) {
      this.nonRouterCurrentEntryChangeSubject.next(event);
    } else if (this.info.rollback) {
      this.activeHistoryEntry = this.navigation.currentEntry!;
    }
  }
}
