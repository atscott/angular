import {Injectable} from '@angular/core';
import {Subject} from 'rxjs';

import {EventType} from './events';
import {NavigationTransition} from './router';

interface NavigationEvent {
  type: EventType;
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
