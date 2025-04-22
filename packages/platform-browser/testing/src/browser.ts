/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import {
  PlatformLocation,
  ɵUSE_PLATFORM_NAVIGATION as USE_PLATFORM_NAVIGATION,
} from '@angular/common';
import {
  ɵprovideFakePlatformNavigation,
  ɵFakeNavigationPlatformLocation as FakeNavigationPlatformLocation,
} from '@angular/common/testing';
import {MockPlatformLocation} from '@angular/common/testing';
import {
  APP_ID,
  createPlatformFactory,
  NgModule,
  StaticProvider,
  ɵinternalProvideZoneChangeDetection as internalProvideZoneChangeDetection,
  ɵChangeDetectionScheduler as ChangeDetectionScheduler,
  ɵChangeDetectionSchedulerImpl as ChangeDetectionSchedulerImpl,
  inject,
  PlatformRef,
  provideEnvironmentInitializer,
} from '@angular/core';
import {TestComponentRenderer} from '@angular/core/testing';
import {BrowserModule, platformBrowser} from '../../index';
import {DOMTestComponentRenderer} from './dom_test_component_renderer';

/**
 * Platform for testing
 *
 * @publicApi
 */
export const platformBrowserTesting: (extraProviders?: StaticProvider[]) => PlatformRef =
  createPlatformFactory(platformBrowser, 'browserTesting');

/**
 * NgModule for testing.
 *
 * @publicApi
 */
@NgModule({
  exports: [BrowserModule],
  providers: [
    {provide: APP_ID, useValue: 'a'},
    internalProvideZoneChangeDetection({}),
    {provide: ChangeDetectionScheduler, useExisting: ChangeDetectionSchedulerImpl},
    ɵprovideFakePlatformNavigation(),
    {
      provide: PlatformLocation,
      useFactory: () => {
        return inject(USE_PLATFORM_NAVIGATION)
          ? new FakeNavigationPlatformLocation()
          : new MockPlatformLocation();
      },
    },
    provideEnvironmentInitializer(() => {
      if (!inject(USE_PLATFORM_NAVIGATION)) {
        return;
      }
      const instance = inject(PlatformLocation);
      if (!(instance instanceof FakeNavigationPlatformLocation)) {
        throw new Error(
          `PlatformLocation was expected to be an instance that gets its information from 'PlatformNavigation' ` +
            `but got an instance of ${(instance as any).constructor.name} instead.`,
        );
      }
    }),
    {provide: TestComponentRenderer, useClass: DOMTestComponentRenderer},
  ],
})
export class BrowserTestingModule {}
