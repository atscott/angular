import {Component, Directive, Input, NgModule} from '@angular/core';

@Directive({selector: '[ngModel]'})
export class NgModelDir {
  @Input() ngModel!: any;
}

@Component({
  selector: 'test-cmp',
  template: 'Name: <input bindon-ngModel="name">',
})
export class TestCmp {
  name = '';
}

@NgModule({declarations: [NgModelDir, TestCmp]})
export class MyMod {
}
