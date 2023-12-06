import {ɵPlatformNavigation as PlatformNavigation} from '@angular/common';
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
  private currentNavigationControls?: {
    cancel: () => void;
    finish: () => void;
    commitUrl?: () => void;
  };

  constructor() {
    super();
    if (this.canceledNavigationResolution !== 'computed') {
      throw new Error(
        'Navigation API-based router only supports `computed` canceledNavigationResolution.',
      );
    }

    this.navigation.addEventListener('navigate', (event: NavigateEvent) => {
      this.handleNavigate(event);
    });

    this.navigation.addEventListener(
      'currententrychange',
      (event: NavigationCurrentEntryChangeEvent) => {
        this.handleCurrentEntryChange(event);
      },
    );
  }

  override registerNonRouterCurrentEntryChangeListener(
    listener: (url: string, state: RestoredState | null | undefined) => void,
  ): SubscriptionLike {
    return this.nonRouterCurrentEntryChangeSubject.subscribe(() => {
      const currentEntry = this.navigation.currentEntry!;
      const path = this.location.getPathFromUrl(new URL(currentEntry.url!));
      listener(path, currentEntry.getState() as RestoredState | null | undefined);
    });
  }

  override handleRouterEvent(e: Event | PrivateRouterEvents, transition: Navigation): void {
    if (e instanceof NavigationStart) {
      this.updateStateMemento();
    } else if (e instanceof NavigationSkipped) {
      this.commitTransition(transition);
    } else if (e instanceof RoutesRecognized) {
      if (!transition.extras.skipLocationChange) {
        const rawUrl = this.urlHandlingStrategy.merge(transition.finalUrl!, transition.initialUrl);
        this.navigate(rawUrl, transition);
      }
    } else if (e instanceof BeforeActivateRoutes) {
      this.commitTransition(transition);
      // Commit URL for `urlUpdateStrategy === 'deferred'`.
      this.currentNavigationControls?.commitUrl?.();
    } else if (
      (e instanceof NavigationCancel &&
        e.code !== NavigationCancellationCode.SupersededByNewNavigation &&
        e.code !== NavigationCancellationCode.Redirect) ||
      e instanceof NavigationError
    ) {
      this.cancel(transition);
    } else if (e instanceof NavigationEnd) {
      this.currentNavigationControls?.finish();
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
    this.currentNavigationControls?.cancel();
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
        this.navigation.navigate(this.urlSerializer.serialize(this.getCurrentUrlTree()), {
          state: this.activeHistoryEntry.getState(),
          history: 'replace',
          info: {ɵrouterInfo},
        });
      }
    }
  }

  private handleNavigate(event: NavigateEvent) {
    const info = (this.info =
      ((event.info as any)?.ɵrouterInfo as NavigationInfo | undefined) ?? null);

    // TODO(atscott): This effectively ignores user-triggered traversals, allows them to complete immediately
    // and then handles a follow-up navigation via nonRouterCurrentEntryChangeSubject.
    // This isn't ideal though it does work well enough. Instead, it would be best to be able to intercept
    // navigation events that are triggered by the UI so we can defer the URL update.
    const intercept = info?.intercept;
    if (event.canIntercept && intercept) {
      const handler = new Promise<void>((resolve, reject) => {
        this.currentNavigationControls = {finish: resolve, cancel: reject};
      });
      const interceptOptions: NavigationInterceptOptions = {
        focusReset: info.focusReset,
        scroll: info.scroll,
        // Resolved when the `transition.finish()` is called.
        handler: () => handler,
      };
      if (info.deferredCommit) {
        // cast to any because deferred commit isn't yet in the spec
        (interceptOptions as any).commit = 'after-transition';
        this.currentNavigationControls!.commitUrl = () => (event as any).commit();
      }
      event.intercept(interceptOptions);
      event.signal.addEventListener('abort', () => {
        // TODO(atscott): when does this happen??
        // user clicks stop
        // user traverses with back/forward
        // programmatic cancellations? i.e. do I get a double abort
        info.transition?.abort();
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
