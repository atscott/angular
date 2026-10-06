# /out/app.component.ngtypecheck.ts
```ts
…

```

# /out/app.component.ts
```ts
…

```

# /out/app.module.ts
```ts
import { NgModule } from '@angular/core';
import { AppComponent } from './app.component';
import { featureStoreModule } from './store';
// @ts-ignore
import * as i0 from '@angular/core';
// @ts-ignore
import * as i1 from '@ngrx/store';

export class AppModule {
  …
  static ɵmod: i0.ɵɵNgModuleDeclaration<
    AppModule,
    [typeof AppComponent],
    [typeof i1.StoreFeatureModule],
    never
  > = /*@__PURE__*/ i0.ɵɵdefineNgModule({ type: AppModule });
  // @ts-ignore
  static ɵinj: i0.ɵɵInjectorDeclaration<AppModule> = /*@__PURE__*/ i0.ɵɵdefineInjector({
    imports: [featureStoreModule],
  });
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        AppModule,
        [
          {
            type: NgModule,
            args: [
              {
                declarations: [AppComponent],
                imports: [featureStoreModule],
              },
            ],
          },
        ],
        null,
        null,
      );
  }
}
(function () {
  (typeof ngJitMode === 'undefined' || ngJitMode) &&
    i0.ɵɵsetNgModuleScope(AppModule, {
      declarations: [AppComponent],
      imports: [i1.StoreFeatureModule],
    });
})();
…

```