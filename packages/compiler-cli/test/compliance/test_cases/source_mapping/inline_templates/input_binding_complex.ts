import {Component, Directive, Input, NgModule} from '@angular/core';

@Directive({selector: 'div'})
export class DivDir {
  @Input() attr!: any;
}

@Component({
  selector: 'test-cmp',
  template: '<div [attr]="greeting + name"></div>',
})
export class TestCmp {
  greeting = '';
  name = '';
}

@NgModule({declarations: [DivDir, TestCmp]})
export class MyMod {
}
