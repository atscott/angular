# /out/app.component.ts
```ts
…
    template: function AppComponent_Template(rf: number, ctx: any) {
      if (rf & 1) {
        i0.ɵɵelementStart(0, 'div')(1, 'span');
        i0.ɵɵtext(2, 'hi');
        i0.ɵɵelementEnd()();
      }
    },
…
```