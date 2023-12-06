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
  InjectionToken,
  makeEnvironmentProviders,
  provideEnvironmentInitializer,
} from '@angular/core';

import {
  FakeNavigationPlatformLocation,
  MOCK_PLATFORM_LOCATION_CONFIG,
} from '../mock_platform_location';

import {FakeNavigation} from './fake_navigation';

const FAKE_NAVIGATION = new InjectionToken<FakeNavigation>('fakeNavigation', {
  providedIn: 'root',
  factory: () => {
    const config = inject(MOCK_PLATFORM_LOCATION_CONFIG, {optional: true});
    const baseFallback = 'http://_empty_/';
    const startUrl = new URL(config?.startUrl || baseFallback, baseFallback);
    const fakeNavigation = new FakeNavigation(inject(DOCUMENT), startUrl.href as `http${string}`);
    fakeNavigation.setSynchronousTraversalsForTesting(true);
    return fakeNavigation;
  },
});

/**
 * Return a provider for the `FakeNavigation` in place of the real Navigation API.
 */
export function provideFakePlatformNavigation(): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: PlatformNavigation,
      useFactory: () => {
        const config = inject(MOCK_PLATFORM_LOCATION_CONFIG, {optional: true});
        const nav = new FakeNavigation(
          inject(DOCUMENT),
          (config?.startUrl as `http${string}`) ?? 'http://_empty_/',
        );
        nav.setSynchronousTraversalsForTesting(true);
        return nav;
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
