import {Component, Injectable, Optional} from '@angular/core';
import * as i0 from '@angular/core';
export class AppModule {
  thing = 'world';
  constructor(abc: MyService | null) {
    console.log('AppModule init');
  }
  static ɵfac: i0.ɵɵFactoryDeclaration<
    AppModule,
    [
      {
        optional: true;
      },
    ]
  > = function AppModule_Factory(__ngFactoryType__: any) {
    return new (__ngFactoryType__ || AppModule)(i0.ɵɵdirectiveInject(MyService, 8));
  };
  static ɵcmp: i0.ɵɵComponentDeclaration<
    AppModule,
    'app-root',
    never,
    {},
    {},
    never,
    never,
    true,
    never
  > = /*@__PURE__*/ i0.ɵɵdefineComponent({
    type: AppModule,
    selectors: [['app-root']],
    decls: 3,
    vars: 1,
    template: function AppModule_Template(rf: any, ctx: any) {
      if (rf & 1) {
        i0.ɵɵdomElementStart(0, 'h1');
        i0.ɵɵtext(1, 'Hello');
        i0.ɵɵdomElementEnd();
        i0.ɵɵtext(2);
      }
      if (rf & 2) {
        i0.ɵɵadvance(2);
        i0.ɵɵtextInterpolate(ctx.thing);
      }
    },
    encapsulation: 2,
  });
}
(() => {
  (typeof ngDevMode === 'undefined' || ngDevMode) &&
    i0.ɵsetClassMetadata(
      AppModule,
      [
        {
          type: Component,
          args: [
            {
              selector: 'app-root',
              template: '<h1>Hello</h1>{{thing}}',
            },
          ],
        },
      ],
      () => [
        {
          type: MyService,
          decorators: [
            {
              type: Optional,
            },
          ],
        },
      ],
      null,
    );
})();
(() => {
  (typeof ngDevMode === 'undefined' || ngDevMode) &&
    i0.ɵsetClassDebugInfo(AppModule, {
      className: 'AppModule',
      filePath: 'src/main.ts',
      lineNumber: 7,
    });
})();
export class MyService {
  static ɵfac: i0.ɵɵFactoryDeclaration<MyService, never> = function MyService_Factory(
    __ngFactoryType__: any,
  ) {
    return new (__ngFactoryType__ || MyService)();
  };
  static ɵprov: i0.ɵɵInjectableDeclaration<MyService> = /*@__PURE__*/ i0.ɵɵdefineInjectable({
    token: MyService,
    factory: MyService.ɵfac,
  }) as any;
}
(() => {
  (typeof ngDevMode === 'undefined' || ngDevMode) &&
    i0.ɵsetClassMetadata(
      MyService,
      [
        {
          type: Injectable,
        },
      ],
      null,
      null,
    );
})();
