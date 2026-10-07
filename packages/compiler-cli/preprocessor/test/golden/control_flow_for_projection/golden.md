# /out/app.component.ts
```ts
import { Component } from '@angular/core';
// @ts-ignore
import * as i0 from '@angular/core';

const _c0 = ['*', [['', 'foo', '']]];
const _c1 = ['*', '[foo]'];

export class TestComponent {
  …
    ngContentSelectors: _c1,
    decls: 4,
    vars: 0,
    template: function TestComponent_Template(rf: number, ctx: any) {
      if (rf & 1) {
        i0.ɵɵprojectionDef(_c0);
        i0.ɵɵtext(0, 'Main: ');
        i0.ɵɵprojection(1);
        i0.ɵɵtext(2, ' Slot: ');
        i0.ɵɵprojection(3, 1);
      }
    },
    …
  });
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        TestComponent,
        [
          {
            type: Component,
            args: [
              {
                selector: 'test',
                template: 'Main: <ng-content/> Slot: <ng-content select="[foo]"/>',
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

function AppComponent_For_3_Template(rf: number, ctx: any) {
  if (rf & 1) {
    i0.ɵɵelementStart(0, 'span', 0);
    i0.ɵɵtext(1);
    i0.ɵɵelementEnd();
  }
  if (rf & 2) {
    const item_r1: any = ctx.$implicit;
    i0.ɵɵadvance();
    i0.ɵɵtextInterpolate(item_r1);
  }
}

export class AppComponent {
  …
    decls: 5,
    vars: 0,
    consts: [['foo', '']],
    template: function AppComponent_Template(rf: number, ctx: any) {
      if (rf & 1) {
        i0.ɵɵelementStart(0, 'test');
        i0.ɵɵtext(1, 'Before ');
        i0.ɵɵrepeaterCreate(
          2,
          AppComponent_For_3_Template,
          2,
          1,
          'span',
          0,
          i0.ɵɵrepeaterTrackByIndex,
        );
        i0.ɵɵtext(4, ' After');
        i0.ɵɵelementEnd();
      }
      if (rf & 2) {
        i0.ɵɵadvance(2);
        i0.ɵɵrepeater(ctx.items);
      }
    },
    …
  });
  static {
    (typeof ngDevMode === 'undefined' || ngDevMode) &&
      i0.ɵsetClassMetadata(
        AppComponent,
        [
          {
            type: Component,
            args: [
              {
                selector: 'app-root',
                imports: [TestComponent],
                template: `<test>Before @for (item of items; track $index) { <span foo>{{ item }}</span> } After</test>`,
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