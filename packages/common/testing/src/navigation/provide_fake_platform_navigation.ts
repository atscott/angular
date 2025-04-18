/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  DOCUMENT,
  Location,
  PlatformLocation,
  ɵPlatformNavigation as PlatformNavigation,
  ɵNavigationAdapterForLocation as NavigationAdapterForLocation,
  ɵUSE_PLATFORM_NAVIGATION as USE_PLATFORM_NAVIGATION,
} from '../../../index';
import {
  EnvironmentProviders,
  inject,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from '@angular/core';

import {
  FakeNavigationPlatformLocation,
  MOCK_PLATFORM_LOCATION_CONFIG,
} from '../mock_platform_location';

import {FakeNavigation} from './fake_navigation';

/**
 * Return a provider for the `FakeNavigation` in place of the real Navigation API.
 */
export function provideFakePlatformNavigation(): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: PlatformNavigation,
      useFactory: () => {
        const config = inject(MOCK_PLATFORM_LOCATION_CONFIG, {optional: true});
        return new FakeNavigation(
          inject(DOCUMENT).defaultView!,
          (config?.startUrl as `http${string}`) ?? 'http://_empty_/',
        );
      },
    },
    {provide: PlatformLocation, useClass: FakeNavigationPlatformLocation},
    provideEnvironmentInitializer(() => {
      // One might use FakeNavigationPlatformLocation without wanting to use Navigation APIs everywhere
      if (!inject(USE_PLATFORM_NAVIGATION, {optional: true})) {
        return;
      }
      if (!(inject(PlatformLocation) instanceof FakeNavigationPlatformLocation)) {
        throw new Error(
          'FakePlatformNavigation was provided but PlatformLocation may not get its information from PlatformNavigation',
        );
      }
    }),
  ]);
}
