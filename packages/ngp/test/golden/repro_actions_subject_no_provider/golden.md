# /out/app.component.ts
```ts
import { Component } from '@angular/core';
import { ActionsSubject } from '@ngrx/store';
// @ts-ignore
import * as i0 from '@angular/core';

export class AppComponent {
  …
  static ɵfac: i0.ɵɵFactoryDeclaration<AppComponent, never> = function AppComponent_Factory(
    __ngFactoryType__: any,
  ) {
    /* @ts-ignore */
    return new (__ngFactoryType__ || AppComponent)(i0.ɵɵdirectiveInject(ActionsSubject));
  };
  …
}
…

```

# /out/app.module.ts
```ts
import { NgModule } from '@angular/core';
import { AppComponent } from './app.component';
import { featureStoreModule } from './store';
// @ts-ignore
import * as i0 from '@angular/core';

export class AppModule {
  …
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
…

```