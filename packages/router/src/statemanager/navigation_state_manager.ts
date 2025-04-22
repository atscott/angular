/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import {Injectable} from '@angular/core';

import {HistoryStateManager} from './state_manager';

@Injectable({providedIn: 'root'})
export class NavigationStateManager extends HistoryStateManager {}
