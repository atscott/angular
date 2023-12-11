/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.io/license
 */

import '../util/ng_jit_mode';

import {inject} from '../di';
import {Injectable} from '../di/injectable';
import {INTERNAL_APPLICATION_ERROR_HANDLER} from '../error_handler';
import {RuntimeError, RuntimeErrorCode} from '../errors';
import {ViewRef} from '../linker/view_ref';
import {publishDefaultGlobalUtils as _publishDefaultGlobalUtils} from '../render3/util/global_utils';
import {ViewRef as InternalViewRef} from '../render3/view_ref';


@Injectable({providedIn: 'root'})
export class ApplicationRootViews {
  private _runningTick: boolean = false;
  views: InternalViewRef<unknown>[] = [];
  private readonly internalErrorHandler = inject(INTERNAL_APPLICATION_ERROR_HANDLER);

  /**
   * Invoke this method to explicitly process change detection and its side-effects.
   *
   * In development mode, `tick()` also performs a second change detection cycle to ensure that no
   * further changes are detected. If additional changes are picked up during this second cycle,
   * bindings in the app have side-effects that cannot be resolved in a single change detection
   * pass.
   * In this case, Angular throws an error, since an Angular application can only have one change
   * detection pass during which all change detection must complete.
   */
  tick(): void {
    if (this._runningTick) {
      throw new RuntimeError(
          RuntimeErrorCode.RECURSIVE_APPLICATION_REF_TICK,
          ngDevMode && 'ApplicationRef.tick is called recursively');
    }

    try {
      this._runningTick = true;
      for (let view of this.views) {
        view.detectChanges();
      }
      if (typeof ngDevMode === 'undefined' || ngDevMode) {
        for (let view of this.views) {
          view.checkNoChanges();
        }
      }
    } catch (e) {
      // Attention: Don't rethrow as it could cancel subscriptions to Observables!
      this.internalErrorHandler(e);
    } finally {
      this._runningTick = false;
    }
  }

  /**
   * Attaches a view so that it will be dirty checked.
   * The view will be automatically detached when it is destroyed.
   * This will throw if the view is already attached to a ViewContainer.
   */
  attachView(viewRef: ViewRef): void {
    const view = (viewRef as InternalViewRef<unknown>);
    this.views.push(view);
    view.attachToAppRef(this);
  }

  /**
   * Detaches a view from dirty checking again.
   */
  detachView(viewRef: ViewRef): void {
    const view = (viewRef as InternalViewRef<unknown>);
    remove(this.views, view);
    view.detachFromAppRef();
  }

  /**
   * Returns the number of attached views.
   */
  get viewCount() {
    return this.views.length;
  }
}

export function remove<T>(list: T[], el: T): void {
  const index = list.indexOf(el);
  if (index > -1) {
    list.splice(index, 1);
  }
}
