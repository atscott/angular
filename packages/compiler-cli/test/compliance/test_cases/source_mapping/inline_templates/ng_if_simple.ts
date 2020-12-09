import {Component, Directive, Input, NgModule, TemplateRef, ViewContainerRef} from '@angular/core';

interface NgIfContext<T> {}

@Directive({selector: '[ngIf]'})
export class NgIf<T = unknown> {
  constructor(private _viewContainer: ViewContainerRef, templateRef: TemplateRef<NgIfContext<T>>) {}
  @Input()
  set ngIf(condition: T) {
  }
  @Input()
  set ngIfThen(templateRef: TemplateRef<NgIfContext<T>>|null) {
  }
  @Input()
  set ngIfElse(templateRef: TemplateRef<NgIfContext<T>>|null) {
  }

  public static ngIfUseIfTypeGuard: void;
  static ngTemplateGuard_ngIf: 'binding';
  static ngTemplateContextGuard<T>(dir: NgIf<T>, ctx: any):
      ctx is NgIfContext<Exclude<T, false|0|''|null|undefined>> {
    return true;
  }
}

@Component({
  selector: 'test-cmp',
  template: '<div *ngIf="showMessage()">{{ name }}</div>',
})
export class TestCmp {
  name = '';
  showMessage() {}
}

@NgModule({declarations: [TestCmp, NgIf]})
export class MyMod {
}
