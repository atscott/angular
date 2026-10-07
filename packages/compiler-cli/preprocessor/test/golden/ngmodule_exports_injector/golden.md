# /out/app.module.ts
```ts
import { Component, Directive, NgModule } from '@angular/core';
// @ts-ignore
import * as i0 from '@angular/core';

export class ImportedModule {
  // @ts-ignore
  static ɵfac: …
  // @ts-ignore
  static ɵmod: ImportedModule = /*@__PURE__*/ i0.ɵɵdefineNgModule({ type: ImportedModule });
  // @ts-ignore
  static ɵinj: i0.ɵɵInjectorDeclaration<ImportedModule> = /*@__PURE__*/ i0.ɵɵdefineInjector({});
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(ImportedModule, [{ type: NgModule, args: [{}] }], null, null);
  }
}
…
export class ExportedModule {
  // @ts-ignore
  static ɵfac: …
  // @ts-ignore
  static ɵmod: ExportedModule = /*@__PURE__*/ i0.ɵɵdefineNgModule({ type: ExportedModule });
  // @ts-ignore
  static ɵinj: i0.ɵɵInjectorDeclaration<ExportedModule> = /*@__PURE__*/ i0.ɵɵdefineInjector({});
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(ExportedModule, [{ type: NgModule, args: [{}] }], null, null);
  }
}
…
export class MyComponent {
  // @ts-ignore
  static ɵfac: …
  // @ts-ignore
  static ɵcmp: …
}
…
export class MyModule {
  // @ts-ignore
  static ɵfac: …
  // @ts-ignore
  static ɵmod: MyModule = /*@__PURE__*/ i0.ɵɵdefineNgModule({ type: MyModule });
  // @ts-ignore
  static ɵinj: i0.ɵɵInjectorDeclaration<MyModule> = /*@__PURE__*/ i0.ɵɵdefineInjector({
    imports: [ImportedModule, ExportedModule, MyComponent],
  });
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        MyModule,
        [
          {
            type: NgModule,
            args: [
              {
                imports: [ImportedModule],
                declarations: [MyComponent],
                exports: [ExportedModule, MyComponent],
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