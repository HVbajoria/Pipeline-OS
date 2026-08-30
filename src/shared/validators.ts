/**
 * Shared field and JSON Schema validation for every PipelineOS operation.
 * The operation registry owns the schemas; this module only interprets them,
 * ensuring the server and WebMCP metadata cannot drift apart.
 */

import {
  ACTOR_TYPES,
  type ActorContext,
  type CompensationBand,
  type DateRange,
  type Timestamp
} from './models';
import {
  getOperationDescriptor,
  isOperationName,
  type JsonSchema,
  type JsonSchemaType,
  type OperationInputMap,
  type OperationName,
  type OperationOutputMap
} from './operations';
import {
  PipelineError,
  type PipelineErrorDetails,
  type PipelineValidationIssue,
  ValidationError
} from './errors';

export type ValidationIssue = PipelineValidationIssue;

const ISO_DATE_TIME =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function typeName(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

function matchesSchemaType(value: unknown, type: JsonSchemaType): boolean {
  switch (type) {
    case 'null':
      return value === null;
    case 'array':
      return Array.isArray(value);
    case 'object':
      return isPlainObject(value);
    case 'string':
      return typeof value === 'string';
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value);
    default:
      return false;
  }
}

function matchesDeclaredType(
  value: unknown,
  type: JsonSchema['type']
): boolean {
  if (type === undefined) return true;
  if (Array.isArray(type)) {
    return type.some((candidate) => matchesSchemaType(value, candidate));
  }
  return matchesSchemaType(value, type);
}

function addIssue(
  issues: ValidationIssue[],
  path: string,
  message: string,
  keyword?: string
): void {
  issues.push({ path, message, ...(keyword ? { keyword } : {}) });
}

function schemaIsValid(value: unknown, schema: JsonSchema): boolean {
  return validateJsonSchema(value, schema).length === 0;
}

/**
 * Validate an arbitrary JSON value against one of the shared descriptors.
 * This returns all issues instead of throwing so an operation can provide a
 * useful structured 400 response to callers.
 */
export function validateJsonSchema(
  value: unknown,
  schema: JsonSchema,
  path = 'input'
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  if (schema.const !== undefined && !Object.is(value, schema.const)) {
    addIssue(issues, path, `must equal ${JSON.stringify(schema.const)}`, 'const');
  }

  if (
    schema.enum !== undefined &&
    !schema.enum.some((allowedValue) => Object.is(value, allowedValue))
  ) {
    addIssue(issues, path, 'must be one of the declared enum values', 'enum');
  }

  if (schema.oneOf !== undefined) {
    const matchingSchemas = schema.oneOf.filter((candidate) =>
      schemaIsValid(value, candidate)
    ).length;
    if (matchingSchemas !== 1) {
      addIssue(issues, path, 'must match exactly one allowed shape', 'oneOf');
    }
  }

  if (schema.anyOf !== undefined) {
    const matchesAny = schema.anyOf.some((candidate) =>
      schemaIsValid(value, candidate)
    );
    if (!matchesAny) {
      addIssue(issues, path, 'must match one allowed shape', 'anyOf');
    }
  }

  if (schema.allOf !== undefined) {
    for (const candidate of schema.allOf) {
      issues.push(...validateJsonSchema(value, candidate, path));
    }
  }

  if (!matchesDeclaredType(value, schema.type)) {
    const expected = Array.isArray(schema.type)
      ? schema.type.join(' or ')
      : schema.type;
    addIssue(
      issues,
      path,
      `must be a ${expected}; received ${typeName(value)}`,
      'type'
    );
    // Nested constraints cannot produce useful additional diagnostics for a
    // value of the wrong type.
    return issues;
  }

  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) {
      addIssue(
        issues,
        path,
        `must contain at least ${schema.minLength} character(s)`,
        'minLength'
      );
    }
    if (
      schema.minLength !== undefined &&
      schema.minLength > 0 &&
      value.trim().length === 0
    ) {
      addIssue(issues, path, 'must not be empty', 'nonEmpty');
    }
    if (schema.maxLength !== undefined && value.length > schema.maxLength) {
      addIssue(
        issues,
        path,
        `must contain at most ${schema.maxLength} character(s)`,
        'maxLength'
      );
    }
    if (schema.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
      addIssue(issues, path, 'has an invalid format', 'pattern');
    }
    if (schema.format === 'date-time' && !isValidTimestamp(value)) {
      addIssue(issues, path, 'must be an ISO 8601 timestamp', 'format');
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) {
      addIssue(issues, path, `must be at least ${schema.minimum}`, 'minimum');
    }
    if (schema.maximum !== undefined && value > schema.maximum) {
      addIssue(issues, path, `must be at most ${schema.maximum}`, 'maximum');
    }
    if (
      schema.exclusiveMinimum !== undefined &&
      value <= schema.exclusiveMinimum
    ) {
      addIssue(
        issues,
        path,
        `must be greater than ${schema.exclusiveMinimum}`,
        'exclusiveMinimum'
      );
    }
    if (
      schema.exclusiveMaximum !== undefined &&
      value >= schema.exclusiveMaximum
    ) {
      addIssue(
        issues,
        path,
        `must be less than ${schema.exclusiveMaximum}`,
        'exclusiveMaximum'
      );
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) {
      addIssue(
        issues,
        path,
        `must contain at least ${schema.minItems} item(s)`,
        'minItems'
      );
    }
    if (schema.maxItems !== undefined && value.length > schema.maxItems) {
      addIssue(
        issues,
        path,
        `must contain at most ${schema.maxItems} item(s)`,
        'maxItems'
      );
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => {
        issues.push(
          ...validateJsonSchema(item, schema.items as JsonSchema, `${path}[${index}]`)
        );
      });
    }
  }

  if (isPlainObject(value)) {
    const properties = schema.properties ?? {};
    const required = schema.required ?? [];

    for (const requiredProperty of required) {
      if (!hasOwn(value, requiredProperty) || value[requiredProperty] === undefined) {
        addIssue(
          issues,
          `${path}.${requiredProperty}`,
          'is required',
          'required'
        );
      }
    }

    for (const [propertyName, propertySchema] of Object.entries(properties)) {
      if (hasOwn(value, propertyName) && value[propertyName] !== undefined) {
        issues.push(
          ...validateJsonSchema(
            value[propertyName],
            propertySchema,
            `${path}.${propertyName}`
          )
        );
      }
    }

    const knownProperties = new Set(Object.keys(properties));
    for (const [propertyName, propertyValue] of Object.entries(value)) {
      if (knownProperties.has(propertyName)) continue;
      if (schema.additionalProperties === false) {
        addIssue(
          issues,
          `${path}.${propertyName}`,
          'is not an allowed property',
          'additionalProperties'
        );
      } else if (isPlainObject(schema.additionalProperties)) {
        issues.push(
          ...validateJsonSchema(
            propertyValue,
            schema.additionalProperties,
            `${path}.${propertyName}`
          )
        );
      }
    }

    const propertyCount = Object.keys(value).length;
    if (
      schema.minProperties !== undefined &&
      propertyCount < schema.minProperties
    ) {
      addIssue(
        issues,
        path,
        `must contain at least ${schema.minProperties} propert(y|ies)`,
        'minProperties'
      );
    }
    if (
      schema.maxProperties !== undefined &&
      propertyCount > schema.maxProperties
    ) {
      addIssue(
        issues,
        path,
        `must contain at most ${schema.maxProperties} propert(y|ies)`,
        'maxProperties'
      );
    }
  }

  return issues;
}

/** Alias emphasizing that these descriptors are JSON Schema descriptors. */
export const validateAgainstSchema = validateJsonSchema;
export const collectValidationIssues = validateJsonSchema;

function detailsForIssues(issues: ValidationIssue[]): PipelineErrorDetails {
  return {
    field: issues[0]?.path,
    issues
  };
}

function throwValidationIssues(
  operationName: string,
  issues: ValidationIssue[]
): never {
  throw new ValidationError(
    `Invalid input for operation ${operationName}`,
    detailsForIssues(issues)
  );
}

function semanticInputIssues(
  name: OperationName,
  input: unknown
): ValidationIssue[] {
  if (!isPlainObject(input)) return [];

  if (name === 'create_job_requisition') {
    const compBand = input.compBand;
    if (isPlainObject(compBand)) {
      const min = compBand.min;
      const max = compBand.max;
      if (
        typeof min === 'number' &&
        Number.isFinite(min) &&
        typeof max === 'number' &&
        Number.isFinite(max) &&
        min > max
      ) {
        return [
          {
            path: 'input.compBand',
            message: 'min must be less than or equal to max',
            keyword: 'comparison'
          }
        ];
      }
    }
  }

  if (name === 'check_interviewer_availability') {
    const dateRange = input.dateRange;
    if (isPlainObject(dateRange)) {
      const start = dateRange.start;
      const end = dateRange.end;
      if (
        typeof start === 'string' &&
        typeof end === 'string' &&
        isValidTimestamp(start) &&
        isValidTimestamp(end) &&
        Date.parse(start) >= Date.parse(end)
      ) {
        return [
          {
            path: 'input.dateRange',
            message: 'start must be earlier than end',
            keyword: 'comparison'
          }
        ];
      }
    }
  }

  return [];
}

/** Validate and return the typed input for any canonical operation. */
export function validateOperationInput<N extends OperationName>(
  name: N,
  input: unknown
): OperationInputMap[N] {
  const descriptor = getOperationDescriptor(name);
  const issues = validateJsonSchema(input, descriptor.inputSchema);
  if (issues.length > 0) {
    throwValidationIssues(name, issues);
  }

  const semanticIssues = semanticInputIssues(name, input);
  if (semanticIssues.length > 0) {
    throwValidationIssues(name, semanticIssues);
  }

  return input as OperationInputMap[N];
}

/** Validate an operation name before looking it up in the registry. */
export function assertOperationName(value: unknown): asserts value is OperationName {
  if (!isOperationName(value)) {
    throw new ValidationError('Unknown operation name', {
      field: 'operationName'
    });
  }
}

/** Runtime-friendly overload for callers whose name is not yet narrowed. */
export function validateNamedOperationInput(
  name: unknown,
  input: unknown
): OperationInputMap[OperationName] {
  assertOperationName(name);
  return validateOperationInput(name, input);
}

/** Validate an operation output when an adapter wants a final contract check. */
export function validateOperationOutput<N extends OperationName>(
  name: N,
  output: unknown
): OperationOutputMap[N] {
  const descriptor = getOperationDescriptor(name);
  const issues = validateJsonSchema(output, descriptor.outputSchema, 'output');
  if (issues.length > 0) {
    throw new PipelineError(
      'INTERNAL_ERROR',
      `Operation ${name} produced an invalid output`,
      detailsForIssues(issues)
    );
  }
  return output as OperationOutputMap[N];
}

// ---------------------------------------------------------------------------
// Reusable field validators for operation handlers and domain services
// ---------------------------------------------------------------------------

export function assertString(value: unknown, field = 'value'): string {
  if (typeof value !== 'string') {
    throw new ValidationError(`${field} must be a string`, { field });
  }
  return value;
}

export function assertNonEmptyString(
  value: unknown,
  field = 'value'
): string {
  const stringValue = assertString(value, field);
  if (stringValue.trim().length === 0) {
    throw new ValidationError(`${field} must not be empty`, { field });
  }
  return stringValue;
}

export function assertFiniteNumber(value: unknown, field = 'value'): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${field} must be a finite number`, { field });
  }
  return value;
}

export function assertNonNegativeNumber(
  value: unknown,
  field = 'value'
): number {
  const numberValue = assertFiniteNumber(value, field);
  if (numberValue < 0) {
    throw new ValidationError(`${field} must be non-negative`, { field });
  }
  return numberValue;
}

export function assertNumberInRange(
  value: unknown,
  minimum: number,
  maximum: number,
  field = 'value'
): number {
  const numberValue = assertFiniteNumber(value, field);
  if (numberValue < minimum || numberValue > maximum) {
    throw new ValidationError(
      `${field} must be between ${minimum} and ${maximum}`,
      { field }
    );
  }
  return numberValue;
}

export function assertArray<T = unknown>(
  value: unknown,
  field = 'value'
): T[] {
  if (!Array.isArray(value)) {
    throw new ValidationError(`${field} must be an array`, { field });
  }
  return value as T[];
}

export function assertNonEmptyArray<T = unknown>(
  value: unknown,
  field = 'value'
): T[] {
  const arrayValue = assertArray<T>(value, field);
  if (arrayValue.length === 0) {
    throw new ValidationError(`${field} must not be empty`, { field });
  }
  return arrayValue;
}

export function assertPlainObject(
  value: unknown,
  field = 'value'
): Record<string, unknown> {
  if (!isPlainObject(value)) {
    throw new ValidationError(`${field} must be an object`, { field });
  }
  return value;
}

export function assertEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field = 'value'
): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new ValidationError(
      `${field} must be one of: ${allowed.join(', ')}`,
      { field }
    );
  }
  return value as T;
}

export function isValidTimestamp(value: unknown): value is Timestamp {
  return (
    typeof value === 'string' &&
    ISO_DATE_TIME.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

export function assertTimestamp(
  value: unknown,
  field = 'timestamp'
): Timestamp {
  if (!isValidTimestamp(value)) {
    throw new ValidationError(`${field} must be an ISO 8601 timestamp`, {
      field
    });
  }
  return value;
}

export function assertDateRange(
  value: unknown,
  field = 'dateRange'
): DateRange {
  const range = assertPlainObject(value, field);
  const start = assertTimestamp(range.start, `${field}.start`);
  const end = assertTimestamp(range.end, `${field}.end`);
  if (Date.parse(start) >= Date.parse(end)) {
    throw new ValidationError(`${field}.start must be earlier than ${field}.end`, {
      field
    });
  }
  return { start, end };
}

export function assertCompensationBand(
  value: unknown,
  field = 'compBand'
): CompensationBand {
  const band = assertPlainObject(value, field);
  const min = assertFiniteNumber(band.min, `${field}.min`);
  const max = assertFiniteNumber(band.max, `${field}.max`);
  const currency = assertNonEmptyString(band.currency, `${field}.currency`);
  if (min > max) {
    throw new ValidationError(`${field}.min must be less than or equal to ${field}.max`, {
      field
    });
  }
  return { min, max, currency };
}

export function assertActorContext(value: unknown): ActorContext {
  const context = assertPlainObject(value, 'actor');
  const actorType = assertEnum(context.actorType, ACTOR_TYPES, 'actor.actorType');
  const actorId = assertNonEmptyString(context.actorId, 'actor.actorId');
  return { actorType, actorId };
}

export function assertRecordId(value: unknown, field = 'id'): string {
  return assertNonEmptyString(value, field);
}

// Conventional aliases for operation handlers that prefer validate* naming.
export const validateString = assertString;
export const validateNonEmptyString = assertNonEmptyString;
export const validateFiniteNumber = assertFiniteNumber;
export const validateNonNegativeNumber = assertNonNegativeNumber;
export const validateEnum = assertEnum;
export const validateTimestamp = assertTimestamp;
export const validateDateRange = assertDateRange;
export const validateCompensationBand = assertCompensationBand;
export const validateActorContext = assertActorContext;
