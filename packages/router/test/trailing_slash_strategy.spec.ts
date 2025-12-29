import {Location, LocationStrategy, REMOVE_TRAILING_SLASH} from '@angular/common';
import {TestBed} from '@angular/core/testing';
import {MockLocationStrategy} from '@angular/common/testing';
import {
  DefaultUrlSerializer,
  ROUTER_CONFIGURATION,
  RouterConfigOptions,
  UrlSerializer,
  UrlTree,
} from '@angular/router';

describe('Trailing Slash Strategy Config', () => {
  function setup(trailingSlash: RouterConfigOptions['trailingSlash']) {
    TestBed.configureTestingModule({
      providers: [
        Location,
        {provide: LocationStrategy, useClass: MockLocationStrategy},
        {provide: ROUTER_CONFIGURATION, useValue: {trailingSlash}},
        {
          provide: REMOVE_TRAILING_SLASH,
          useValue: trailingSlash !== 'always' && trailingSlash !== 'preserve',
        },
        {
          provide: UrlSerializer,
          useFactory: () => new DefaultUrlSerializer(trailingSlash),
        },
      ],
    });
    return {
      location: TestBed.inject(Location),
      serializer: TestBed.inject(UrlSerializer),
    };
  }

  it('should force slash when strategy is "always"', () => {
    const {location, serializer} = setup('always');
    // Location should preserve
    expect(location.normalize('/a/b/')).toBe('/a/b/');
    expect(location.normalize('/a/b')).toBe('/a/b'); // Location normalize only strips, doesn't add unless we changed that?
    // Wait, Location.normalize strips if REMOVE_TRAILING_SLASH is true.
    // If REMOVE_TRAILING_SLASH is false, it returns as is.

    const tree = serializer.parse('/a/b');
    expect(tree.hasTrailingSlash).toBe(true);
    expect(serializer.serialize(tree)).toBe('/a/b/');
  });

  it('should force remove slash when strategy is "never"', () => {
    const {location, serializer} = setup('never');
    // Location should strip
    expect(location.normalize('/a/b/')).toBe('/a/b');

    const tree = serializer.parse('/a/b/');
    expect(tree.hasTrailingSlash).toBe(false);
    expect(serializer.serialize(tree)).toBe('/a/b');
  });

  it('should preserve slash when strategy is "preserve"', () => {
    const {location, serializer} = setup('preserve');
    // Location should preserve
    expect(location.normalize('/a/b/')).toBe('/a/b/');

    const treeWith = serializer.parse('/a/b/');
    expect(treeWith.hasTrailingSlash).toBe(true);
    expect(serializer.serialize(treeWith)).toBe('/a/b/');

    const treeWithout = serializer.parse('/a/b');
    expect(treeWithout.hasTrailingSlash).toBe(false);
    expect(serializer.serialize(treeWithout)).toBe('/a/b');
  });
});
