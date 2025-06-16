/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */
import {inject, Injectable} from '@angular/core';
import {expect} from '@angular/private/testing/matchers';
import {Location} from '@angular/common';
import {TestBed} from '@angular/core/testing';
import {
  Router,
  NavigationStart,
  NavigationError,
  RoutesRecognized,
  GuardsCheckStart,
  Event,
  ChildActivationStart,
  ActivationStart,
  GuardsCheckEnd,
  ResolveStart,
  ResolveEnd,
  ActivationEnd,
  ChildActivationEnd,
  NavigationEnd,
  provideRouter,
  withRouterConfig,
  withNavigationErrorHandler,
  RouterModule,
  RedirectCommand,
  NavigationCancel,
  NavigationCancellationCode,
} from '../../src';
import {RouterTestingHarness} from '../../testing';
import {
  RootCmp,
  BlankCmp,
  UserCmp,
  expectEvents,
  SimpleCmp,
  ThrowingCmp,
  ConditionalThrowingCmp,
  EmptyQueryParamsCmp,
  createRoot,
  advance,
  simulateLocationChange,
} from './integration_helpers';
import {timeout} from '../helpers';

export function navigationErrorsIntegrationSuite(browserAPI: 'navigation' | 'history') {
  it('should handle failed navigations gracefully', async () => {
    const router = TestBed.inject(Router);
    const fixture = await createRoot(router, RootCmp);

    router.resetConfig([{path: 'user/:name', component: UserCmp}]);

    const recordedEvents: Event[] = [];
    router.events.forEach((e) => recordedEvents.push(e));

    let e: any;
    router.navigateByUrl('/invalid').catch((_) => (e = _));
    await advance(fixture);
    expect(e.message).toContain('Cannot match any routes');

    router.navigateByUrl('/user/fedor');
    await advance(fixture);

    expect(fixture.nativeElement).toHaveText('user fedor');

    expectEvents(recordedEvents, [
      [NavigationStart, '/invalid'],
      [NavigationError, '/invalid'],

      [NavigationStart, '/user/fedor'],
      [RoutesRecognized, '/user/fedor'],
      [GuardsCheckStart, '/user/fedor'],
      [ChildActivationStart],
      [ActivationStart],
      [GuardsCheckEnd, '/user/fedor'],
      [ResolveStart, '/user/fedor'],
      [ResolveEnd, '/user/fedor'],
      [ActivationEnd],
      [ChildActivationEnd],
      [NavigationEnd, '/user/fedor'],
    ]);
  });

  it('should be able to provide an error handler with DI dependencies', async () => {
    @Injectable({providedIn: 'root'})
    class Handler {
      handlerCalled = false;
    }
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            {
              path: 'throw',
              canMatch: [
                () => {
                  throw new Error('');
                },
              ],
              component: BlankCmp,
            },
          ],
          withRouterConfig({resolveNavigationPromiseOnError: true}),
          withNavigationErrorHandler(() => (inject(Handler).handlerCalled = true)),
        ),
      ],
    });
    const router = TestBed.inject(Router);
    await router.navigateByUrl('/throw');
    expect(TestBed.inject(Handler).handlerCalled).toBeTrue();
  });

  it('can redirect from error handler with RouterModule.forRoot', async () => {
    TestBed.configureTestingModule({
      imports: [
        RouterModule.forRoot(
          [
            {
              path: 'throw',
              canMatch: [
                () => {
                  throw new Error('');
                },
              ],
              component: BlankCmp,
            },
            {path: 'error', component: BlankCmp},
          ],
          {
            resolveNavigationPromiseOnError: true,
            errorHandler: () => new RedirectCommand(inject(Router).parseUrl('/error')),
          },
        ),
      ],
    });
    const router = TestBed.inject(Router);
    let emitNavigationError = false;
    let emitNavigationCancelWithRedirect = false;
    router.events.subscribe((e) => {
      if (e instanceof NavigationError) {
        emitNavigationError = true;
      }
      if (e instanceof NavigationCancel && e.code === NavigationCancellationCode.Redirect) {
        emitNavigationCancelWithRedirect = true;
      }
    });
    await router.navigateByUrl('/throw');
    expect(router.url).toEqual('/error');
    expect(emitNavigationError).toBe(false);
    expect(emitNavigationCancelWithRedirect).toBe(true);
  });

  it('can redirect from error handler', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            {
              path: 'throw',
              canMatch: [
                () => {
                  throw new Error('');
                },
              ],
              component: BlankCmp,
            },
            {path: 'error', component: BlankCmp},
          ],
          withRouterConfig({resolveNavigationPromiseOnError: true}),
          withNavigationErrorHandler(() => new RedirectCommand(inject(Router).parseUrl('/error'))),
        ),
      ],
    });
    const router = TestBed.inject(Router);
    let emitNavigationError = false;
    let emitNavigationCancelWithRedirect = false;
    router.events.subscribe((e) => {
      if (e instanceof NavigationError) {
        emitNavigationError = true;
      }
      if (e instanceof NavigationCancel && e.code === NavigationCancellationCode.Redirect) {
        emitNavigationCancelWithRedirect = true;
      }
    });
    await router.navigateByUrl('/throw');
    expect(router.url).toEqual('/error');
    expect(emitNavigationError).toBe(false);
    expect(emitNavigationCancelWithRedirect).toBe(true);
  });

  it('should not break navigation if an error happens in NavigationErrorHandler', async () => {
    TestBed.configureTestingModule({
      providers: [
        provideRouter(
          [
            {
              path: 'throw',
              canMatch: [
                () => {
                  throw new Error('');
                },
              ],
              component: BlankCmp,
            },
            {path: '**', component: BlankCmp},
          ],
          withRouterConfig({resolveNavigationPromiseOnError: true}),
          withNavigationErrorHandler(() => {
            throw new Error('e');
          }),
        ),
      ],
    });
    const router = TestBed.inject(Router);
  });

  // Errors should behave the same for both deferred and eager URL update strategies
  (['deferred', 'eager'] as const).forEach((urlUpdateStrategy) => {
    it('should dispatch NavigationError after the url has been reset back', async () => {
      if (browserAPI === 'navigation') {
        // This doesn't work with navigation API because navigation & events for rollback are not synchronous
        // Rollback cannot be complete before NavigationError unless we delay the emit
        return;
      }
      TestBed.configureTestingModule({
        providers: [provideRouter([], withRouterConfig({urlUpdateStrategy}))],
      });
      const router = TestBed.inject(Router);
      const location = TestBed.inject(Location);
      const fixture = await createRoot(router, RootCmp);

      router.resetConfig([
        {path: 'simple', component: SimpleCmp},
        {path: 'throwing', component: ThrowingCmp},
      ]);

      router.navigateByUrl('/simple');
      await advance(fixture);

      let routerUrlBeforeEmittingError = '';
      let locationUrlBeforeEmittingError = '';
      router.events.forEach((e) => {
        if (e instanceof NavigationError) {
          routerUrlBeforeEmittingError = router.url;
          locationUrlBeforeEmittingError = location.path();
        }
      });
      router.navigateByUrl('/throwing').catch(() => null);
      await advance(fixture);

      expect(routerUrlBeforeEmittingError).toEqual('/simple');
      expect(locationUrlBeforeEmittingError).toEqual('/simple');
    });

    it('can renavigate to throwing component', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter([], withRouterConfig({urlUpdateStrategy: 'eager'}))],
      });
      const router = TestBed.inject(Router);
      const location = TestBed.inject(Location);
      router.resetConfig([
        {path: '', component: BlankCmp},
        {path: 'throwing', component: ConditionalThrowingCmp},
      ]);
      const fixture = await createRoot(router, RootCmp);

      // Try navigating to a component which throws an error during activation.
      ConditionalThrowingCmp.throwError = true;
      await expectAsync(router.navigateByUrl('/throwing')).toBeRejected();
      await advance(fixture); // have to commit the rollback - Navigation API events to not happen synchronously (https://github.com/WICG/navigation-api/issues/288#issue-3002669948)
      expect(location.path()).toEqual('');
      expect(fixture.nativeElement.innerHTML).not.toContain('throwing');

      // Ensure we can re-navigate to that same URL and succeed.
      ConditionalThrowingCmp.throwError = false;
      router.navigateByUrl('/throwing');
      await advance(fixture);
      expect(location.path()).toEqual('/throwing');
      expect(fixture.nativeElement.innerHTML).toContain('throwing');
    }, 1000000);

    it('should reset the url with the right state when navigation errors', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter([], withRouterConfig({urlUpdateStrategy}))],
      });
      const router = TestBed.inject(Router);
      const location = TestBed.inject(Location);
      const fixture = await createRoot(router, RootCmp);

      router.resetConfig([
        {path: 'simple1', component: SimpleCmp},
        {path: 'simple2', component: SimpleCmp},
        {path: 'throwing', component: ThrowingCmp},
      ]);

      let event: NavigationStart;
      router.events.subscribe((e) => {
        if (e instanceof NavigationStart) {
          event = e;
        }
      });

      await router.navigateByUrl('/simple1');
      await timeout(2);
      const simple1NavStart = event!;

      await router.navigateByUrl('/throwing').catch(() => null);
      await timeout(2);

      await router.navigateByUrl('/simple2');
      await timeout(2);

      location.back();
      await timeout(2);

      expect(event!.restoredState!.navigationId).toEqual(simple1NavStart.id);
    });

    it('should not trigger another navigation when resetting the url back due to a NavigationError', async () => {
      TestBed.configureTestingModule({
        providers: [provideRouter([], withRouterConfig({urlUpdateStrategy}))],
      });
      const router = TestBed.inject(Router);
      router.onSameUrlNavigation = 'reload';

      const fixture = await createRoot(router, RootCmp);

      router.resetConfig([
        {path: 'simple', component: SimpleCmp},
        {path: 'throwing', component: ThrowingCmp},
      ]);

      const events: any[] = [];
      router.events.forEach((e: any) => {
        if (e instanceof NavigationStart) {
          events.push(e.url);
        }
      });

      router.navigateByUrl('/simple');
      await advance(fixture);

      router.navigateByUrl('/throwing').catch(() => null);
      await advance(fixture);

      // we do not trigger another navigation to /simple
      expect(events).toEqual(['/simple', '/throwing']);
    });
  });

  it('should dispatch NavigationCancel after the url has been reset back', async () => {
    const router = TestBed.inject(Router);
    const location = TestBed.inject(Location);

    const fixture = await createRoot(router, RootCmp);

    router.resetConfig([
      {path: 'simple', component: SimpleCmp},
      {
        path: 'throwing',
        loadChildren: jasmine.createSpy('doesnotmatter'),
        canLoad: [() => false],
      },
    ]);

    router.navigateByUrl('/simple');
    await advance(fixture);

    let routerUrlBeforeEmittingError = '';
    let locationUrlBeforeEmittingError = '';
    router.events.forEach((e) => {
      if (e instanceof NavigationCancel) {
        expect(e.code).toBe(NavigationCancellationCode.GuardRejected);
        routerUrlBeforeEmittingError = router.url;
        locationUrlBeforeEmittingError = location.path();
      }
    });

    simulateLocationChange('/throwing', browserAPI);
    await advance(fixture);

    expect(routerUrlBeforeEmittingError).toEqual('/simple');
    expect(locationUrlBeforeEmittingError).toEqual('/simple');
  });

  it('should recover from malformed uri errors', async () => {
    const router = TestBed.inject(Router);
    const location = TestBed.inject(Location);
    router.resetConfig([{path: 'simple', component: SimpleCmp}]);
    const fixture = await createRoot(router, RootCmp);
    router.navigateByUrl('/invalid/url%with%percent');
    await advance(fixture);
    expect(location.path()).toEqual('');
  });

  it('should not swallow errors', async () => {
    const router = TestBed.inject(Router);
    const fixture = await createRoot(router, RootCmp);

    router.resetConfig([{path: 'simple', component: SimpleCmp}]);

    await expectAsync(router.navigateByUrl('/invalid')).toBeRejected();

    await expectAsync(router.navigateByUrl('/invalid2')).toBeRejected();
  });

  it('should not swallow errors from browser state update', async () => {
    if (browserAPI === 'navigation') {
      // Router interfaces with the browser APIs at different times. We cannot use the same test for this because the events will be different.
      return;
    }
    const routerEvents: Event[] = [];
    TestBed.inject(Router).resetConfig([{path: '**', component: BlankCmp}]);
    TestBed.inject(Router).events.subscribe((e) => {
      routerEvents.push(e);
    });
    spyOn(TestBed.inject(Location), 'go').and.callFake(() => {
      throw new Error();
    });
    try {
      await RouterTestingHarness.create('/abc123');
    } catch {}
    // Ensure the first event is the start and that we get to the ResolveEnd event. If this is not
    // true, then NavigationError may have been triggered at a time we don't expect here.
    expect(routerEvents[0]).toBeInstanceOf(NavigationStart);
    expect(routerEvents[routerEvents.length - 2]).toBeInstanceOf(ResolveEnd);

    expect(routerEvents[routerEvents.length - 1]).toBeInstanceOf(NavigationError);
  });

  it('should throw an error when one of the commands is null/undefined', async () => {
    const router = TestBed.inject(Router);
    await createRoot(router, RootCmp);

    router.resetConfig([{path: 'query', component: EmptyQueryParamsCmp}]);

    expect(() => router.navigate([undefined, 'query'])).toThrowError(
      /The requested path contains undefined segment at index 0/,
    );
  });
}
