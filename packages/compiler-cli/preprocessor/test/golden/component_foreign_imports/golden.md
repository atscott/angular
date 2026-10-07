# /out/app.component.ts
```ts
…
    consts: [frameworkImport(FancyButton)],
    template: function AppComponent_Template(rf: number, ctx: any) {
      if (rf & 1) {
        i0.ɵɵforeignComponent(0, 0, () => ({ label: ctx.title }));
      }
    },
…
```