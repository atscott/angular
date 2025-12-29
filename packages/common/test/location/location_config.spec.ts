import {Location, LocationStrategy, REMOVE_TRAILING_SLASH} from '@angular/common';
import {TestBed} from '@angular/core/testing';
import {MockLocationStrategy} from '@angular/common/testing';

describe('Location Trailing Slash Config', () => {
  it('should strip trailing slash by default', () => {
    TestBed.configureTestingModule({
      providers: [Location, {provide: LocationStrategy, useClass: MockLocationStrategy}],
    });
    const location = TestBed.inject(Location);
    expect(location.normalize('/a/b/')).toBe('/a/b');
  });

  it('should preserve trailing slash when REMOVE_TRAILING_SLASH is false', () => {
    TestBed.configureTestingModule({
      providers: [
        Location,
        {provide: LocationStrategy, useClass: MockLocationStrategy},
        {provide: REMOVE_TRAILING_SLASH, useValue: false},
      ],
    });
    const location = TestBed.inject(Location);
    expect(location.normalize('/a/b/')).toBe('/a/b/');
  });
});
