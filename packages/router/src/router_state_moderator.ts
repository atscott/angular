import {Injectable} from '@angular/core';
import {Subject} from 'rxjs';

import {NavigationCancel, NavigationError} from './events';
import {NavigationTransition} from './router';

export enum RouterStateEventType {
  NavigationStart,
  NavigationEnd,
  RoutesRecognized,
  NavigationCancel,
  NavigationError,
  OutletActivationStart,
}

export type NavigationEvent =
    ModeratorNavigationCancel|ModeratorNavigationError|ModeratorNavigationEnd|
    ModeratorNavigationStart|ModeratorRoutesRecognized|ModeratorOutletActivationStart;

export interface ModeratorNavigationCancel {
  type: RouterStateEventType.NavigationCancel;
  navigation: NavigationTransition;
  routerEvent: NavigationCancel;
}
export interface ModeratorNavigationError {
  type: RouterStateEventType.NavigationError;
  navigation: NavigationTransition;
  routerEvent: NavigationError;
}
export interface ModeratorNavigationStart {
  type: RouterStateEventType.NavigationStart;
  navigation: NavigationTransition;
}
export interface ModeratorNavigationEnd {
  type: RouterStateEventType.NavigationEnd;
  navigation: NavigationTransition;
}
export interface ModeratorRoutesRecognized {
  type: RouterStateEventType.RoutesRecognized;
  navigation: NavigationTransition;
}
export interface ModeratorOutletActivationStart {
  type: RouterStateEventType.OutletActivationStart;
  navigation: NavigationTransition;
}

@Injectable({providedIn: 'root'})
export class RouterStateModerator {
  readonly _events = new Subject<NavigationEvent>();
  readonly events = this._events.asObservable();
  triggerEvent(e: NavigationEvent) {
    this._events.next(e);
  }
}
