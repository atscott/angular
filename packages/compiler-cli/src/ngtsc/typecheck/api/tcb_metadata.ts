import ts from 'typescript';
import {
  DirectiveMeta,
  InputOutputPropertySet,
  LegacyAnimationTriggerNames,
  TmplAstNode,
  BoundTarget,
  SchemaMetadata,
} from '@angular/compiler';
import {TypeCheckId} from './api';
import {TemplateGuardMeta} from '../../metadata';
import {Reference} from '../../imports';

/**
 * A serializable representation of a directive for TCB generation, decoupled from `ts.Symbol`.
 * It relies on `ts.TypeNode` (for type positions) or string identifiers instead of mappings
 * back to the original source program.
 */
export interface TcbDirectiveMetadata extends DirectiveMeta {
  /** The name of the directive/component class. */
  name: string;
  /** The file path where this directive is defined. Used by the ImportManager. */
  moduleName: string;
  /** Whether this is a component. */
  isComponent: boolean;
  /** Whether the directive is generic. */
  isGeneric: boolean;
  /** Whether this directive is a standalone element. */
  isStandalone: boolean;
  /** Whether this directive is signal-based. */
  isSignal: boolean;
  /** The list of input mappings for this directive. */
  inputs: TcbPropertySet;
  /** The list of output mappings for this directive. */
  outputs: TcbPropertySet;
  /** The exportAs names for this directive. */
  exportAs: string[] | null;
  /** The selector of this directive. */
  selector: string | null;
  /** Whether this directive has an ngTemplateContextGuard. */
  hasNgTemplateContextGuard: boolean;
  /** Type parameters of the directive, if it's generic. */
  typeParameters: ts.TypeParameterDeclaration[] | undefined;
  /** The list of structural directives. */
  isStructural: boolean;
  /** The selectors of its `ng-content` elements. */
  ngContentSelectors: string[] | null;
  /** Whether the template of the component preserves whitespaces. */
  preserveWhitespaces: boolean;
  /** Legacy animations. */
  animationTriggerNames: LegacyAnimationTriggerNames | null;

  /** TCB specific structured inputs */
  tcbInputs: TcbInputMapping[];
  /** TCB specific structured outputs */
  tcbOutputs: TcbOutputMapping[];

  coercedInputFields: Set<string>;
  restrictedInputFields: Set<string>;
  stringLiteralInputFields: Set<string>;
  undeclaredInputFields: Set<string>;

  hasControlValueAccessorMethods: boolean;
  isExplicitlyDeferred: boolean;

  ngTemplateGuards: TemplateGuardMeta[];
  requiresInlineTcbConstructor: boolean;
}

export class TcbPropertySet implements InputOutputPropertySet {
  constructor(private bindingPropertyNames: Set<string>) {}
  hasBindingPropertyName(propertyName: string): boolean {
    return this.bindingPropertyNames.has(propertyName);
  }
  get propertyNames(): Iterable<string> {
    return this.bindingPropertyNames;
  }
}

export interface TcbInputMapping {
  /** The name of the input property on the class. */
  classPropertyName: string;
  /** The name of the binding in the template. */
  bindingPropertyName: string;
  /** Whether the input is required. */
  required: boolean;
  /** Whether the input is a signal binding. */
  isSignal: boolean;
  /** Type of the input explicitly represented as a ts.TypeNode, decoupled from the source declaration. */
  type: ts.TypeNode | undefined;
}

export interface TcbOutputMapping {
  /** The name of the output property on the class. */
  classPropertyName: string;
  /** The name of the binding in the template. */
  bindingPropertyName: string;
  /** Type of the output event explicitly represented as a ts.TypeNode. */
  type: ts.TypeNode | undefined;
}

export interface TcbPipeMetadata {
  /** The name of the pipe class. */
  name: string;
  /** The file path where this pipe is defined. */
  moduleName: string;
  /** The pipe name used in templates. */
  pipeName: string;
  /** Whether this pipe is standalone. */
  isStandalone: boolean;
  /** Whether the pipe is explicitly marked as defer-loadable */
  isExplicitlyDeferred: boolean;
  /** The type of the `transform` method of this pipe. */
  transformType: ts.TypeNode | undefined;
  /** Reference to the class declaration (legacy). */
  ref?: Reference<ts.Declaration>;
}

/**
 * A list of `TcbDirectiveMetadata` and `TcbPipeMetadata` available to a component.
 */
export interface TcbScope {
  directives: TcbDirectiveMetadata[];
  pipes: TcbPipeMetadata[];
}

/**
 * The detached metadata representing a Component that needs a TypeCheckBlock.
 * This structure should be serializable (with `ts.TypeNode` / `TmplAstNode` as the lowest denominator)
 * and contain everything needed to generate its TCB without a live TS Program.
 */
export interface TcbComponentMetadata {
  /** The name of the component class. */
  name: string;
  /** The absolute file path of the component. */
  moduleName: string;
  /** The parsed template AST of this component. */
  template: TmplAstNode[];
  /** The metadata of the component itself, represented as a directive. */
  component: TcbDirectiveMetadata;
  /** Whether to preserve whitespaces in the template. */
  preserveWhitespaces: boolean;
  /** The TcbScope containing all usable directives/pipes. */
  scope: TcbScope;

  boundTarget: BoundTarget<TcbDirectiveMetadata>;
  pipes: Map<string, TcbPipeMetadata> | null;
  schemas: SchemaMetadata[];
  isStandalone: boolean;
  id: TypeCheckId;
}
